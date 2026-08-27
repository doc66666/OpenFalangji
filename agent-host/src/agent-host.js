"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");
const pty = require("node-pty");

const { openTerminalViewer } = require("./terminal-launcher");
const {
  createCompletionDetector,
  detectProviderFromCommand,
} = require("./completion-detectors");
const { TaskStore } = require("./task-store");
const {
  TASK_OVER_MARKER,
  AGENT_REPLY_START,
  AGENT_REPLY_END,
  wrapInbound,
  unwrapInbound,
  wrapOutbound,
  buildAgentPrompt,
  buildLeaderDecisionPrompt,
  buildRoutingInstructions,
  buildOutboundTaskRequest,
  createLocalRequest,
  parseIncomingHttpRequest,
  buildReplyHttpRequest,
  containsTaskOverMarker,
  parseAgentReply,
  extractAgentReplyContent,
} = require("./protocol");

function sanitizeTerminalOutput(text, maxLen = 20000) {
  const cleaned = String(text || "")
    .replace(/\x1B\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(-maxLen) : cleaned;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toWslPath(input) {
  const value = String(input || "").trim();
  const match = value.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (!match) return value || "~";
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

class AgentHost {
  /**
   * @param {object} opts
   * @param {string} opts.agentId
   * @param {string} [opts.command]     Initial agent command (can be changed from UI later)
   * @param {string} [opts.cwd]         Working directory for the agent
   * @param {number} [opts.port]        Listen port; 0 means random free port
   * @param {boolean} [opts.openTerminal] Open a system terminal window for observation
   * @param {string} [opts.centerUrl]   Optional center URL for future registration/heartbeat
   * @param {object} [opts.env]         Extra environment variables
   */
  constructor(opts) {
    this.agentId = opts.agentId || `agent-${process.pid}`;
    this.command = opts.command || null;
    this.cwd = opts.cwd || process.cwd();
    this.terminalEnv = opts.terminalEnv === "wsl" ? "wsl" : "native";
    this.wslDistro = opts.wslDistro || "";
    this.port = opts.port || 0;
    this.openTerminal = opts.openTerminal !== false;
    this.centerUrl = opts.centerUrl || null;
    this.centerStatus = null; // { state: "none"|"pending"|"registered"|"rejected", message? }
    this.registrationId = null;
    this.registrationPollTimer = null;
    this.agentAlive = false;
    this.completionProvider = opts.completionProvider || null;
    this.completionConfig = opts.completionConfig || null;
    this.description = opts.description || "";
    this.capabilities = Array.isArray(opts.capabilities) ? opts.capabilities : [];
    this.isLeader = false;
    this.env = { ...process.env, ...(opts.env || {}) };

    // Collaboration config
    this.mode = opts.mode || "minimal"; // "task" | "minimal"
    this.maxHops = opts.maxHops || 5;
    this.maxRounds = opts.maxRounds || 10;
    this.taskTimeoutMs = opts.taskTimeoutMs || 0; // ms; 0 = disabled
    this.neighbors = new Map(); // agent_id -> { agent_id, base_url }
    this.taskStore = new TaskStore(opts.taskStoreRoot);
    this._stateFile = path.join(this.taskStore.root, `${this.agentId}-host-state.json`);
    this._persistTimer = null;

    // Dirty task IDs (removed/dead): never accept new items for these tasks.
    this._dirtyTaskIds = new Set();

    // Seen HTTP request IDs for idempotency. Keyed by X-Request-Id, NOT task_id,
    // so a forward of an already-known task (same task_id, new request) is accepted.
    this._seenRequestIds = new Set();

    // Task timeout timers: task_id -> timer handle
    this._taskTimeouts = new Map();

    // Leader-event safety timer (force-complete after 30s to avoid deadlock)
    this._leaderEventTimer = null;

    this.ptyProcess = null;
    this.server = null;
    this.wss = null;
    this.actualPort = null;
    this.clients = new Set();
    this.startedAt = new Date();
    this.agentStartedAt = 0;
    this.heartbeatTimer = null;
    this.discoveryTimer = null;
    this._outboundTimer = null;
    this.lastKnownCols = 120;
    this.lastKnownRows = 30;

    // ---- Message queues ----
    // Inbound: requests waiting to be sent to the agent.
    this.inboundQueue = [];
    // Outbound: completed task results waiting to be consumed by the center/UI.
    this.outboundQueue = [];
    // Current execution state.
    this.busy = false;
    this.currentTask = null;
    this.completionDetector = null;
    this._outboundSending = false;
    // A restored in-flight task must be checked against Master before it can
    // return to a live agent. This prevents a task that failed while the Host
    // was offline from being replayed into a new Claude session.
    this._recoveryPending = false;

    this._restoreHostState(opts);

    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, "..", "public")));
    this.app.use(
      "/vendor/xterm",
      express.static(path.join(__dirname, "..", "node_modules", "@xterm", "xterm"))
    );
    this.app.use(
      "/vendor/xterm-addon-fit",
      express.static(
        path.join(__dirname, "..", "node_modules", "@xterm", "addon-fit")
      )
    );

    this._setupRoutes();
  }

  _setupRoutes() {
    this.app.get("/health", (req, res) => {
      res.json(this.getStatus());
    });

    this.app.get("/status", (req, res) => {
      res.json(this.getStatus());
    });

    this.app.get("/queue", (req, res) => {
      res.json(this.getQueueState());
    });

    // ---- Collaboration API ----

    this.app.get("/v1/agent", (req, res) => {
      res.json({
        agent_id: this.agentId,
        base_url: `http://127.0.0.1:${this.actualPort || this.port}`,
        mode: this.mode,
        max_hops: this.maxHops,
        max_rounds: this.maxRounds,
        neighbors: Array.from(this.neighbors.values()),
      });
    });

    this.app.post("/v1/config", (req, res) => {
      const { agent_id, mode, max_hops, max_rounds, timeout_ms, description, capabilities, terminal_env, wsl_distro } = req.body || {};
      if (agent_id) this.agentId = String(agent_id);
      if (mode === "task" || mode === "minimal") this.mode = mode;
      if (Number.isInteger(max_hops) && max_hops > 0) this.maxHops = max_hops;
      if (Number.isInteger(max_rounds) && max_rounds > 0) this.maxRounds = max_rounds;
      if (Number.isInteger(timeout_ms) && timeout_ms >= 0) this.taskTimeoutMs = timeout_ms;
      if (typeof description === "string") this.description = description;
      if (Array.isArray(capabilities)) this.capabilities = capabilities.map(String);
      if (terminal_env === "native" || terminal_env === "wsl") this.terminalEnv = terminal_env;
      if (typeof wsl_distro === "string") this.wslDistro = wsl_distro.trim();
      if (this.centerUrl) {
        if (this.centerStatus?.state === "registered") {
          this._startHeartbeat();
          this._discoverNeighbors();
        } else {
          this.sendRegistrationRequest(this.centerUrl);
        }
      }
      this._broadcastStatus();
      res.json(this.getStatus());
    });

    this.app.post("/master/register", (req, res) => {
      const { center_url } = req.body || {};
      if (!center_url) {
        return res.status(400).json({ ok: false, error: "center_url is required" });
      }
      this.sendRegistrationRequest(center_url);
      res.json({ ok: true, status: this.centerStatus });
    });

    this.app.get("/v1/neighbors", (req, res) => {
      res.json({ neighbors: Array.from(this.neighbors.values()) });
    });

    this.app.post("/v1/neighbors", (req, res) => {
      const { agent_id, base_url } = req.body || {};
      if (!agent_id || !base_url) {
        return res.status(400).json({ ok: false, error: "agent_id and base_url are required" });
      }
      this.neighbors.set(agent_id, { agent_id, base_url });
      this._broadcastStatus();
      res.json({ ok: true, neighbor: this.neighbors.get(agent_id) });
    });

    this.app.delete("/v1/neighbors/:agentId", (req, res) => {
      this.neighbors.delete(req.params.agentId);
      this._broadcastStatus();
      res.json({ ok: true });
    });

    this.app.post("/v1/send-task", async (req, res) => {
      const { to_agent_id, task_id, title, description, prompt } = req.body || {};
      if (!to_agent_id || !prompt) {
        return res.status(400).json({ ok: false, error: "to_agent_id and prompt are required" });
      }
      try {
        const result = await this._sendTaskToNeighbor(to_agent_id, {
          task_id,
          title,
          description,
          prompt,
        });
        res.json(result);
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    this.app.post("/v1/tasks", (req, res) => {
      const request = parseIncomingHttpRequest(req.headers, req.body || {});
      const taskId =
        request.task_id ||
        `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = request.payload.prompt;
      if (!prompt) {
        return res.status(400).json({ ok: false, error: "prompt/description is required" });
      }

      // ---- Idempotency: dedupe by X-Request-Id (the same HTTP request must not
      // be processed twice). task_id alone is NOT enough: a forward of an already
      // known task is a legitimate new request and must be accepted/requeued.
      const requestId = request.request_id || "";
      if (requestId && this._seenRequestIds.has(requestId)) {
        const existingTask = this.taskStore.get(taskId);
        return res.status(200).json({
          ok: true,
          agent_id: this.agentId,
          task_id: taskId,
          status: existingTask?.status || "queued",
          existing: true,
        });
      }

      // ---- Dirty/dropped tasks: refuse to enqueue.
      if (this._dirtyTaskIds.has(taskId)) {
        return res.status(410).json({
          ok: false,
          error: "task has been terminated, not accepting",
        });
      }

      // ---- Leader hosts refuse task forwarding from other agents (leader
      // is not a task executor). The Leader only receives leader-decision
      // events from Master, not regular task forwards.
      if (this.isLeader && request.from && request.from !== "master") {
        return res.status(403).json({
          ok: false,
          error: "leader does not accept forwarded tasks",
          note: "this host is a leader; forward decisions go through /v1/events/leader-decision",
        });
      }

      const reply = {
        url: request.reply_to,
        request_id: request.request_id,
        from: request.from,
        task_origin: request.task_origin,
      };

      // Extract timeout_ms from context for task-mode tasks.
      const timeoutMs = Number.isInteger(request.payload?.context?.timeout_ms)
        ? request.payload.context.timeout_ms
        : 0;

      // AgentHost's own mode decides whether this is tracked as a task.
      if (this.mode === "task") {
        const item = wrapInbound({
          type: request.type || "task",
          task_id: taskId,
          payload: request.payload,
          reply,
        });
        // Report this task to Master (so Master knows who is participating).
        this._reportTaskToMaster({
          task_id: taskId,
          title: request.payload.title || "",
          description: request.payload.description || prompt,
          participants: [reply.from].filter(Boolean),
          created_by: reply.from || request.from || null,
          current_owner: this.agentId,
        });
        this.enqueueInbound(item);
        if (timeoutMs > 0) {
          this._startTaskTimeout(taskId, timeoutMs);
        }
        if (requestId) this._seenRequestIds.add(requestId);
        res.status(202).json({ ok: true, agent_id: this.agentId, task_id: taskId, status: "queued" });
      } else {
        const item = wrapInbound({
          type: "minimal",
          task_id: taskId,
          payload: { prompt },
          reply,
        });
        this.enqueueInbound(item);
        if (requestId) this._seenRequestIds.add(requestId);
        res.status(202).json({ ok: true, agent_id: this.agentId, task_id: taskId, status: "queued", mode: "minimal" });
      }
    });

    this.app.get("/v1/tasks", (req, res) => {
      res.json({ tasks: this.taskStore.list() });
    });

    this.app.get("/v1/tasks/:taskId", (req, res) => {
      const task = this.taskStore.get(req.params.taskId);
      if (!task) return res.status(404).json({ ok: false, error: "task not found" });
      res.json(task);
    });

    this.app.post("/v1/tasks/:taskId/reply", (req, res) => {
      const taskId = req.params.taskId;
      const body = req.body || {};
      const task = this.taskStore.get(taskId);
      if (!task) return res.status(404).json({ ok: false, error: "task not found" });

      const senderAgentId = body.agent_id || req.headers["x-from"] || null;
      const content = body.content || body.final_output || "";

      this.taskStore.appendHistory(taskId, {
        type: "external_reply",
        agent: senderAgentId,
        content,
        status: body.status || "active",
      });

      if (body.status === "completed" || body.status === "failed" || body.status === "max_hops_exceeded") {
        this.taskStore.update(taskId, {
          status: body.status,
          terminated_at: new Date().toISOString(),
          latest_reply: {
            agent_id: senderAgentId,
            content,
            at: new Date().toISOString(),
          },
        });
        this._markTaskDirty(taskId, body.status);
        this._reportTaskToMaster(taskId, body.status);
        this._notifyMasterTaskTerminated(taskId, body.status);
      } else {
        this.taskStore.update(taskId, {
          status: "active",
          latest_reply: {
            agent_id: senderAgentId,
            content,
            at: new Date().toISOString(),
          },
        });
      }

      // Feed the received reply into this AgentHost's own agent, so the
      // operator can see/continue the conversation.
      if (content && this.ptyProcess) {
        const isTerminal = ["completed", "failed", "max_hops_exceeded", "canceled"].includes(body.status);
        const neighbor = senderAgentId ? this.neighbors.get(senderAgentId) : null;
        const replyTo = neighbor
          ? `${neighbor.base_url.replace(/\/$/, "")}/v1/tasks/${taskId}/reply`
          : null;
        const item = wrapInbound({
          // Terminal replies are displayed to the local agent but do NOT get
          // a reply URL, so the conversation stops. Active replies are treated
          // as a handoff so max_hops can bound the back-and-forth loop.
          type: isTerminal
            ? "minimal"
            : this.mode === "task"
              ? "handoff"
              : "minimal",
          task_id: taskId,
          payload: {
            prompt: content,
            title: task.title || "",
            description: task.description || content,
            context: {},
          },
          reply: isTerminal
            ? null
            : {
                url: replyTo,
                request_id: req.headers["x-request-id"] || body.request_id || null,
                from: senderAgentId,
                task_origin: neighbor ? neighbor.base_url : null,
              },
        });
        this.enqueueInbound(item);
      }

      this._broadcastStatus();
      res.json({ ok: true });
    });

    this.app.post("/v1/tasks/:taskId/terminate", (req, res) => {
      const taskId = req.params.taskId;
      const task = this.taskStore.get(taskId);
      const queued =
        task ||
        this.inboundQueue.some((i) => i.task_id === taskId) ||
        this.outboundQueue.some((i) => i.task_id === taskId) ||
        this.currentTask?.task_id === taskId;
      if (!queued) return res.status(404).json({ ok: false, error: "task not found" });
      const body = req.body || {};
      // Handle tasks that are only in a queue but not yet materialized.
      if (task) {
        this._terminateTask(task, body.status || "completed", body.reason || "");
      } else {
        this._markTaskDirty(taskId, body.status || "failed", body.reason || "terminated while queued");
        this._reportTaskToMaster(taskId, body.status || "failed", body.reason || "");
        this._notifyMasterTaskTerminated(taskId, body.status || "failed", body.reason || "");
      }
      res.json({ ok: true, task: this.taskStore.get(taskId) });
    });

    this.app.get("/v1/tasks/:taskId/files", (req, res) => {
      const task = this.taskStore.get(req.params.taskId);
      if (!task) return res.status(404).json({ ok: false, error: "task not found" });
      res.json({ files: this.taskStore.listFiles(req.params.taskId) });
    });

    this.app.get("/v1/tasks/:taskId/files/:name", (req, res) => {
      const taskId = req.params.taskId;
      if (!this.taskStore.fileExists(taskId, req.params.name)) {
        return res.status(404).json({ ok: false, error: "file not found" });
      }
      res.send(this.taskStore.readFile(taskId, req.params.name));
    });

    this.app.put("/v1/tasks/:taskId/files/:name", (req, res) => {
      const taskId = req.params.taskId;
      if (!this.taskStore.get(taskId)) {
        return res.status(404).json({ ok: false, error: "task not found" });
      }
      const name = this.taskStore.writeFile(taskId, req.params.name, req.body);
      res.json({ ok: true, name });
    });

    // ---- Master broadcast: task is terminated, all hosts must stop it ----
    this.app.post("/v1/events/task-terminated", (req, res) => {
      const { task_id, status, reason } = req.body || {};
      if (!task_id) {
        return res.status(400).json({ ok: false, error: "task_id is required" });
      }
      this._handleTaskTerminatedEvent(task_id, status || "failed", reason || "");
      res.json({ ok: true, task_id });
    });

    // ---- Master -> Leader decision request ----
    // Only the configured leader host processes this. It asks the local agent
    // whether to create new tasks or stay silent.
    this.app.post("/v1/events/leader-decision", (req, res) => {
      if (!this.isLeader) {
        return res.json({ ok: false, ignored: true, error: "not leader" });
      }
      const body = req.body || {};
      if (!body.event_type) {
        return res.status(400).json({ ok: false, error: "event_type is required" });
      }
      const item = wrapInbound({
        type: "leader_event",
        task_id: `leader-event-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        payload: {
          event_type: body.event_type,
          task: body.task || null,
          reason: body.reason || "",
          agents: body.agents || [],
          log_urls: body.log_urls || [],
          prompt: "", // prompt built at pump time
        },
        reply: null,
      });
      this.enqueueInbound(item);
      res.json({ ok: true, queued: true });
    });

    // ---- Local user triggers a leader consultation via the web UI ----
    // The user types their request into the leader panel input box; this creates
    // a leader_event that includes the user's text as part of the reasoning prompt.
    this.app.post("/v1/leader/consult", (req, res) => {
      if (!this.isLeader) {
        return res.status(403).json({ ok: false, error: "this host is not the leader" });
      }
      const body = req.body || {};
      const userPrompt = String(body.prompt || "").trim();
      if (!userPrompt) {
        return res.status(400).json({ ok: false, error: "prompt is required" });
      }
      const item = wrapInbound({
        type: "leader_event",
        task_id: `leader-consult-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        payload: {
          event_type: "user_consultation",
          task: null,
          reason: "",
          agents: [],
          log_urls: [],
          prompt: userPrompt,
        },
        reply: null,
      });
      this.enqueueInbound(item);
      res.json({ ok: true, queued: true });
    });

    // Shared task log: read / write Q&A history.
    // The task creator's AgentHost is authoritative; other hosts call this
    // endpoint to persist every forwarded question/answer.
    this.app.get("/v1/tasks/:taskId/log", (req, res) => {
      const taskId = req.params.taskId;
      if (!this.taskStore.get(taskId)) {
        return res.status(404).json({ ok: false, error: "task not found" });
      }
      const result = this.taskStore.readLogEntries(taskId);
      if (result.locked) {
        return res.status(423).json({ ok: false, error: "并发读写，请重试" });
      }
      const wantText =
        req.query.format === "text" ||
        String(req.headers.accept || "").includes("text/plain");
      if (wantText) {
        res.type("text/plain").send(this.taskStore.formatLogText(result.entries));
      } else {
        res.json({ ok: true, task_id: taskId, entries: result.entries });
      }
    });

    this.app.post("/v1/tasks/:taskId/log", (req, res) => {
      const taskId = req.params.taskId;
      if (!this.taskStore.get(taskId)) {
        return res.status(404).json({ ok: false, error: "task not found" });
      }
      const body = req.body || {};
      const entry = {
        type: body.type || "qa",
        agent_id: body.agent_id || this.agentId,
        round: Number.isInteger(body.round) ? body.round : null,
        question: body.question || null,
        answer: body.answer || body.content || null,
        role: body.role || null,
        content: body.content || null,
        timestamp: body.timestamp || null,
      };
      const result = this.taskStore.appendLogEntry(taskId, entry);
      if (result.locked) {
        return res.status(423).json({ ok: false, error: "并发读写，请重试" });
      }
      res.json({ ok: true, task_id: taskId });
    });

    // Start or restart the agent process with a custom command.
    this.app.post("/start", (req, res) => {
      const { command, cwd, completion_provider, completion_config, terminal_env, wsl_distro } = req.body || {};
      if (!command || typeof command !== "string") {
        return res.status(400).json({ ok: false, error: "command is required" });
      }
      if (completion_provider) this.completionProvider = completion_provider;
      if (completion_config) this.completionConfig = completion_config;
      if (terminal_env === "native" || terminal_env === "wsl") this.terminalEnv = terminal_env;
      if (typeof wsl_distro === "string") this.wslDistro = wsl_distro.trim();
      try {
        this.startAgent(command, cwd);
        this.openObservationTerminal();
        res.json({ ok: true, command, cwd: cwd || this.cwd });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // Enqueue a prompt; it will be sent to the agent only after the previous
    // task has completed.
    this.app.post("/enqueue", (req, res) => {
      const { prompt, task_id, expect_marker } = req.body || {};
      if (typeof prompt !== "string" || !prompt.trim()) {
        return res.status(400).json({ ok: false, error: "prompt is required" });
      }
      const task = this.enqueue(prompt, task_id, expect_marker);
      res.json({ ok: true, ...task });
    });

    // Backwards-compatible alias.
    this.app.post("/inbox", (req, res) => {
      const { prompt, task_id, expect_marker } = req.body || {};
      if (typeof prompt !== "string" || !prompt.trim()) {
        return res.status(400).json({ ok: false, error: "prompt is required" });
      }
      const task = this.enqueue(prompt, task_id, expect_marker);
      res.json({ ok: true, ...task });
    });

    // Manually mark the current task as complete.
    this.app.post("/complete", (req, res) => {
      const completed = this.completeCurrentTask();
      res.json({ ok: true, completed });
    });

    this.app.post("/interrupt", (req, res) => {
      this.write("\x03"); // Ctrl-C
      res.json({ ok: true });
    });

    this.app.post("/stop", (req, res) => {
      res.json({ ok: true, stopping: true });
      setTimeout(() => this.stop(), 50);
    });
  }

  /**
   * Local minimal enqueue (from UI/old API). Wraps into an InboundQueueItem.
   */
  enqueue(prompt, task_id, expect_marker) {
    const item = wrapInbound({
      type: "minimal",
      task_id: task_id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      payload: { prompt, expect_marker },
      reply: null,
    });
    this.enqueueInbound(item);
    return item;
  }

  /**
   * Push a fully-wrapped InboundQueueItem into the inbound queue.
   * Dirty/terminated tasks are rejected before entering the queue.
   */
  enqueueInbound(item) {
    if (!item?.task_id) {
      // Every queue item must have a stable identity. Without one, its log,
      // persistence and reply route would all be keyed as the string "null".
      return null;
    }
    if (this._shouldPurgeTask(item?.task_id)) {
      return null;
    }
    this.inboundQueue.push(item);
    this._schedulePersist();
    this._broadcastStatus();
    this._pumpQueue();
    return item;
  }

  /**
   * True when a task is already marked dirty/terminated. This is the check
   * both queues run BEFORE accepting a new element, so even if a delayed
   * request re-appears after cleanup it is immediately dropped.
   */
  _shouldPurgeTask(taskId) {
    if (!taskId) return false;
    if (this._dirtyTaskIds.has(taskId)) return true;
    const task = this.taskStore.get(taskId);
    if (task && ["completed", "failed", "max_hops_exceeded", "canceled"].includes(task.status)) {
      return true;
    }
    return false;
  }

  /**
   * Mark a task as dirty/terminated, remove it from both queues, and clear
   * any running timeout. If the agent is currently processing this task,
   * the current execution is abandoned (it will not write back a reply).
   */
  _markTaskDirty(taskId, status = "failed", reason = "", opts = {}) {
    if (!taskId) return;
    this._dirtyTaskIds.add(taskId);
    this._clearTaskTimeout(taskId);

    // Remove from inbound queue (including delayed/re-entered items).
    this.inboundQueue = this.inboundQueue.filter((i) => i.task_id !== taskId);
    // Remove from outbound queue (including reply retries) UNLESS this host
    // just created a final reply and wants it to be delivered (keepOutbound).
    if (!opts.keepOutbound) {
      this.outboundQueue = this.outboundQueue.filter((i) => i.task_id !== taskId);
    }

    // If the agent is currently processing this task, stop it from replying.
    if (this.currentTask?.task_id === taskId) {
      this._stopCompletionDetector();
      this.currentTask = null;
      this.busy = false;
    }

    const task = this.taskStore.get(taskId);
    if (task && !["completed", "failed", "max_hops_exceeded", "canceled"].includes(task.status)) {
      this.taskStore.update(taskId, {
        status,
        terminated_at: new Date().toISOString(),
        latest_reply: {
          agent_id: "master",
          content: reason || "task terminated",
          at: new Date().toISOString(),
        },
      });
    }
    this._broadcast({ type: "task_terminated", task_id: taskId, status, reason });
    this._broadcastStatus();
    this._schedulePersist();
    this._pumpQueue();
  }

  /**
   * Called during queue pumping; skip any item that became dirty after it
   * was enqueued but before it is processed.
   */
  _filterDirtyTasks(items) {
    return (items || []).filter((i) => i?.task_id && !this._shouldPurgeTask(i.task_id));
  }

  /**
   * Start a timeout timer for an inbound task. When it fires, mark the task
   * failed and notify Master so all hosts stop working on it.
   */
  _startTaskTimeout(taskId, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    this._clearTaskTimeout(taskId);
    const timer = setTimeout(() => {
      this._taskTimeouts.delete(taskId);
      if (this._shouldPurgeTask(taskId)) return;
      let task = this.taskStore.get(taskId);
      if (!task) {
        // Task may still be sitting in a queue (no agent running / busy).
        // Materialize a placeholder so termination + Master report works.
        task = this.taskStore.ensureTask({
          task_id: taskId,
          title: "",
          description: "timeout while queued",
          created_by: this.agentId,
          current_owner: this.agentId,
          participants: [this.agentId],
        });
      }
      this._terminateTask(task, "failed", `timeout: ${timeoutMs}ms`);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    this._taskTimeouts.set(taskId, timer);
  }

  _clearTaskTimeout(taskId) {
    const timer = this._taskTimeouts.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this._taskTimeouts.delete(taskId);
    }
  }

  _clearLeaderEventTimer() {
    if (this._leaderEventTimer) {
      clearTimeout(this._leaderEventTimer);
      this._leaderEventTimer = null;
    }
  }

  /**
   * Queue pump: unwrap the HTTP entity, optionally build a task-mode prompt,
   * and send to the agent only after the previous task has completed.
   */
  _pumpQueue() {
    if (this.busy) return;
    if (!this.ptyProcess) return;
    if (this._recoveryPending) return;
    if (this.inboundQueue.length === 0) return;

    // Filter out any items that became dirty after enqueue.
    this.inboundQueue = this._filterDirtyTasks(this.inboundQueue);
    if (this.inboundQueue.length === 0) return;

    const item = this.inboundQueue.shift();
    const unwrapped = unwrapInbound(item);
    let prompt = unwrapped.prompt;

    // Leader decision event: build a dedicated leader prompt.
    if (item.type === "leader_event") {
      const ev = item.payload || {};
      const isUserConsult = ev.event_type === "user_consultation";
      const neighbors = Array.from(this.neighbors.values());
      // Every leader event needs its own event task_id in the prompt so the
      // OpenCode completion detector can locate the session by "Task ID: ...".
      const leaderTaskIdLine = `Task ID: ${unwrapped.task_id}\n\n`;
      // For user-initiated consultations, embed the user's text and all
      // agent cards so the leader can make informed decisions.
      if (isUserConsult) {
        prompt = `[Leader Decision Mode - User Consultation]\n\n` +
          leaderTaskIdLine +
          `User request:\n${ev.prompt || "(no input)"}\n\n` +
          `You are the LEADER. The user above is asking you to check the global state ` +
          `or allocate a new task. Review the available agents and task logs below.\n\n` +
          `Log URLs\n${neighbors.map(n => `${n.base_url}/v1/tasks`).join('\n')}\n\n` +
          `All available agents:\n` +
          neighbors.map(n => {
            const caps = Array.isArray(n.capabilities) && n.capabilities.length
              ? n.capabilities.join(", ") : (n.mode || "unknown");
            return `- ${n.agent_id} @ ${n.base_url} [${caps}]${n.description ? ` — ${n.description}` : ""}`;
          }).join("\n") + "\n\n" +
          `LEADER RULES (you are the LEADER, not a worker):\n` +
          `- You are NOT a task executor. You allocate tasks to other agents.\n` +
          `- ONE TASK RULE (most important): if the user's need can be satisfied by ONE task description plus per-round replies, create exactly ONE task. Do NOT create a new task per round/turn. Example: "agents take turns counting 1..10" should be ONE task where each agent forwards the SAME task_id to the next agent after replying.\n` +
          `- When creating a task, "to_agent_id" MUST be one of the other agents (NOT yourself, NOT "host-a").\n` +
          `- The task description MUST tell the worker: reply with your contribution, then forward the SAME task_id to the next agent (use action "forward"), and only the last agent uses "complete". Do NOT tell workers to forward back to you.\n` +
          `- Do NOT create follow-up tasks unless the worker reports a failure that requires a genuinely new task.\n\n` +
          `Unless it is NECESSARY, do NOT create any new task. Keep silent.\n\n` +
          buildRoutingInstructions();
      } else {
        prompt =
          leaderTaskIdLine +
          buildLeaderDecisionPrompt({
            event_type: ev.event_type || "unknown",
            task: ev.task || null,
            reason: ev.reason || "",
            agents: ev.agents || neighbors,
            logUrls: ev.log_urls || [],
            neighbors,
          });
      }
    } else if (this.mode === "task" && item.type !== "minimal") {
      const prepared = this._prepareTaskPrompt(item, unwrapped);
      if (prepared.terminated) {
        // Max hops/rounds exceeded: do not send to the agent.
        this._broadcastStatus();
        this._pumpQueue();
        return;
      }
      prompt = prepared.prompt;
    } else {
      // Minimal mode: keep the original prompt but append known neighbors.
      prompt = buildAgentPrompt({
        mode: "minimal",
        neighbors: Array.from(this.neighbors.values()),
        rawPrompt: unwrapped.prompt,
      });
    }

    // Start timeout if the task has a timeout_ms configured.
    // Leader decision events are not tasks and should not timeout.
    if (item.type !== "leader_event") {
      const itemTimeout = item.payload?.context?.timeout_ms || this.taskTimeoutMs || 0;
      if (itemTimeout > 0) {
        this._startTaskTimeout(unwrapped.task_id, itemTimeout);
      }
    }

    this.busy = true;
    this.currentTask = {
      inboundItem: item,
      unwrapped,
      task_id: unwrapped.task_id,
      prompt,
      outputBuffer: "",
      started_at: new Date().toISOString(),
    };

    this._submitPrompt(prompt);

    this._startCompletionDetector(this.currentTask);

    // Safety net for leader decision events: the opencode detector may not
    // fire for every leader-event (session matching etc). Force-complete after
    // 30s so the queue can never deadlock. Empty output is treated as silent.
    if (item.type === "leader_event") {
      this._clearLeaderEventTimer();
      const taskId = unwrapped.task_id;
      this._leaderEventTimer = setTimeout(() => {
        if (this.currentTask && this.currentTask.task_id === taskId && this.busy) {
          if (process.stdout.isTTY) {
            console.warn(`[AgentHost] leader event ${taskId} force-completed after 30s`);
          }
          this.completeCurrentTask();
        }
      }, 30000);
      if (this._leaderEventTimer.unref) this._leaderEventTimer.unref();
    }

    this._broadcastStatus();
  }

  /**
   * Submit text and Enter as two PTY writes. Full-screen CLIs such as Claude
   * Code may treat a large single write as a paste and consume the trailing
   * CR as part of that paste, leaving text visible but not submitted.
   */
  _submitPrompt(prompt) {
    if (!this.ptyProcess) return;
    const text = String(prompt || "").replace(/[\r\n]+$/, "");
    const provider = this.completionProvider && this.completionProvider !== "auto"
      ? this.completionProvider
      : detectProviderFromCommand(this.command);
    // Claude Code's Ink TUI must receive a multi-line prompt as one terminal
    // paste transaction. Ordinary LF bytes are interpreted as navigation/input
    // events, which previously left only the last fragment (for example “回复”)
    // in Claude's composer.
    const payload = provider === "claude"
      ? `\x1b[200~${text}\x1b[201~`
      : text;
    this.ptyProcess.write(payload);
    // Enter remains its own write, but it only needs a short event-loop turn
    // after the bracketed-paste terminator; it is not a 220ms timing heuristic.
    const submitDelayMs = provider === "claude" ? 25 : 80;
    setTimeout(() => {
      if (this.ptyProcess && this.currentTask) this.ptyProcess.write("\r");
    }, submitDelayMs);
  }

  /**
   * In task mode, ensure the Task record exists, update counters, and build
   * the prompt that is sent to the agent.
   */
  _prepareTaskPrompt(item, unwrapped) {
    const taskId = unwrapped.task_id || item.task_id;
    const incoming = item.reply || {};
    let task = this.taskStore.get(taskId);
    if (!task) {
      task = this.taskStore.ensureTask({
        task_id: taskId,
        title: item.payload.title || "",
        description: unwrapped.prompt || item.payload.description || "",
        created_by: incoming.from || this.agentId,
        shared_store_url: incoming.task_origin
          ? `${incoming.task_origin}/v1/tasks/${taskId}/files`
          : `http://127.0.0.1:${this.actualPort || this.port}/v1/tasks/${taskId}/files`,
        max_hops: this.maxHops,
        max_rounds: this.maxRounds,
        participants: [],
      });
    }

    this.taskStore.addParticipant(taskId, this.agentId);
    task.round += 1;
    if (item.type === "handoff" || (task.current_owner && task.current_owner !== this.agentId)) {
      task.hops += 1;
    }
    task.current_owner = this.agentId;
    this.taskStore.update(taskId, {
      round: task.round,
      hops: task.hops,
      current_owner: this.agentId,
      participants: task.participants,
      visited_agents: task.visited_agents,
    });

    if (task.hops > task.max_hops || task.round > task.max_rounds) {
      const reason = `hops=${task.hops}, rounds=${task.round}`;
      this._terminateTask(task, "max_hops_exceeded", reason);
      if (item.reply?.url) {
        this._enqueueOutbound(
          wrapOutbound({
            type: "task_terminated",
            to: item.reply.url,
            request_id: item.reply.request_id,
            task_id: taskId,
            from: this.agentId,
            payload: {
              task_id: taskId,
              status: "max_hops_exceeded",
              reason,
            },
          })
        );
      }
      return { terminated: true };
    }

    const prompt = buildAgentPrompt({
      mode: "task",
      task,
      incoming: item,
      neighbors: Array.from(this.neighbors.values()),
      rawPrompt: unwrapped.prompt,
    });
    return { terminated: false, prompt };
  }

  /**
   * Build an outbound item and push it to the outbound queue, then pump.
   */
  _enqueueOutbound(outItem) {
    if (this._shouldPurgeTask(outItem?.task_id)) return null;
    this.outboundQueue.push(outItem);
    this._schedulePersist();
    this._broadcastStatus();
    this._pumpOutbound();
    return outItem;
  }

  /**
   * Send pending outbound items to their callback URLs with retry/backoff.
   */
  async _pumpOutbound() {
    if (this._outboundSending) return;
    this._outboundSending = true;
    let hasWaiting = false;
    try {
      for (const item of this.outboundQueue) {
        if (item.status !== "pending" || !item.to) continue;
        // If a retry is scheduled in the future, skip and leave it pending.
        if (item.next_retry_at && Date.now() < item.next_retry_at) {
          hasWaiting = true;
          continue;
        }
        try {
          // Use item.headers when provided (task forward/create), otherwise
          // build the standard reply headers (backward compatible).
          const request = item.headers
            ? { url: item.to, headers: item.headers, body: item.payload }
            : buildReplyHttpRequest(
                {
                  url: item.to,
                  request_id: item.request_id,
                  from: item.from || this.agentId,
                },
                item.payload
              );
          const res = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
          });
          if (res.ok) {
            item.status = "sent";
            item.sent_at = new Date().toISOString();
          } else {
            this._scheduleOutboundRetry(item, `HTTP ${res.status}`);
            if (item.status === "pending") hasWaiting = true;
          }
        } catch (err) {
          this._scheduleOutboundRetry(item, err.message);
          if (item.status === "pending") hasWaiting = true;
        }
      }
      // Remove sent items from the visible queue (keep failed for inspection).
      this.outboundQueue = this.outboundQueue.filter((i) => i.status !== "sent");
      this._schedulePersist();
      // If some item is waiting for its next retry, wake us up when it can retry.
      if (hasWaiting) {
        const next = this.outboundQueue
          .filter((i) => i.status === "pending" && i.next_retry_at)
          .map((i) => i.next_retry_at);
        if (next.length > 0) {
          const waitMs = Math.max(0, Math.min(...next) - Date.now());
          if (this._outboundTimer) clearTimeout(this._outboundTimer);
          this._outboundTimer = setTimeout(() => this._pumpOutbound(), waitMs + 10);
          if (this._outboundTimer.unref) this._outboundTimer.unref();
        }
      }
    } finally {
      this._outboundSending = false;
      this._broadcastStatus();
    }
  }

  _scheduleOutboundRetry(item, error) {
    const maxRetries = 5;
    item.retries = (item.retries || 0) + 1;
    if (item.retries > maxRetries) {
      item.status = "failed";
      item.error = error;
      // After exhausting retries, treat the task as failed and tell Master,
      // so the whole collaboration can stop waiting for this callback.
      if (item.task_id && !this._shouldPurgeTask(item.task_id)) {
        const task = this.taskStore.get(item.task_id);
        if (task) {
          this._terminateTask(task, "failed", `callback_failed: ${error}`);
        } else {
          this._reportTaskToMaster(item.task_id, "failed");
          this._notifyMasterTaskTerminated(item.task_id, "failed", `callback_failed: ${error}`);
        }
      }
      return;
    }
    item.status = "pending";
    item.next_retry_at = Date.now() + Math.min(30000, 1000 * 2 ** (item.retries - 1));
    item.error = `retry #${item.retries}: ${error}`;
  }

  /**
   * Mark the current task as complete and push the appropriate outbound reply.
   * @param {string} [cleanOutput] Optional clean output from a CompletionDetector.
   */
  completeCurrentTask(cleanOutput) {
    if (!this.currentTask) return null;

    this._clearLeaderEventTimer();
    this._stopCompletionDetector();

    const isCleanOutput =
      typeof cleanOutput === "string" && cleanOutput.trim();
    const output = isCleanOutput
      ? cleanOutput
      : sanitizeTerminalOutput(this.currentTask.outputBuffer);
    const item = this.currentTask.inboundItem;
    const taskId = this.currentTask.task_id;
    const reply = this.currentTask.unwrapped?.reply || item?.reply || null;

    // Leader decision event: no regular task, only create/silent is allowed.
    if (item?.type === "leader_event") {
      const envelope = parseAgentReply(output) || { action: "silent", content: "" };
      const clean = extractAgentReplyContent(output).trim();
      if (envelope.action === "create") {
        this._handleAgentCreate(envelope, null);
      }
      this.currentTask = null;
      this.busy = false;
      this._broadcastStatus();
      this._pumpQueue();
      return { task_id: taskId, output: clean, completed_at: new Date().toISOString() };
    }

    // Task-mode completion/update.
    if (this.mode === "task" && taskId && item?.type !== "minimal") {
      const task = this.taskStore.get(taskId);
      if (task) {
        const clean = output.replace(new RegExp(TASK_OVER_MARKER, "g"), "").trim();
        const envelope = parseAgentReply(output);
        // A stale Claude session can contain an otherwise valid envelope for
        // a different task. `create` is the sole exception: it intentionally
        // names a new task. Never apply a mismatched complete/forward/silent
        // answer to the current task.
        if (envelope?.action !== "create" && envelope?.task_id && envelope.task_id !== taskId) {
          this.taskStore.appendHistory(taskId, {
            type: "ignored_mismatched_envelope",
            agent: this.agentId,
            expected_task_id: taskId,
            received_task_id: envelope.task_id,
          });
          this.currentTask = null;
          this.busy = false;
          this._broadcastStatus();
          this._pumpQueue();
          return { task_id: taskId, output: "", ignored: "mismatched_task_id" };
        }
        // Resolve the human-readable content. When an envelope is present we
        // must NEVER fall back to the raw text, because that still contains
        // the envelope JSON. Prefer the envelope's own content, then any
        // prose the agent wrote outside the envelope.
        const outsideText = extractAgentReplyContent(clean).trim();
        const visibleContent = envelope
          ? envelope.content || outsideText
          : clean;

        const question =
          this.currentTask?.unwrapped?.prompt ||
          item.payload?.prompt ||
          task.description ||
          "";
        this._appendTaskLog(task, question, visibleContent, task.round).catch(() => {});
        this.taskStore.appendHistory(taskId, {
          type: "agent_reply",
          agent: this.agentId,
          content: visibleContent,
        });

        // No envelope: fall back to old behavior (reply to original requester).
        if (!envelope) {
          const over = isCleanOutput && containsTaskOverMarker(output);
          if (over) {
            this.taskStore.update(taskId, {
              status: "completed",
              latest_reply: { agent_id: this.agentId, content: clean, at: new Date().toISOString() },
              terminated_at: new Date().toISOString(),
            });
            const payload = {
              task_id: taskId,
              status: "completed",
              agent_id: this.agentId,
              final_output: clean,
              round: task.round,
              hops: task.hops,
            };
            if (reply?.url) {
              this._enqueueOutbound(
                wrapOutbound({
                  type: "task_reply",
                  to: reply.url,
                  request_id: reply.request_id,
                  task_id: taskId,
                  from: this.agentId,
                  payload,
                })
              );
            }
            this._reportTaskToMaster(task, "completed");
            this._notifyMasterTaskTerminated(taskId, "completed");
            this._markTaskDirty(taskId, "completed", "", { keepOutbound: true });
          } else {
            this.taskStore.update(taskId, {
              status: "active",
              latest_reply: { agent_id: this.agentId, content: clean, at: new Date().toISOString() },
            });
            const payload = {
              task_id: taskId,
              status: "active",
              agent_id: this.agentId,
              content: clean,
              round: task.round,
              hops: task.hops,
            };
            if (reply?.url) {
              this._enqueueOutbound(
                wrapOutbound({
                  type: "task_reply",
                  to: reply.url,
                  request_id: reply.request_id,
                  task_id: taskId,
                  from: this.agentId,
                  payload,
                })
              );
            }
          }
        } else {
          // Agent explicitly chose routing. visibleContent is envelope-free;
          // never fall back to `clean` here or the envelope JSON leaks onward.
          this._handleAgentRouting(task, item, envelope, reply, visibleContent);
        }
      }
    } else {
      // Minimal mode reply.
      if (reply?.url) {
        this._enqueueOutbound(
          wrapOutbound({
            type: "minimal_reply",
            to: reply.url,
            request_id: reply.request_id,
            task_id: taskId,
            from: this.agentId,
            payload: {
              task_id: taskId,
              status: "completed",
              agent_id: this.agentId,
              output,
            },
          })
        );
      }
    }

    const result = {
      task_id: taskId,
      output,
      completed_at: new Date().toISOString(),
    };
    this.currentTask = null;
    this.busy = false;

    this._broadcast({ type: "task_completed", task_id: taskId, output });
    this._broadcastStatus();
    this._pumpQueue();
    return result;
  }

  /**
   * Route an agent's reply according to its envelope.
   */
  _handleAgentRouting(task, item, envelope, reply, visibleContent) {
    const taskId = task.task_id;
    const action = envelope.action || "forward";
    // visibleContent is already envelope-free (see completeCurrentTask).
    const content = envelope.content || visibleContent || "";

    if (action === "silent") {
      // Agent chooses not to forward/create. The task stays active for others;
      // only record this reply as a note, do NOT end the task.
      if (task && !this._shouldPurgeTask(taskId)) {
        this.taskStore.update(taskId, {
          status: "active",
          latest_reply: { agent_id: this.agentId, content: content || "(silent)", at: new Date().toISOString() },
        });
        this._reportTaskToMaster(task, "active");
      }
      return;
    }

    if (action === "complete") {
      this.taskStore.update(taskId, {
        status: "completed",
        latest_reply: { agent_id: this.agentId, content, at: new Date().toISOString() },
        terminated_at: new Date().toISOString(),
      });
      const payload = {
        task_id: taskId,
        status: "completed",
        agent_id: this.agentId,
        final_output: content,
        round: task.round,
        hops: task.hops,
      };
      // Send final output to explicit target if given, otherwise to original reply.
      const target = envelope.to_agent_id ? this.neighbors.get(envelope.to_agent_id) : null;
      if (target) {
        this._enqueueOutbound(
          wrapOutbound({
            type: "task_reply",
            to: `${target.base_url.replace(/\/$/, "")}/v1/tasks/${encodeURIComponent(taskId)}/reply`,
            request_id: reply?.request_id || null,
            task_id: taskId,
            from: this.agentId,
            payload,
          })
        );
      } else if (reply?.url) {
        this._enqueueOutbound(
          wrapOutbound({
            type: "task_reply",
            to: reply.url,
            request_id: reply.request_id,
            task_id: taskId,
            from: this.agentId,
            payload,
          })
        );
      }
      this._reportTaskToMaster(task, "completed");
      this._notifyMasterTaskTerminated(taskId, "completed");
      this._markTaskDirty(taskId, "completed", "", { keepOutbound: true });
      return;
    }

    if (action === "create") {
      this._handleAgentCreate(envelope, task, { reply, task, content });
      return;
    }

    // action === "forward"
    const target = envelope.to_agent_id
      ? this.neighbors.get(envelope.to_agent_id)
      : null;
    // `forward` continues this task by definition. New work must use the
    // explicit `create` action; accepting a new ID here would fork history
    // while leaving the original task active.
    const targetTaskId = taskId;
    if (target) {
      this._sendForwardTask(target, targetTaskId, content, {
        title: envelope.title || task.title || "",
        description: envelope.description || content,
        originBaseUrl: this._taskOriginBaseUrl(task) || null,
        replyTo: this._taskOriginReplyUrl(task, targetTaskId) || reply?.url || null,
        timeoutMs: this.taskTimeoutMs || undefined,
      });
      // Keep current task active (forwarded, not finished).
      this.taskStore.update(taskId, {
        status: "active",
        latest_reply: { agent_id: this.agentId, content, at: new Date().toISOString() },
        current_owner: target.agent_id,
      });
    } else {
      // No explicit target: fall back to original requester.
      if (reply?.url) {
        this._enqueueOutbound(
          wrapOutbound({
            type: "task_reply",
            to: reply.url,
            request_id: reply.request_id,
            task_id: taskId,
            from: this.agentId,
            payload: {
              task_id: taskId,
              status: "active",
              agent_id: this.agentId,
              content,
              round: task.round,
              hops: task.hops,
            },
          })
        );
        this.taskStore.update(taskId, {
          status: "active",
          latest_reply: { agent_id: this.agentId, content, at: new Date().toISOString() },
        });
      }
    }
  }

  /**
   * Handle "create" action: create a new task to a neighbor.
   */
  _handleAgentCreate(envelope, currentTask, ctx = {}) {
    const target = envelope.to_agent_id ? this.neighbors.get(envelope.to_agent_id) : null;
    if (!target) {
      if (process.stdout.isTTY) {
        console.warn(`[AgentHost] create action missing valid to_agent_id: ${envelope.to_agent_id}`);
      }
      return;
    }
    if (ctx.task && envelope.task_id === ctx.task.task_id) {
      if (process.stdout.isTTY) {
        console.warn(`[AgentHost] create action reused current task_id: ${envelope.task_id}`);
      }
      return;
    }
    const newTaskId = envelope.task_id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const content = envelope.content || "";
    // A newly created task is authored by this host, so it is the origin
    // (holds the authoritative task log). It does NOT inherit the old origin.
    const originBaseUrl = null;
    const replyTo = `${this._selfBaseUrl()}/v1/tasks/${newTaskId}/reply`;

    // Create authoritative local task record for log/files endpoints.
    const newTask = this.taskStore.ensureTask({
      task_id: newTaskId,
      title: envelope.title || "",
      description: envelope.description || content,
      created_by: this.agentId,
      current_owner: this.agentId,
      participants: [this.agentId],
      shared_store_url: `${this._selfBaseUrl()}/v1/tasks/${newTaskId}/files`,
      max_hops: this.maxHops,
      max_rounds: this.maxRounds,
    });
    this._reportTaskToMaster(newTask);

    this._sendForwardTask(target, newTaskId, content, {
      title: envelope.title || "",
      description: envelope.description || content,
      originBaseUrl,
      replyTo,
      timeoutMs: this.taskTimeoutMs || undefined,
    });

    // If end_current, complete the current task.
    if (ctx.task && envelope.end_current) {
      this.taskStore.update(ctx.task.task_id, {
        status: "completed",
        latest_reply: { agent_id: this.agentId, content, at: new Date().toISOString() },
        terminated_at: new Date().toISOString(),
      });
      this._reportTaskToMaster(ctx.task, "completed");
      this._notifyMasterTaskTerminated(ctx.task.task_id, "completed");
      this._markTaskDirty(ctx.task.task_id, "completed");
    }
  }

  _sendForwardTask(target, taskId, prompt, { title = "", description = "", originBaseUrl = null, replyTo = null, timeoutMs = 0 } = {}) {
    const request = buildOutboundTaskRequest({
      from: this.agentId,
      replyTo: replyTo || `${this._selfBaseUrl()}/v1/tasks/${encodeURIComponent(taskId)}/reply`,
      taskOrigin: originBaseUrl || this._selfBaseUrl(),
      taskId,
      title,
      description,
      prompt,
      timeoutMs,
    });
    this._enqueueOutbound(
      wrapOutbound({
        type: "task_forward",
        to: `${target.base_url.replace(/\/$/, "")}/v1/tasks`,
        request_id: request.headers["X-Request-Id"],
        task_id: taskId,
        from: this.agentId,
        payload: request.body,
        headers: request.headers,
      })
    );
    this._reportTaskToMaster({
      task_id: taskId,
      title,
      description,
      created_by: originBaseUrl ? null : this.agentId,
      current_owner: target.agent_id,
      participants: [this.agentId, target.agent_id],
    });
  }

  _taskOriginBaseUrl(task) {
    const shared = task?.shared_store_url || "";
    const m = shared.match(/^(https?:\/\/[^/]+)/);
    return m ? m[1] : null;
  }

  _taskOriginReplyUrl(task, taskId) {
    const base = this._taskOriginBaseUrl(task) || this._selfBaseUrl();
    return `${base}/v1/tasks/${encodeURIComponent(taskId)}/reply`;
  }

  _selfBaseUrl() {
    return `http://127.0.0.1:${this.actualPort || this.port}`;
  }

  /**
   * Mark a task as terminated (over / failed / max_hops_exceeded) and notify.
   */
  _terminateTask(task, status, reason) {
    this.taskStore.update(task.task_id, {
      status,
      terminated_at: new Date().toISOString(),
      latest_reply: {
        agent_id: this.agentId,
        content: reason || "",
        at: new Date().toISOString(),
      },
    });
    this._markTaskDirty(task.task_id, status, reason);
    this._reportTaskToMaster(task, status, reason);
    this._notifyMasterTaskTerminated(task.task_id, status, reason);
  }

  /**
   * Report task to Master's global task index (so Master can broadcast to all).
   */
  _reportTaskToMaster(task, status, reason) {
    const taskId = task?.task_id || (typeof task === "string" ? task : null);
    if (!taskId || !this.centerUrl) return;
    const realTask = typeof task === "object"
      ? task
      : this.taskStore.get(taskId) || {
          task_id: taskId,
          title: "",
          description: "",
          created_by: null,
          current_owner: this.agentId,
          participants: [this.agentId],
        };
    const payload = {
      task_id: taskId,
      title: realTask.title || "",
      description: realTask.description || "",
      status: status || realTask.status || "active",
      created_by: realTask.created_by || this.agentId,
      current_owner: realTask.current_owner || this.agentId,
      participants: realTask.participants || [],
    };
    fetch(`${this.centerUrl.replace(/\/$/, "")}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-From": this.agentId },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  /**
   * Tell Master: this task is finished. Master will broadcast to all hosts.
   * This replaces the old P2P multicast approach with a central broadcast.
   */
  _notifyMasterTaskTerminated(taskId, status, reason) {
    if (!this.centerUrl) return;
    fetch(`${this.centerUrl.replace(/\/$/, "")}/v1/tasks/${encodeURIComponent(taskId)}/terminated`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-From": this.agentId },
      body: JSON.stringify({
        task_id: taskId,
        status: status || "completed",
        reason: reason || "",
        agent_id: this.agentId,
      }),
    }).catch(() => {});
  }

  /**
   * Handle a task-terminated broadcast from Master.
   * Master tells us: this task_id is done, purge it.
   */
  _handleTaskTerminatedEvent(taskId, status, reason) {
    this._markTaskDirty(taskId, status || "failed", reason || "broadcast from master");
  }

  /**
   * Create a task locally (as origin) and send it to a neighbor AgentHost.
   * Also report the task to Master so the global index is up to date.
   */
  async _sendTaskToNeighbor(neighborId, { task_id, title, description, prompt }) {
    const neighbor = this.neighbors.get(neighborId);
    if (!neighbor) {
      throw new Error(`unknown neighbor: ${neighborId}`);
    }
    const taskId =
      task_id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const origin = `http://127.0.0.1:${this.actualPort}`;
    const task = this.taskStore.ensureTask({
      task_id: taskId,
      title: title || "",
      description: description || prompt || "",
      created_by: this.agentId,
      shared_store_url: `${origin}/v1/tasks/${taskId}/files`,
      max_hops: this.maxHops,
      max_rounds: this.maxRounds,
      participants: [this.agentId],
    });

    // Report to Master immediately so it knows this task exists.
    this._reportTaskToMaster(task);

    const request = buildOutboundTaskRequest({
      from: this.agentId,
      replyTo: `${origin}/v1/tasks/${taskId}/reply`,
      taskOrigin: origin,
      taskId,
      title,
      description,
      prompt,
      timeoutMs: this.taskTimeoutMs || undefined,
    });

    const res = await fetch(
      `${neighbor.base_url.replace(/\/$/, "")}/v1/tasks`,
      {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
      }
    );

    return {
      ok: res.ok,
      status: res.status,
      task_id: taskId,
      task,
    };
  }

  /**
   * Persist a completed Q&A turn to the task creator's shared log.
   *
   * If this AgentHost is the task origin, write to local log directly.
   * Otherwise call the origin host's `POST /v1/tasks/:id/log`.
   * On lock conflict (HTTP 423 / locked=true), retry a few times.
   */
  async _appendTaskLog(task, question, answer, round) {
    if (!task?.task_id) return;
    const taskId = task.task_id;
    const shared = task.shared_store_url || "";
    const logUrl = shared.replace(/\/files$/, "/log");
    if (!logUrl) return;

    const isOrigin = task.created_by === this.agentId;
    const entry = {
      type: "qa",
      task_id: taskId,
      agent_id: this.agentId,
      round: round ?? task.round ?? null,
      question: question || null,
      answer: answer || null,
    };

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (isOrigin) {
        const result = this.taskStore.appendLogEntry(taskId, entry);
        if (!result.locked) return;
      } else {
        try {
          const res = await fetch(logUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(entry),
          });
          if (res.status === 423) {
            // 并发读写：稍后重试
            await delay(1000);
            continue;
          }
          if (!res.ok && process.stdout.isTTY) {
            console.warn(`[AgentHost] task log write failed: HTTP ${res.status}`);
          }
          return;
        } catch (err) {
          if (attempt === 3 && process.stdout.isTTY) {
            console.warn(`[AgentHost] task log write error: ${err.message}`);
          }
          await delay(500);
          continue;
        }
      }
      await delay(1000);
    }
  }

  _startCompletionDetector(task) {
    this._stopCompletionDetector();
    const configured = this.completionProvider;
    const provider =
      configured && configured !== "auto"
        ? configured
        : detectProviderFromCommand(this.command);
    const opts = { agentHost: this, ...(this.completionConfig || {}) };
    let detector = null;
    try {
      detector = createCompletionDetector(provider, opts);
    } catch (err) {
      if (process.stdout.isTTY) {
        console.warn(
          `[AgentHost] completion detector '${provider}' failed to load: ${err.message}; falling back to manual`
        );
      }
      detector = null;
    }
    if (detector) {
      this.completionDetector = detector;
      detector.start(task);
    }
  }

  _stopCompletionDetector() {
    if (this.completionDetector) {
      try {
        this.completionDetector.stop();
      } catch (_) {}
      this.completionDetector = null;
    }
  }

  /**
   * Start (or restart) the agent PTY process.
   */
  startAgent(command, cwd) {
    this._stopCompletionDetector();
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch (_) {}
      this.ptyProcess = null;
    }

    this.command = command;
    if (cwd) this.cwd = cwd;
    this.agentStartedAt = Date.now();
    this.currentTask = null;
    this.busy = false;
    this.agentAlive = true;

    const env = {
      ...this.env,
      TERM: this.env.TERM || "xterm-256color",
      COLORTERM: this.env.COLORTERM || "truecolor",
      FORCE_COLOR: "1",
    };

    if (process.platform === "win32") {
      if (this.terminalEnv === "wsl") {
        const args = [];
        if (this.wslDistro) args.push("-d", this.wslDistro);
        args.push("--cd", toWslPath(this.cwd), "bash", "-lic", `exec ${this.command}`);
        this.ptyProcess = pty.spawn("wsl.exe", args, {
          name: "xterm-256color",
          cols: this.lastKnownCols,
          rows: this.lastKnownRows,
          cwd: process.cwd(),
          env,
        });
      } else {
        // Native Windows session. pwsh is preferred when available, with
        // Windows PowerShell as the compatibility fallback.
        const shell = process.env.PSModulePath ? "powershell.exe" : "powershell.exe";
        this.ptyProcess = pty.spawn(shell, ["-NoExit", "-Command", this.command], {
          name: "xterm-256color",
          cols: this.lastKnownCols,
          rows: this.lastKnownRows,
          cwd: this.cwd,
          env,
        });
      }
    } else {
      // Unix: start an interactive login shell (like a real terminal) so the
      // user's normal shell rc files are loaded. Then "type" the agent startup
      // command into that shell. This is generic and does not hardcode bash,
      // .bashrc, or any specific PATH.
      const shell = os.userInfo().shell || "/bin/bash";
      this.ptyProcess = pty.spawn(shell, ["-i"], {
        name: "xterm-256color",
        cols: this.lastKnownCols,
        rows: this.lastKnownRows,
        cwd: this.cwd,
        env,
      });
      setTimeout(() => {
        if (this.ptyProcess) {
          this.ptyProcess.write(this.command + "\r");
        }
      }, 150);
    }

    this.ptyProcess.onData((data) => {
      if (process.stdout.isTTY) {
        process.stdout.write(data);
      }
      this._handleAgentOutput(data);
    });

    this.ptyProcess.onExit(({ exitCode, signal }) => {
      this._broadcast({ type: "exit", exitCode, signal });
      if (process.stdout.isTTY) {
        console.log(`\n[AgentHost] agent process exited (${exitCode})`);
      }
      this.ptyProcess = null;
      this.agentAlive = false;
      // If a task was in progress when the agent died, put it back at the
      // front of the inbound queue so it is not silently lost.
      if (this.currentTask?.inboundItem) {
        this.inboundQueue.unshift(this.currentTask.inboundItem);
      }
      this.currentTask = null;
      this.busy = false;
      this._broadcastStatus();
      this._pumpQueue();
    });

    this._broadcast({ type: "agent_started", command: this.command, cwd: this.cwd });
    this._schedulePersist();
    this._broadcastStatus();
    this._pumpQueue();
  }

  _handleAgentOutput(data) {
    this._broadcast({ type: "output", data });

    // If the current task has an expect_marker and we saw it in the output,
    // treat the task as completed. This is a simple completion signal for
    // testing; real agents can also use POST /complete or the UI button.
    if (this.currentTask && this.currentTask.expect_marker) {
      this.currentTask.outputBuffer += data;
      if (this.currentTask.outputBuffer.includes(this.currentTask.expect_marker)) {
        this.completeCurrentTask();
      }
    } else if (this.currentTask) {
      this.currentTask.outputBuffer += data;
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.app);
      this.wss = new WebSocket.Server({ server: this.server, path: "/ws" });

      this.wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.send(
          JSON.stringify({
            type: "ready",
            agentId: this.agentId,
            cols: this.ptyProcess ? this.ptyProcess.cols : 120,
            rows: this.ptyProcess ? this.ptyProcess.rows : 30,
            status: this.getStatus(),
          })
        );

        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            this._handleClientMessage(ws, msg);
          } catch (_) {
            // ignore malformed messages
          }
        });

        ws.on("close", () => {
          this.clients.delete(ws);
        });
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        this.actualPort = this.server.address().port;
        if (this.centerUrl) {
          this.sendRegistrationRequest(this.centerUrl);
        }
        resolve(this.actualPort);
      });

      this.server.on("error", reject);
    });
  }

  _handleClientMessage(ws, msg) {
    switch (msg.type) {
      case "input":
        // Direct terminal input, bypasses the queue.
        if (typeof msg.data === "string") {
          this.write(msg.data);
        }
        break;
      case "enqueue":
        if (typeof msg.prompt === "string" && msg.prompt.trim()) {
          const request = createLocalRequest({
            prompt: msg.prompt,
            task_id: msg.task_id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            from: msg.from || this.agentId,
            reply_to: msg.reply_to,
            request_id: msg.request_id,
            // `enqueue` is the WebSocket event name, not a protocol type.
            // A local prompt is deliberately minimal and must not be wrapped
            // as an inter-agent task-mode message.
            type: "minimal",
          });
          const item = wrapInbound({
            type: request.type,
            task_id: request.task_id,
            payload: request.payload,
            reply: {
              url: request.reply_to,
              request_id: request.request_id,
              from: request.from,
              task_origin: request.task_origin,
            },
          });
          this.enqueueInbound(item);
        }
        break;
      case "complete":
        this.completeCurrentTask();
        break;
      case "start":
        if (typeof msg.command === "string" && msg.command.trim()) {
          if (msg.completionProvider) this.completionProvider = msg.completionProvider;
          if (msg.completionConfig) this.completionConfig = msg.completionConfig;
          if (msg.terminalEnv === "native" || msg.terminalEnv === "wsl") this.terminalEnv = msg.terminalEnv;
          if (typeof msg.wslDistro === "string") this.wslDistro = msg.wslDistro.trim();
          this.startAgent(msg.command, msg.cwd);
          this.openObservationTerminal();
        }
        break;
      case "resize":
        if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          this.lastKnownCols = msg.cols;
          this.lastKnownRows = msg.rows;
          if (this.ptyProcess) {
            this.ptyProcess.resize(msg.cols, msg.rows);
          }
        }
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
      default:
        break;
    }
  }

  _broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  _broadcastStatus() {
    this._broadcast({ type: "status", ...this.getQueueState(), ...this.getStatus() });
    this._schedulePersist();
  }

  _restoreHostState(opts = {}) {
    try {
      if (!fs.existsSync(this._stateFile)) return;
      const state = JSON.parse(fs.readFileSync(this._stateFile, "utf8"));
      if (!opts.command && state.command) this.command = state.command;
      if (!opts.cwd && state.cwd) this.cwd = state.cwd;
      if (!opts.mode && state.mode) this.mode = state.mode;
      if (!opts.maxHops && Number.isInteger(state.max_hops)) this.maxHops = state.max_hops;
      if (!opts.maxRounds && Number.isInteger(state.max_rounds)) this.maxRounds = state.max_rounds;
      if (!opts.taskTimeoutMs && Number.isInteger(state.timeout_ms)) this.taskTimeoutMs = state.timeout_ms;
      if (!opts.terminalEnv && state.terminal_env) this.terminalEnv = state.terminal_env;
      if (!opts.wslDistro && state.wsl_distro) this.wslDistro = state.wsl_distro;
      if (!opts.centerUrl && state.center_url) this.centerUrl = state.center_url;
      if (!opts.completionProvider && state.completion_provider) this.completionProvider = state.completion_provider;
      if (!opts.completionConfig && state.completion_config) this.completionConfig = state.completion_config;
      if (Array.isArray(state.neighbors)) this.neighbors = new Map(state.neighbors.map((n) => [n.agent_id, n]));
      if (Array.isArray(state.inbound_queue)) this.inboundQueue = state.inbound_queue;
      if (state.current_task_item && !this.inboundQueue.some((item) => item.queue_id === state.current_task_item.queue_id)) {
        this.inboundQueue.unshift(state.current_task_item);
      }
      this.inboundQueue = this._filterDirtyTasks(this.inboundQueue);
      // Only hold recovery when there is actually restored work. Fresh hosts
      // can keep accepting tasks before registration finishes.
      this._recoveryPending = Boolean(this.centerUrl && this.inboundQueue.length > 0);
      if (Array.isArray(state.outbound_queue)) this.outboundQueue = state.outbound_queue;
      if (Array.isArray(state.dirty_task_ids)) this._dirtyTaskIds = new Set(state.dirty_task_ids);
      if (Array.isArray(state.seen_request_ids)) this._seenRequestIds = new Set(state.seen_request_ids.slice(-5000));
    } catch (err) {
      console.warn(`[AgentHost] failed to restore state: ${err.message}`);
    }
  }

  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistHostState();
    }, 120);
    this._persistTimer.unref?.();
  }

  _persistHostState() {
    try {
      const state = {
        version: 1,
        agent_id: this.agentId,
        command: this.command,
        cwd: this.cwd,
        terminal_env: this.terminalEnv,
        wsl_distro: this.wslDistro,
        center_url: this.centerUrl,
        mode: this.mode,
        max_hops: this.maxHops,
        max_rounds: this.maxRounds,
        timeout_ms: this.taskTimeoutMs,
        completion_provider: this.completionProvider,
        completion_config: this.completionConfig,
        neighbors: Array.from(this.neighbors.values()),
        inbound_queue: this.inboundQueue,
        current_task_item: this.currentTask?.inboundItem || null,
        outbound_queue: this.outboundQueue,
        dirty_task_ids: Array.from(this._dirtyTaskIds),
        seen_request_ids: Array.from(this._seenRequestIds).slice(-5000),
        saved_at: new Date().toISOString(),
      };
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      const temp = `${this._stateFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(temp, this._stateFile);
    } catch (err) {
      if (process.stdout.isTTY) console.warn(`[AgentHost] state persistence failed: ${err.message}`);
    }
  }

  sendRegistrationRequest(centerUrl) {
    if (!centerUrl) return;
    this._stopCenterTimers();
    this.centerUrl = String(centerUrl).trim().replace(/\/+$/, "");
    this.registrationId = null;
    this.centerStatus = { state: "pending", message: "已发送注册申请，等待 Master 审批" };
    this._broadcastStatus();

    const url = `${this.centerUrl}/v1/registrations`;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.getStatus()),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.registration) {
          this.registrationId = data.registration.id;
          this.centerStatus = { state: "pending", message: "等待 Master 审批" };
        } else {
          this.centerStatus = {
            state: "rejected",
            message: data.error || "注册申请失败",
          };
        }
        this._broadcastStatus();
        this._ensureRegistrationPolling();
      })
      .catch(() => {
        this.centerStatus = { state: "rejected", message: "无法连接 Master" };
        this._broadcastStatus();
      });
  }

  _ensureRegistrationPolling() {
    if (this.registrationPollTimer) return;
    this.registrationPollTimer = setInterval(() => this._pollRegistrationStatus(), 3000);
  }

  async _pollRegistrationStatus() {
    if (!this.centerUrl || !this.registrationId) return;
    try {
      const res = await fetch(
        `${this.centerUrl}/v1/registrations/${encodeURIComponent(this.registrationId)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const reg = data.registration;
      if (!reg) return;
      if (reg.status === "pending") {
        this.centerStatus = { state: "pending", message: "等待 Master 审批" };
      } else if (reg.status === "approved") {
        this.centerStatus = { state: "registered", message: "已注册" };
        await this._reconcileRecoveredTasks();
        this._startHeartbeat();
        this._startNeighborDiscovery();
      } else if (reg.status === "rejected") {
        this.centerStatus = { state: "rejected", message: "已被 Master 拒绝" };
        this._stopCenterTimers();
      }
      this._broadcastStatus();
    } catch (_) {
      // Master 暂时不可达，保留当前状态
    }
  }

  _registerWithCenter() {
    if (!this.centerUrl) return;
    // 兼容直接注册接口；正常流程走 sendRegistrationRequest。
    const url = `${this.centerUrl.replace(/\/$/, "")}/v1/agents/register`;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.getStatus()),
    })
      .then((res) => {
        if (!res.ok && process.stdout.isTTY) {
          console.warn(`[AgentHost] center register failed: HTTP ${res.status}`);
        }
      })
      .catch(() => {});
  }

  _startHeartbeat() {
    if (!this.centerUrl || this.heartbeatTimer) return;
    const baseUrl = `${this.centerUrl.replace(/\/$/, "")}`;
    const url = `${baseUrl}/v1/agents/${encodeURIComponent(
      this.agentId
    )}/heartbeat`;
    const send = () => {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.getStatus()),
      })
        .then(async (res) => {
          if (res.status === 404 && this.centerStatus?.state === "registered") {
            this.centerStatus = { state: "pending", message: "Master 丢失了我的注册，需重新审批" };
            this._broadcastStatus();
            return;
          }
          // Process tasks_to_remove from Master heartbeat response.
          const data = await res.json().catch(() => ({}));
          const agentData = data.agent || data;
          if (agentData.is_leader !== undefined && agentData.is_leader !== this.isLeader) {
            this.isLeader = Boolean(agentData.is_leader);
            this._broadcastStatus();
          }
          if (agentData.tasks_to_remove && Array.isArray(agentData.tasks_to_remove)) {
            for (const taskId of agentData.tasks_to_remove) {
              this._handleTaskTerminatedEvent(taskId, "completed", "removed by master");
            }
          }
        })
        .catch(() => {});
    };
    send();
    this.heartbeatTimer = setInterval(send, 5000);
  }

  /**
   * Before replaying persisted queue entries, ask Master whether any of them
   * became terminal while this Host was offline. Master is the global source
   * of truth for that window; local snapshots alone can be stale.
   */
  async _reconcileRecoveredTasks() {
    if (!this._recoveryPending) return;
    const taskIds = [...new Set(this.inboundQueue.map((item) => item?.task_id).filter(Boolean))];
    try {
      for (const taskId of taskIds) {
        try {
          const res = await fetch(`${this.centerUrl}/v1/tasks/${encodeURIComponent(taskId)}`);
          if (!res.ok) continue;
          const task = await res.json();
          if (["completed", "failed", "max_hops_exceeded", "canceled"].includes(task.status)) {
            this._handleTaskTerminatedEvent(taskId, task.status, task.termination_reason || "terminal while host offline");
          }
        } catch (_) {
          // A single unavailable record must not block recovery of all tasks.
        }
      }
    } finally {
      this._recoveryPending = false;
      this._broadcastStatus();
      this._pumpQueue();
    }
  }

  _startNeighborDiscovery() {
    if (!this.centerUrl || this.discoveryTimer) return;
    const run = () => this._discoverNeighbors();
    run();
    this.discoveryTimer = setInterval(run, 10000);
  }

  async _discoverNeighbors() {
    if (!this.centerUrl) return;
    try {
      const url = `${this.centerUrl.replace(/\/$/, "")}/v1/neighbors?agent_id=${encodeURIComponent(
        this.agentId
      )}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const discovered = data.neighbors || [];
      const next = new Map();
      for (const n of discovered) {
        if (n.agent_id && n.base_url) {
          next.set(n.agent_id, {
            agent_id: n.agent_id,
            base_url: n.base_url,
            description: n.description || "",
            capabilities: Array.isArray(n.capabilities) ? n.capabilities : [],
            mode: n.mode || "task",
          });
        }
      }
      const changed =
        next.size !== this.neighbors.size ||
        Array.from(next.keys()).some((k) => !this.neighbors.has(k));
      if (changed) {
        this.neighbors = next;
        this._broadcastStatus();
      }
    } catch (_) {
      // Master may be temporarily unavailable; keep current neighbors.
    }
  }

  _stopCenterTimers() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  _unregisterFromCenter() {
    if (!this.centerUrl) return;
    if (this.centerStatus?.state === "registered") {
      const url = `${this.centerUrl.replace(/\/$/, "")}/v1/agents/${encodeURIComponent(
        this.agentId
      )}`;
      fetch(url, { method: "DELETE" }).catch(() => {});
    }
    if (this.registrationId) {
      const url = `${this.centerUrl.replace(/\/$/, "")}/v1/registrations/${encodeURIComponent(
        this.registrationId
      )}`;
      fetch(url, { method: "DELETE" }).catch(() => {});
    }
  }

  getStatus() {
    return {
      agent_id: this.agentId,
      status: this.ptyProcess ? "running" : "stopped",
      agent_alive: Boolean(this.agentAlive && this.ptyProcess),
      center_status: this.centerStatus,
      center_url: this.centerUrl,
      pid: process.pid,
      pty_pid: this.ptyProcess ? this.ptyProcess.pid : null,
      port: this.actualPort,
      base_url: `http://127.0.0.1:${this.actualPort}`,
      command: this.command,
      cwd: this.cwd,
      mode: this.mode,
      max_hops: this.maxHops,
      max_rounds: this.maxRounds,
      timeout_ms: this.taskTimeoutMs,
      terminal_env: this.terminalEnv,
      wsl_distro: this.wslDistro,
      description: this.description,
      capabilities: this.capabilities,
      is_leader: this.isLeader,
      neighbor_count: this.neighbors.size,
      neighbors: Array.from(this.neighbors.values()),
      task_count: this.taskStore.list().length,
      completion_provider: this.completionProvider,
      completion_config: this.completionConfig,
      platform: process.platform,
      started_at: this.startedAt.toISOString(),
      uptime_sec: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
    };
  }

  getQueueState() {
    return {
      busy: this.busy,
      current_task: this.currentTask
        ? {
            task_id: this.currentTask.task_id,
            prompt: this.currentTask.prompt,
            started_at: this.currentTask.started_at,
            type: this.currentTask.inboundItem?.type,
          }
        : null,
      inbound_queue_length: this.inboundQueue.length,
      inbound_queue: this.inboundQueue.map((t) => ({
        queue_id: t.queue_id,
        type: t.type,
        task_id: t.task_id,
        prompt: t.payload?.prompt,
        reply: t.reply,
        queued_at: t.enqueued_at,
      })),
      outbound_queue_length: this.outboundQueue.length,
      outbound_queue: this.outboundQueue.slice(-20),
    };
  }

  write(data) {
    if (this.ptyProcess) {
      this.ptyProcess.write(data);
    }
  }

  async openObservationTerminal() {
    if (!this.actualPort || !this.openTerminal) return;
    const url = `ws://127.0.0.1:${this.actualPort}/ws`;
    try {
      await openTerminalViewer(url);
      if (process.stdout.isTTY) {
        console.log(`[AgentHost] opened observation terminal -> ${url}`);
      }
    } catch (err) {
      if (process.stdout.isTTY) {
        console.warn(`[AgentHost] failed to open observation terminal: ${err.message}`);
      }
    }
  }

  async stop() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = null;
    this._persistHostState();
    this._stopCompletionDetector();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.registrationPollTimer) clearInterval(this.registrationPollTimer);
    if (this._outboundTimer) clearTimeout(this._outboundTimer);
    this._outboundTimer = null;
    this._clearLeaderEventTimer();
    // Clear all task timeout timers.
    for (const timer of this._taskTimeouts.values()) clearTimeout(timer);
    this._taskTimeouts.clear();
    this._unregisterFromCenter();
    if (this.ptyProcess) {
      try {
        this.ptyProcess.kill();
      } catch (_) {}
    }
    if (this.wss) {
      for (const ws of this.clients) {
        try {
          ws.close();
        } catch (_) {}
      }
      this.wss.close();
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }
}

module.exports = { AgentHost, toWslPath };
