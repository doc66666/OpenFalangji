#!/usr/bin/env node
"use strict";

/**
 * Master — 中心化管控应用（最小实现）
 *
 * 当前能力：
 * - AgentHost 注册 / 心跳 / 注销
 * - 在线 Agent 列表
 * - 邻居发现：向 Master 查询“我该认识谁”
 *
 * 设计原则：
 * - Master 只做控制面和目录，不中转业务消息（P2P 直连由 AgentHost 自己完成）
 * - 不依赖第三方包，使用 Node 内置 http
 * - 内存态注册表，后续可替换为持久化存储
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const DEFAULT_PORT = 9300;
const ONLINE_TIMEOUT_MS = 15 * 1000;
const HEARTBEAT_PRUNE_INTERVAL_MS = 10 * 1000;
const TASK_FAILURE_LIMIT = 3;

class Master {
  constructor(opts = {}) {
    this.port = opts.port || DEFAULT_PORT;
    this.onlineTimeoutMs = opts.onlineTimeoutMs || ONLINE_TIMEOUT_MS;
    this.agents = new Map(); // agent_id -> AgentRecord
    this.permissions = new Map(); // agent_id -> { allow_all, allowed_hosts } (survives unregister)
    this.registrations = new Map(); // registration_id -> RegistrationRecord
    this.tasks = new Map(); // task_id -> TaskRecord (global task index)
    this.deadTasks = new Set(); // terminal/dirty task IDs, synced to hosts via heartbeat
    this.hostFailures = new Map(); // agent_id -> consecutive failure count
    this.taskFailureLimit = opts.taskFailureLimit || TASK_FAILURE_LIMIT;
    this.leaderAgentId = opts.leaderAgentId || null;
    this.dataFile = opts.dataFile || path.join(__dirname, "..", ".data", "master-state.json");
    this.persistTimer = null;
    this.server = null;
    this.pruneTimer = null;
    this._loadState();
  }

  _loadState() {
    try {
      if (!fs.existsSync(this.dataFile)) return;
      const state = JSON.parse(fs.readFileSync(this.dataFile, "utf8"));
      this.permissions = new Map(state.permissions || []);
      this.registrations = new Map(state.registrations || []);
      this.tasks = new Map(state.tasks || []);
      this.deadTasks = new Set(state.dead_tasks || []);
      this.hostFailures = new Map(state.host_failures || []);
      this.leaderAgentId = state.leader_agent_id || null;
      this.agents = new Map((state.agents || []).map(([id, agent]) => [id, {
        ...agent,
        last_seen_ms: 0,
        status: "offline",
        agent_alive: false,
      }]));
    } catch (err) {
      console.warn(`[Master] failed to restore state: ${err.message}`);
    }
  }

  _schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this._persistState();
    }, 100);
    this.persistTimer.unref?.();
  }

  _persistState() {
    try {
      const state = {
        version: 1,
        agents: Array.from(this.agents.entries()),
        permissions: Array.from(this.permissions.entries()),
        registrations: Array.from(this.registrations.entries()),
        tasks: Array.from(this.tasks.entries()),
        dead_tasks: Array.from(this.deadTasks),
        host_failures: Array.from(this.hostFailures.entries()),
        leader_agent_id: this.leaderAgentId,
        saved_at: new Date().toISOString(),
      };
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      const temp = `${this.dataFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(temp, this.dataFile);
    } catch (err) {
      console.warn(`[Master] state persistence failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------
  // Registry operations
  // ---------------------------------------------------------------

  _normalizeAgent(body = {}, now = new Date()) {
    const agentId = String(body.agent_id || body.id || "").trim();
    if (!agentId) return null;
    const baseUrl = String(body.base_url || "").trim().replace(/\/+$/, "");
    if (!baseUrl) return null;

    const existing = this.agents.get(agentId);
    const registeredAt = existing?.registered_at || now.toISOString();
    const permissions = this.permissions.get(agentId) || { allow_all: true, allowed_hosts: [] };

    return {
      agent_id: agentId,
      base_url: baseUrl,
      mode: body.mode || existing?.mode || "minimal",
      max_hops: Number.isInteger(body.max_hops) ? body.max_hops : existing?.max_hops ?? 5,
      max_rounds: Number.isInteger(body.max_rounds) ? body.max_rounds : existing?.max_rounds ?? 10,
      timeout_ms: Number.isInteger(body.timeout_ms) ? body.timeout_ms : existing?.timeout_ms ?? 0,
      description: body.description || existing?.description || "",
      capabilities: Array.isArray(body.capabilities)
        ? body.capabilities.map(String)
        : existing?.capabilities || [],
      command: body.command || existing?.command || null,
      cwd: body.cwd || existing?.cwd || null,
      completion_provider: body.completion_provider || existing?.completion_provider || null,
      platform: body.platform || existing?.platform || process.platform,
      port: body.port || existing?.port || null,
      status: body.status || "online",
      offline_handled: false,
      agent_alive:
        body.agent_alive === undefined
          ? existing?.agent_alive ?? null
          : Boolean(body.agent_alive),
      permissions,
      registered_at: registeredAt,
      last_seen: now.toISOString(),
      last_seen_ms: now.getTime(),
    };
  }

  setPermissions(agentId, { allow_all, allowed_hosts }) {
    const existing = this.agents.get(agentId);
    if (!existing) return null;
    const permissions = {
      allow_all: allow_all !== false,
      allowed_hosts: Array.isArray(allowed_hosts)
        ? allowed_hosts.filter((x) => x && x !== agentId)
        : [],
    };
    this.permissions.set(agentId, permissions);
    existing.permissions = permissions;
    this._schedulePersist();
    return this._publicAgent(existing);
  }

  setLeader(agentId) {
    if (!this.agents.has(agentId)) return null;
    this.leaderAgentId = agentId;
    this._schedulePersist();
    return { agent_id: agentId, is_leader: true };
  }

  getLeader() {
    if (!this.leaderAgentId) return null;
    const record = this.agents.get(this.leaderAgentId);
    if (!record) return null;
    return this._publicAgent(record);
  }

  clearLeader() {
    const previous = this.leaderAgentId;
    this.leaderAgentId = null;
    this._schedulePersist();
    return { agent_id: previous, is_leader: false };
  }

  // ---------------------------------------------------------------
  // Registration requests (host asks, master approves/rejects)
  // ---------------------------------------------------------------

  createRegistration(body = {}) {
    const agentId = String(body.agent_id || body.id || "").trim();
    const baseUrl = String(body.base_url || "").trim().replace(/\/+$/, "");
    if (!agentId || !baseUrl) return null;

    // Avoid duplicate pending requests for the same host.
    for (const reg of this.registrations.values()) {
      if (reg.agent_id === agentId && reg.status === "pending") return reg;
    }

    const registration = {
      id: crypto.randomUUID(),
      agent_id: agentId,
      base_url: baseUrl,
      mode: body.mode || "minimal",
      max_hops: Number.isInteger(body.max_hops) ? body.max_hops : 5,
      max_rounds: Number.isInteger(body.max_rounds) ? body.max_rounds : 10,
      timeout_ms: Number.isInteger(body.timeout_ms) ? body.timeout_ms : 0,
      description: body.description || "",
      capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
      command: body.command || null,
      cwd: body.cwd || null,
      completion_provider: body.completion_provider || null,
      platform: body.platform || process.platform,
      port: body.port || null,
      status: "pending",
      created_at: new Date().toISOString(),
      decided_at: null,
      decision: null,
    };
    this.registrations.set(registration.id, registration);
    this._schedulePersist();
    return registration;
  }

  getRegistration(id) {
    return this.registrations.get(id) || null;
  }

  listRegistrations({ status } = {}) {
    let list = Array.from(this.registrations.values());
    if (status) list = list.filter((r) => r.status === status);
    return list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  approveRegistration(id) {
    const reg = this.registrations.get(id);
    if (!reg) return null;
    if (reg.status !== "pending") return reg;
    reg.status = "approved";
    reg.decided_at = new Date().toISOString();
    reg.decision = "approved";

    const now = new Date();
    const existing = this.agents.get(reg.agent_id);
    const record = this._normalizeAgent(
      {
        agent_id: reg.agent_id,
        base_url: reg.base_url,
        mode: reg.mode,
        max_hops: reg.max_hops,
        max_rounds: reg.max_rounds,
        timeout_ms: reg.timeout_ms,
        description: reg.description,
        capabilities: reg.capabilities,
        command: reg.command,
        cwd: reg.cwd,
        completion_provider: reg.completion_provider,
        platform: reg.platform,
        port: reg.port,
      },
      now
    );
    if (record) {
      record.registered_at = existing?.registered_at || now.toISOString();
      record.last_seen = now.toISOString();
      record.last_seen_ms = now.getTime();
      this.agents.set(reg.agent_id, record);
      if (!this.permissions.has(reg.agent_id)) {
        this.permissions.set(reg.agent_id, { allow_all: true, allowed_hosts: [] });
      }
    }
    this._schedulePersist();
    return reg;
  }

  rejectRegistration(id) {
    const reg = this.registrations.get(id);
    if (!reg) return null;
    if (reg.status !== "pending") return reg;
    reg.status = "rejected";
    reg.decided_at = new Date().toISOString();
    reg.decision = "rejected";
    this._schedulePersist();
    return reg;
  }

  registerAgent(body) {
    const record = this._normalizeAgent(body);
    if (!record) return null;
    this.agents.set(record.agent_id, record);
    this._schedulePersist();
    return this._publicAgent(record);
  }

  heartbeat(agentId, body = {}) {
    const now = new Date();
    const existing = this.agents.get(agentId);
    if (!existing) return null;
    const record = this._normalizeAgent({ ...existing, ...body }, now);
    if (!record) return null;
    this.agents.set(agentId, record);
    this._schedulePersist();

    // Return dead task IDs so hosts can clean up stale tasks/queue items.
    const deadTaskIds = Array.from(this.deadTasks);
    return {
      ...this._publicAgent(record),
      is_leader: this.leaderAgentId === agentId,
      tasks_to_remove: deadTaskIds,
    };
  }

  unregister(agentId) {
    const removed = this.agents.delete(agentId);
    if (removed) this._schedulePersist();
    return removed;
  }

  getAgent(agentId) {
    const record = this.agents.get(agentId);
    return record ? this._publicAgent(record) : null;
  }

  listAgents({ onlineOnly = false } = {}) {
    const now = Date.now();
    const list = [];
    for (const record of this.agents.values()) {
      const alive = now - record.last_seen_ms <= this.onlineTimeoutMs;
      if (onlineOnly && !alive) continue;
      list.push({ ...this._publicAgent(record), online: alive });
    }
    return list.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  }

  discoverNeighbors(agentId) {
    const now = Date.now();
    const self = this.agents.get(agentId);
    const neighbors = [];
    for (const record of this.agents.values()) {
      if (record.agent_id === agentId) continue;
      if (now - record.last_seen_ms > this.onlineTimeoutMs) continue;
      // Hide the leader from non-leader workers. Workers must not treat the
      // leader as a task executor/neighbor; leader decisions come via events.
      if (this.leaderAgentId && record.agent_id === this.leaderAgentId && agentId !== this.leaderAgentId) continue;
      const permissions = this.permissions.get(record.agent_id) || { allow_all: true, allowed_hosts: [] };
      const visible =
        permissions.allow_all === true ||
        (Array.isArray(permissions.allowed_hosts) &&
          permissions.allowed_hosts.includes(agentId));
      if (!visible) continue;
      neighbors.push({
        agent_id: record.agent_id,
        base_url: record.base_url,
        mode: record.mode,
        description: record.description || "",
        capabilities: record.capabilities || [],
        timeout_ms: record.timeout_ms ?? 0,
        is_leader: record.agent_id === this.leaderAgentId,
      });
    }
    return {
      agent_id: agentId,
      self: self ? this._publicAgent(self) : null,
      neighbors,
    };
  }

  _publicAgent(record) {
    return {
      agent_id: record.agent_id,
      base_url: record.base_url,
      mode: record.mode,
      max_hops: record.max_hops,
      max_rounds: record.max_rounds,
      timeout_ms: record.timeout_ms ?? 0,
      description: record.description || "",
      capabilities: record.capabilities || [],
      is_leader: this.leaderAgentId === record.agent_id,
      command: record.command,
      cwd: record.cwd,
      completion_provider: record.completion_provider,
      platform: record.platform,
      port: record.port,
      status: record.status,
      agent_alive: record.agent_alive ?? null,
      permissions: this.permissions.get(record.agent_id) || { allow_all: true, allowed_hosts: [] },
      registered_at: record.registered_at,
      last_seen: record.last_seen,
    };
  }

  // ---------------------------------------------------------------
  // Global task index / termination broadcast
  // ---------------------------------------------------------------

  reportTask(body = {}) {
    const taskId = String(body.task_id || "").trim();
    if (!taskId) return null;
    const agentId = String(body.agent_id || "").trim();
    const participants = Array.isArray(body.participants)
      ? Array.from(new Set(body.participants.filter(Boolean)))
      : [];
    if (agentId && !participants.includes(agentId)) participants.push(agentId);

    const existing = this.tasks.get(taskId);
    if (!existing) {
      const record = {
        task_id: taskId,
        title: body.title || "",
        description: body.description || "",
        status: body.status || "active",
        created_by: body.created_by || agentId || null,
        current_owner: body.current_owner || null,
        participants,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        terminated_at: null,
        termination_reason: null,
      };
      this.tasks.set(taskId, record);
      this._schedulePersist();
      return this._publicTask(record);
    }

    existing.status = body.status || existing.status;
    if (body.title) existing.title = body.title;
    if (body.description) existing.description = body.description;
    if (body.created_by) existing.created_by = body.created_by;
    if (body.current_owner) existing.current_owner = body.current_owner;
    for (const p of participants) {
      if (!existing.participants.includes(p)) existing.participants.push(p);
    }
    existing.updated_at = new Date().toISOString();
    this._schedulePersist();
    return this._publicTask(existing);
  }

  getTask(taskId) {
    const task = this.tasks.get(taskId);
    return task ? this._publicTask(task) : null;
  }

  listTasks({ activeOnly = false } = {}) {
    let list = Array.from(this.tasks.values());
    if (activeOnly) list = list.filter((t) => t.status === "active" || t.status === "queued" || t.status === "running");
    return list.map((t) => this._publicTask(t)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  _publicTask(task) {
    return {
      task_id: task.task_id,
      title: task.title,
      description: task.description,
      status: task.status,
      created_by: task.created_by,
      current_owner: task.current_owner,
      participants: task.participants,
      created_at: task.created_at,
      updated_at: task.updated_at,
      terminated_at: task.terminated_at,
      termination_reason: task.termination_reason,
    };
  }

  /**
   * Mark a task terminated and broadcast to ALL registered hosts.
   * Called by the AgentHost that decided the task is over.
   */
  markTaskTerminated(taskId, status = "completed", reason = "", reporterAgentId = null) {
    let task = this.tasks.get(taskId);
    if (!task) {
      task = {
        task_id: taskId,
        title: "",
        description: "",
        status: "active",
        created_by: reporterAgentId,
        current_owner: reporterAgentId,
        participants: reporterAgentId ? [reporterAgentId] : [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        terminated_at: null,
        termination_reason: null,
      };
      this.tasks.set(taskId, task);
    }
    if (task.terminated_at) return this._publicTask(task); // idempotent

    task.status = status || "completed";
    task.terminated_at = new Date().toISOString();
    task.termination_reason = reason || "";
    task.updated_at = task.terminated_at;
    this.deadTasks.add(taskId);
    this._schedulePersist();

    if (status === "failed") {
      // If a task fails through a particular host repeatedly, suspect that
      // host's agent has crashed. The host that *reports* the failure is not
      // counted; the current owner is the one that failed to make progress.
      const owner = task.current_owner;
      if (owner && owner !== reporterAgentId) {
        this._incrementHostFailure(owner, taskId);
      }
    }

    this._broadcastTaskTermination(taskId, task.status, task.termination_reason);
    this._notifyLeaderDecision({
      event_type: task.status === "completed" ? "task_completed" : "task_failed",
      task: this._publicTask(task),
      reason: task.termination_reason,
    });
    return this._publicTask(task);
  }

  _incrementHostFailure(agentId, taskId) {
    const count = (this.hostFailures.get(agentId) || 0) + 1;
    this.hostFailures.set(agentId, count);
    this._schedulePersist();
    if (process.stdout.isTTY) {
      console.warn(`[Master] host ${agentId} failure count=${count} (task ${taskId})`);
    }
    if (count >= this.taskFailureLimit) {
      this._handleHostCrashed(agentId);
    }
  }

  _broadcastTaskTermination(taskId, status, reason) {
    const body = JSON.stringify({ task_id: taskId, status, reason: reason || "" });
    for (const record of this.agents.values()) {
      const url = `${record.base_url.replace(/\/$/, "")}/v1/events/task-terminated`;
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-From": "master",
        },
        body,
      }).catch(() => {
        // Host may be temporarily unreachable; heartbeat dead_tasks sync catches up.
      });
    }
  }

  /**
   * Ask the configured leader to decide whether to create new tasks.
   * The leader receives all agent cards + relevant task log URLs.
   */
  _notifyLeaderDecision({ event_type, task, reason }) {
    if (!this.leaderAgentId) return;
    const leader = this.agents.get(this.leaderAgentId);
    if (!leader) return;
    const agents = Array.from(this.agents.values()).map((a) => this._publicAgent(a));
    const logUrls = [];
    if (task?.task_id) {
      // Origin host's shared store URL is not tracked on Master; derive from
      // participants if we know their base URLs.
      for (const p of task.participants || []) {
        const rec = this.agents.get(p);
        if (rec) logUrls.push(`${rec.base_url.replace(/\/$/, "")}/v1/tasks/${encodeURIComponent(task.task_id)}/log`);
      }
    }
    const body = JSON.stringify({
      event_type,
      task,
      reason: reason || "",
      agents,
      log_urls: logUrls,
    });
    const url = `${leader.base_url.replace(/\/$/, "")}/v1/events/leader-decision`;
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-From": "master",
      },
      body,
    }).catch(() => {
      // Leader may be temporarily unreachable; ignore, Master still keeps state.
    });
  }

  /**
   * Host heartbeat timed out or was judged crashed. Remove the registration,
   * mark every active task that touched this host as failed, and broadcast.
   */
  _handleHostOffline(agentId) {
    const record = this.agents.get(agentId);
    if (!record || record.offline_handled) return;
    record.offline_handled = true;
    record.status = "offline";
    record.agent_alive = false;
    this._schedulePersist();
    this.hostFailures.delete(agentId);
    if (process.stdout.isTTY) {
      console.warn(`[Master] host offline/crashed: ${agentId}`);
    }
    this._failTasksForHost(agentId, `host_offline:${agentId}`);
  }

  _handleHostCrashed(agentId) {
    // Same handling as offline: unregister + fail all tasks touching it.
    this._handleHostOffline(agentId);
  }

  _failTasksForHost(agentId, reason) {
    for (const task of this.tasks.values()) {
      if (task.terminated_at) continue;
      const touched =
        task.participants.includes(agentId) ||
        task.created_by === agentId ||
        task.current_owner === agentId;
      if (!touched) continue;
      task.status = "failed";
      task.terminated_at = new Date().toISOString();
      task.termination_reason = reason;
      task.updated_at = task.terminated_at;
      this.deadTasks.add(task.task_id);
      this._schedulePersist();
      this._broadcastTaskTermination(task.task_id, "failed", reason);
      this._notifyLeaderDecision({
        event_type: "task_failed",
        task: this._publicTask(task),
        reason,
      });
    }
  }

  // ---------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------

  _sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  _sendText(res, status, text) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
  }

  _serveStatic(res, relativePath) {
    const publicDir = path.join(__dirname, "..", "public");
    const filePath = path.join(publicDir, relativePath);
    if (!filePath.startsWith(publicDir)) {
      return this._sendText(res, 403, "forbidden");
    }
    let content;
    try {
      content = fs.readFileSync(filePath);
    } catch (_) {
      return this._sendText(res, 404, "not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".css"
            ? "text/css; charset=utf-8"
            : "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": content.length,
    });
    res.end(content);
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) {
          reject(new Error("body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!data) return resolve({});
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          reject(new Error("invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method || "GET";

    // ---- static frontend ----
    if (method === "GET" && (path === "/" || path === "/index.html")) {
      return this._serveStatic(res, "index.html");
    }
    if (method === "GET" && path === "/main.js") {
      return this._serveStatic(res, "main.js");
    }
    if (method === "GET" && path === "/style.css") {
      return this._serveStatic(res, "style.css");
    }

    // ---- health ----
    if (method === "GET" && path === "/health") {
      return this._sendJson(res, 200, {
        ok: true,
        name: "master",
        agents: this.agents.size,
        online: this.listAgents({ onlineOnly: true }).length,
      });
    }

    // ---- registration requests ----
    if (method === "POST" && path === "/v1/registrations") {
      let body;
      try {
        body = await this._readBody(req);
      } catch (err) {
        return this._sendJson(res, 400, { ok: false, error: err.message });
      }
      const registration = this.createRegistration(body);
      if (!registration) {
        return this._sendJson(res, 400, { ok: false, error: "agent_id and base_url are required" });
      }
      return this._sendJson(res, 201, { ok: true, registration });
    }

    if (method === "GET" && path === "/v1/registrations") {
      const status = url.searchParams.get("status") || "";
      return this._sendJson(res, 200, {
        registrations: this.listRegistrations({ status }),
      });
    }

    const registrationMatch = path.match(/^\/v1\/registrations\/([^/]+)$/);
    if (registrationMatch) {
      const id = decodeURIComponent(registrationMatch[1]);
      if (method === "GET") {
        const reg = this.getRegistration(id);
        if (!reg) {
          return this._sendJson(res, 404, { ok: false, error: "registration not found" });
        }
        return this._sendJson(res, 200, { ok: true, registration: reg });
      }
      if (method === "DELETE") {
        const removed = this.registrations.delete(id);
        if (removed) this._schedulePersist();
        return this._sendJson(res, 200, { ok: true, removed });
      }
    }

    const approveMatch = path.match(/^\/v1\/registrations\/([^/]+)\/approve$/);
    if (method === "POST" && approveMatch) {
      const id = decodeURIComponent(approveMatch[1]);
      const reg = this.approveRegistration(id);
      if (!reg) {
        return this._sendJson(res, 404, { ok: false, error: "registration not found" });
      }
      return this._sendJson(res, 200, { ok: true, registration: reg });
    }

    const rejectMatch = path.match(/^\/v1\/registrations\/([^/]+)\/reject$/);
    if (method === "POST" && rejectMatch) {
      const id = decodeURIComponent(rejectMatch[1]);
      const reg = this.rejectRegistration(id);
      if (!reg) {
        return this._sendJson(res, 404, { ok: false, error: "registration not found" });
      }
      return this._sendJson(res, 200, { ok: true, registration: reg });
    }

    // ---- register ----
    if (method === "POST" && path === "/v1/agents/register") {
      let body;
      try {
        body = await this._readBody(req);
      } catch (err) {
        return this._sendJson(res, 400, { ok: false, error: err.message });
      }
      const agent = this.registerAgent(body);
      if (!agent) {
        return this._sendJson(res, 400, {
          ok: false,
          error: "agent_id and base_url are required",
        });
      }
      return this._sendJson(res, 200, { ok: true, agent });
    }

    // ---- heartbeat ----
    const heartbeatMatch = path.match(/^\/v1\/agents\/([^/]+)\/heartbeat$/);
    if (method === "POST" && heartbeatMatch) {
      const agentId = decodeURIComponent(heartbeatMatch[1]);
      let body;
      try {
        body = await this._readBody(req);
      } catch (err) {
        return this._sendJson(res, 400, { ok: false, error: err.message });
      }
      const agent = this.heartbeat(agentId, body);
      if (!agent) {
        return this._sendJson(res, 404, { ok: false, error: "agent not registered or waiting for approval" });
      }
      return this._sendJson(res, 200, { ok: true, agent });
    }

    // ---- permissions ----
    const permissionsMatch = path.match(/^\/v1\/agents\/([^/]+)\/permissions$/);
    if (permissionsMatch) {
      const agentId = decodeURIComponent(permissionsMatch[1]);
      if (method === "GET") {
        const agent = this.getAgent(agentId);
        if (!agent) {
          return this._sendJson(res, 404, { ok: false, error: "agent not found" });
        }
        return this._sendJson(res, 200, {
          agent_id: agentId,
          permissions: agent.permissions,
        });
      }
      if (method === "PUT" || method === "POST") {
        let body;
        try {
          body = await this._readBody(req);
        } catch (err) {
          return this._sendJson(res, 400, { ok: false, error: err.message });
        }
        const agent = this.setPermissions(agentId, body);
        if (!agent) {
          return this._sendJson(res, 404, { ok: false, error: "agent not found" });
        }
        return this._sendJson(res, 200, { ok: true, agent });
      }
    }

    // ---- task index ----
    if (method === "POST" && path === "/v1/tasks") {
      let body;
      try {
        body = await this._readBody(req);
      } catch (err) {
        return this._sendJson(res, 400, { ok: false, error: err.message });
      }
      const task = this.reportTask(body);
      if (!task) {
        return this._sendJson(res, 400, { ok: false, error: "task_id is required" });
      }
      return this._sendJson(res, 200, { ok: true, task });
    }

    if (method === "GET" && path === "/v1/tasks") {
      const activeOnly = url.searchParams.get("active") === "1" || url.searchParams.get("active") === "true";
      return this._sendJson(res, 200, { tasks: this.listTasks({ activeOnly }) });
    }

    const taskMatch = path.match(/^\/v1\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      if (method === "GET") {
        const task = this.getTask(taskId);
        if (!task) return this._sendJson(res, 404, { ok: false, error: "task not found" });
        return this._sendJson(res, 200, task);
      }
    }

    // ---- task terminated notification (from AgentHost) ----
    if (method === "POST" && path.match(/^\/v1\/tasks\/([^/]+)\/terminated$/)) {
      const m = path.match(/^\/v1\/tasks\/([^/]+)\/terminated$/);
      const taskId = decodeURIComponent(m[1]);
      let body;
      try {
        body = await this._readBody(req);
      } catch (err) {
        return this._sendJson(res, 400, { ok: false, error: err.message });
      }
      const reporter = req.headers["x-from"] || body.agent_id || null;
      const task = this.markTaskTerminated(taskId, body.status || "completed", body.reason || "", reporter);
      if (!task) return this._sendJson(res, 404, { ok: false, error: "task not found" });
      return this._sendJson(res, 200, { ok: true, task });
    }

    // ---- leader ----
    if (path === "/v1/leader") {
      if (method === "GET") {
        const leader = this.getLeader();
        if (!leader) return this._sendJson(res, 200, { ok: true, leader: null });
        return this._sendJson(res, 200, { ok: true, leader });
      }
      if (method === "POST" || method === "PUT") {
        let body;
        try {
          body = await this._readBody(req);
        } catch (err) {
          return this._sendJson(res, 400, { ok: false, error: err.message });
        }
        const agentId = String(body.agent_id || "").trim();
        if (!agentId) return this._sendJson(res, 400, { ok: false, error: "agent_id is required" });
        const leader = this.setLeader(agentId);
        if (!leader) return this._sendJson(res, 404, { ok: false, error: "agent not found" });
        return this._sendJson(res, 200, { ok: true, leader });
      }
      if (method === "DELETE") {
        return this._sendJson(res, 200, { ok: true, ...this.clearLeader() });
      }
    }

    // ---- unregister ----
    const agentMatch = path.match(/^\/v1\/agents\/([^/]+)$/);
    if (method === "DELETE" && agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const removed = this.unregister(agentId);
      return this._sendJson(res, 200, { ok: true, removed });
    }

    // ---- get one agent ----
    if (method === "GET" && agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const agent = this.getAgent(agentId);
      if (!agent) {
        return this._sendJson(res, 404, { ok: false, error: "agent not found" });
      }
      return this._sendJson(res, 200, agent);
    }

    // ---- list agents ----
    if (method === "GET" && path === "/v1/agents") {
      const onlineOnly = url.searchParams.get("online") === "1" || url.searchParams.get("online") === "true";
      return this._sendJson(res, 200, { agents: this.listAgents({ onlineOnly }) });
    }

    // ---- neighbor discovery ----
    if (method === "GET" && path === "/v1/neighbors") {
      const agentId = url.searchParams.get("agent_id") || url.searchParams.get("agentId") || "";
      if (!agentId) {
        return this._sendJson(res, 400, { ok: false, error: "agent_id query parameter is required" });
      }
      return this._sendJson(res, 200, this.discoverNeighbors(agentId));
    }

    return this._sendJson(res, 404, { ok: false, error: "not found" });
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          if (!res.headersSent) {
            this._sendJson(res, 500, { ok: false, error: err.message });
          } else {
            res.destroy();
          }
        });
      });
      this.server.on("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        const actualPort = this.server.address().port;
        this.pruneTimer = setInterval(() => this.pruneOffline(), HEARTBEAT_PRUNE_INTERVAL_MS);
        this.pruneTimer.unref?.();
        resolve(actualPort);
      });
    });
  }

  pruneOffline() {
    const now = Date.now();
    const offline = [];
    for (const record of this.agents.values()) {
      if (now - record.last_seen_ms > this.onlineTimeoutMs && !record.offline_handled) {
        offline.push(record.agent_id);
      }
    }
    for (const agentId of offline) {
      this._handleHostOffline(agentId);
    }
    // Expire deadTasks from heartbeat sync once they are old (5 min).
    const oldDead = new Set();
    for (const taskId of this.deadTasks) {
      const task = this.tasks.get(taskId);
      if (task && task.terminated_at && now - new Date(task.terminated_at).getTime() > 5 * 60 * 1000) {
        oldDead.add(taskId);
      }
    }
    for (const taskId of oldDead) {
      this.deadTasks.delete(taskId);
    }
    if (oldDead.size > 0) this._schedulePersist();
  }

  stop() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this._persistState();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.server) {
      return new Promise((resolve) => this.server.close(resolve));
    }
    return Promise.resolve();
  }
}

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--port":
        args.port = parseInt(next(), 10) || DEFAULT_PORT;
        break;
      case "--online-timeout-ms":
        args.onlineTimeoutMs = parseInt(next(), 10) || ONLINE_TIMEOUT_MS;
        break;
      case "--data-file":
        args.dataFile = next();
        break;
      case "--help":
      case "-h":
        console.log(`
Master - central agent registry & discovery

Usage:
  node src/index.js [options]

Options:
  --port <port>               Listen port (default: 9300)
  --online-timeout-ms <ms>    Consider agent offline after no heartbeat (default: 15000)
  --data-file <path>          Persistent state JSON file
  --help                      Show this help
`);
        process.exit(0);
        break;
      default:
        break;
    }
  }
  return args;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const master = new Master(opts);
  const port = await master.start();
  console.log(`[Master] listening on http://127.0.0.1:${port}`);
  console.log(`[Master] health: http://127.0.0.1:${port}/health`);
  console.log(`[Master] agents: http://127.0.0.1:${port}/v1/agents`);
  console.log(`[Master] neighbors: http://127.0.0.1:${port}/v1/neighbors?agent_id=<agent-id>`);

  const shutdown = async () => {
    console.log("\n[Master] shutting down...");
    await master.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[Master] fatal:", err);
    process.exit(1);
  });
}

module.exports = { Master, DEFAULT_PORT, ONLINE_TIMEOUT_MS };
