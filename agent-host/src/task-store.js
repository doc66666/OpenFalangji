"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * TaskStore keeps authoritative/participant task records and per-task shared
 * files. In the hybrid model, the task creator's AgentHost is authoritative;
 * other hosts keep a local participation record.
 */
class TaskStore {
  constructor(opts = {}) {
    this.tasks = new Map();
    this.root = opts.root || path.join(os.homedir(), ".agent-host", "tasks");
    fs.mkdirSync(this.root, { recursive: true });
    this.logLocks = new Map(); // taskId -> { readers, writing }
    this._loadTasks();
  }

  _taskDir(taskId) {
    return path.join(this.root, String(taskId).replace(/[^a-zA-Z0-9_-]/g, "_"));
  }

  _historyFile(taskId) {
    return path.join(this._taskDir(taskId), "history.jsonl");
  }

  _logFile(taskId) {
    return path.join(this._taskDir(taskId), "log.jsonl");
  }

  _sharedDir(taskId) {
    return path.join(this._taskDir(taskId), "shared");
  }

  _taskStateFile(taskId) {
    return path.join(this._taskDir(taskId), "task.json");
  }

  _loadTasks() {
    try {
      for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(this.root, entry.name, "task.json");
        if (!fs.existsSync(file)) continue;
        try {
          const task = JSON.parse(fs.readFileSync(file, "utf8"));
          if (task && task.task_id) this.tasks.set(task.task_id, task);
        } catch (_) {
          // Ignore a single damaged task snapshot; JSONL history remains intact.
        }
      }
    } catch (_) {}
  }

  _persistTask(task) {
    if (!task?.task_id) return;
    try {
      const dir = this._taskDir(task.task_id);
      fs.mkdirSync(dir, { recursive: true });
      const file = this._taskStateFile(task.task_id);
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(task, null, 2), "utf8");
      fs.renameSync(temp, file);
    } catch (_) {
      // Snapshot persistence is best-effort; execution should keep running.
    }
  }

  ensureTask(task) {
    const existing = this.tasks.get(task.task_id);
    if (existing) return existing;
    const record = {
      task_id: task.task_id,
      title: task.title || "",
      description: task.description || "",
      status: task.status || "active",
      current_owner: task.current_owner || null,
      participants: task.participants || [],
      round: task.round || 0,
      max_rounds: task.max_rounds || 10,
      hops: task.hops || 0,
      max_hops: task.max_hops || 5,
      visited_agents: task.visited_agents || [],
      latest_reply: task.latest_reply || null,
      history: task.history || [],
      shared_store_url: task.shared_store_url || null,
      created_by: task.created_by || null,
      created_at: task.created_at || new Date().toISOString(),
      terminated_at: task.terminated_at || null,
    };
    this.tasks.set(task.task_id, record);
    fs.mkdirSync(this._sharedDir(task.task_id), { recursive: true });
    this._appendHistory(task.task_id, { type: "task_created", record });
    this._persistTask(record);
    return record;
  }

  get(taskId) {
    return this.tasks.get(taskId) || null;
  }

  list() {
    return Array.from(this.tasks.values());
  }

  update(taskId, patch) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    Object.assign(task, patch);
    this._appendHistory(taskId, { type: "task_updated", patch });
    this._persistTask(task);
    return task;
  }

  appendHistory(taskId, entry) {
    this._appendHistory(taskId, entry);
  }

  _appendHistory(taskId, entry) {
    try {
      const dir = this._taskDir(taskId);
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
      fs.appendFileSync(this._historyFile(taskId), line + "\n", "utf8");
    } catch (_) {
      // history file is best-effort
    }
  }

  addParticipant(taskId, agentId) {
    const task = this.get(taskId);
    if (!task) return null;
    if (!task.participants.includes(agentId)) {
      task.participants.push(agentId);
    }
    if (!task.visited_agents.includes(agentId)) {
      task.visited_agents.push(agentId);
    }
    this._appendHistory(taskId, { type: "participant_added", agentId });
    this._persistTask(task);
    return task;
  }

  // ---- shared task log (Q&A) ----
  //
  // 读写锁：允许多个读者并发，写者独占；任一写者占用时读者直接返回锁定，
  // 有读者占用时写者也直接返回锁定。调用方收到 locked=true 时应返回
  // “并发读写，请重试”，避免长时间饥饿。

  _getLogLock(taskId) {
    let lock = this.logLocks.get(taskId);
    if (!lock) {
      lock = { readers: 0, writing: false };
      this.logLocks.set(taskId, lock);
    }
    return lock;
  }

  _tryReadLogLock(taskId) {
    const lock = this._getLogLock(taskId);
    if (lock.writing) return null;
    lock.readers += 1;
    return () => {
      lock.readers = Math.max(0, lock.readers - 1);
      if (lock.readers === 0 && !lock.writing) this.logLocks.delete(taskId);
    };
  }

  _tryWriteLogLock(taskId) {
    const lock = this._getLogLock(taskId);
    if (lock.writing || lock.readers > 0) return null;
    lock.writing = true;
    return () => {
      lock.writing = false;
      if (lock.readers === 0) this.logLocks.delete(taskId);
    };
  }

  readLogEntries(taskId) {
    const release = this._tryReadLogLock(taskId);
    if (!release) return { locked: true, entries: [] };
    try {
      const file = this._logFile(taskId);
      if (!fs.existsSync(file)) return { locked: false, entries: [] };
      const entries = [];
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          entries.push(JSON.parse(trimmed));
        } catch (_) {
          // skip malformed lines
        }
      }
      return { locked: false, entries };
    } finally {
      release();
    }
  }

  appendLogEntry(taskId, entry) {
    const release = this._tryWriteLogLock(taskId);
    if (!release) return { locked: true };
    try {
      const dir = this._taskDir(taskId);
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
      fs.appendFileSync(this._logFile(taskId), line + "\n", "utf8");
      return { locked: false };
    } finally {
      release();
    }
  }

  formatLogText(entries) {
    if (!entries || entries.length === 0) return "(empty task log)";
    return entries
      .map((e) => {
        const time = e.at || e.timestamp || "";
        const agent = e.agent_id || e.agent || "?";
        const role = e.role || e.type || "";
        if (e.question != null || e.answer != null) {
          const q = e.question != null ? `Q: ${e.question}` : "";
          const a = e.answer != null ? `A: ${e.answer}` : "";
          return `[${time}] ${agent} (${role}) ${q} ${a}`.trim();
        }
        const content = e.content || "";
        return `[${time}] ${agent} (${role}): ${content}`;
      })
      .join("\n");
  }

  // ---- shared files ----

  listFiles(taskId) {
    const dir = this._sharedDir(taskId);
    try {
      return fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
    } catch (_) {
      return [];
    }
  }

  writeFile(taskId, name, content) {
    const dir = this._sharedDir(taskId);
    fs.mkdirSync(dir, { recursive: true });
    const safe = path.basename(name);
    fs.writeFileSync(path.join(dir, safe), content);
    this._appendHistory(taskId, { type: "file_written", name: safe });
    return safe;
  }

  readFile(taskId, name) {
    const safe = path.basename(name);
    return fs.readFileSync(path.join(this._sharedDir(taskId), safe));
  }

  fileExists(taskId, name) {
    const safe = path.basename(name);
    return fs.existsSync(path.join(this._sharedDir(taskId), safe));
  }
}

module.exports = { TaskStore };
