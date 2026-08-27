"use strict";

/**
 * CompletionDetector interface.
 *
 * A CompletionDetector watches an agent's own conversation history/logs and
 * tells AgentHost when the current task has actually completed. This is more
 * reliable than parsing raw terminal output, especially for TUI agents.
 *
 * To add a new agent type:
 *   1. Create a class extending BaseCompletionDetector.
 *   2. Implement start(task), stop(), and the internal polling logic.
 *   3. Register it in COMPLETION_DETECTORS.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */

function walkFiles(dir, predicate, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        walkFiles(full, predicate, out);
      } else if (entry.isFile() && predicate(full)) {
        out.push(full);
      }
    } catch (_) {
      // ignore
    }
  }
  return out;
}

function readJsonLines(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (_) {
    return [];
  }
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (_) {
      // ignore malformed lines
    }
  }
  return entries;
}

function mtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (_) {
    return 0;
  }
}

function formatTool(name, input, output) {
  const inputStr =
    input && typeof input === "object"
      ? input.command || JSON.stringify(input)
      : input;
  if (output && output !== "(no output)") {
    return `[${name}] ${inputStr || ""}\n${output}`;
  }
  return `[${name}] ${inputStr || "(executed)"}`;
}

function encodeClaudeProjectCwd(cwd) {
  // Claude Code uses a path-safe project directory. On Windows `D:\\repo`
  // becomes `D--repo`, so normalize both the drive colon and every separator.
  return String(cwd || "").replace(/[:\\/]/g, "-");
}

function wslDistributionNames() {
  try {
    const raw = execFileSync("wsl.exe", ["-l", "-q"], { encoding: "buffer", timeout: 3000 });
    // wsl.exe commonly writes UTF-16LE on Windows, but some versions use UTF-8.
    const text = raw.includes(0) ? raw.toString("utf16le") : raw.toString("utf8");
    return text
      .split(/\r?\n/)
      .map((name) => name.replace(/\0/g, "").replace(/^\uFEFF/, "").trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function findWslOpenCodeDb(agentHost) {
  if (process.platform !== "win32" || agentHost?.terminalEnv !== "wsl") return null;
  const configured = String(agentHost.wslDistro || "").trim();
  const distros = configured ? [configured] : wslDistributionNames();
  for (const distro of distros) {
    const candidate = path.win32.join(
      "\\\\wsl.localhost",
      distro,
      "root",
      ".local",
      "share",
      "opencode",
      "opencode.db"
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function openCodeSessionPathCandidates(agentHost) {
  const cwd = String(agentHost?.cwd || process.cwd());
  const candidates = new Set([cwd, cwd.replace(/^\/+/, "")]);
  if (agentHost?.terminalEnv === "wsl") {
    const match = cwd.match(/^([a-zA-Z]):[\\/](.*)$/);
    if (match) {
      const wslPath = `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
      candidates.add(wslPath);
      candidates.add(wslPath.replace(/^\/+/, ""));
    }
  }
  return [...candidates].filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Base                                                               */
/* ------------------------------------------------------------------ */

class BaseCompletionDetector {
  constructor(opts) {
    this.agentHost = opts.agentHost;
    this.pollIntervalMs = opts.pollIntervalMs || 1000;
    this.timer = null;
    this.currentTask = null;
  }

  start(task) {
    this.currentTask = task;
    this._startPolling();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentTask = null;
  }

  _startPolling() {
    this.stop();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  poll() {}

  _finish(cleanOutput) {
    this.stop();
    this.agentHost.completeCurrentTask(cleanOutput);
  }

  _sentAt() {
    return this.currentTask?.sentAt || Date.now();
  }
}

/* ------------------------------------------------------------------ */
/* opencode                                                           */
/* ------------------------------------------------------------------ */

class OpenCodeDetector extends BaseCompletionDetector {
  constructor(opts) {
    super(opts);
    this.wslDbPath = !opts.dbPath ? findWslOpenCodeDb(opts.agentHost) : null;
    this.dbPath = opts.dbPath || this.wslDbPath || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
    this.snapshotDbPath = this.wslDbPath
      ? path.join(os.tmpdir(), `agent-host-${opts.agentHost?.agentId || "opencode"}-opencode.db`)
      : null;
    this.sessionId = null;
    this.sentAt = 0;
  }

  start(task) {
    super.start(task);
    this.sentAt = Date.now();
    this.taskId = task?.task_id || null;
    this.sessionId = null;
  }

  poll() {
    if (!this.sessionId) {
      this.sessionId = this._findSessionForTask();
      if (!this.sessionId) {
        // Session hasn't been persisted yet; retry next poll.
        return;
      }
    }

    let db;
    try {
      db = this._openDb();
      const rows = db
        .prepare(
          `SELECT id FROM message
           WHERE session_id = ? AND time_created > ?
             AND json_extract(data, '$.role') = 'assistant'
           ORDER BY time_created ASC`
        )
        .all(this.sessionId, this.sentAt);

      for (const row of rows) {
        // Only finish on a real assistant answer: must have a completed step,
        // contain actual text, and not be still waiting on a tool call.
        if (
          this._hasStepFinish(db, row.id) &&
          this._hasTextPart(db, row.id) &&
          !this._hasActiveTool(db, row.id)
        ) {
          const cleanText =
            this._getMessageText(db, row.id) || "[no text response]";
          this._finish(cleanText);
          return;
        }
      }

      // If no matching messages found after a reasonable wait, the sessionId
      // may be stale (picked up from a previous task). Reset it so the next
      // poll cycle searches again.
      if (Date.now() - this.sentAt > 30000 && rows.length === 0) {
        this.sessionId = null;
      }
    } catch (_) {
      // DB may be temporarily locked; ignore and retry.
    } finally {
      if (db) db.close();
    }
  }

  /**
   * Find the session that actually contains the current task's prompt.
   * This is more reliable than "latest session in cwd" when multiple agents
   * share the same working directory and the same opencode database.
   */
  _findSessionForTask() {
    if (!this.taskId) return null;
    let db;
    try {
      db = this._openDb();
      const cwdPaths = openCodeSessionPathCandidates(this.agentHost);
      const placeholders = cwdPaths.map(() => "?").join(", ");
      const needle = `Task ID: ${this.taskId}`;
      const row = db
        .prepare(
          `SELECT m.session_id AS sid, MAX(m.time_created) AS max_tc
           FROM message m
           JOIN part p ON p.message_id = m.id
           WHERE m.session_id IN (
              SELECT id FROM session WHERE directory IN (${placeholders}) OR path IN (${placeholders})
            )
            AND (instr(p.data, ?) > 0 OR instr(m.data, ?) > 0)
            GROUP BY m.session_id
           ORDER BY max_tc DESC
           LIMIT 1`
        )
        .get(...cwdPaths, ...cwdPaths, needle, needle);
      return row ? row.sid : null;
    } catch (_) {
      return null;
    } finally {
      if (db) db.close();
    }
  }

  _findActiveSession() {
    let db;
    try {
      db = this._openDb();
      const cwdPaths = openCodeSessionPathCandidates(this.agentHost);
      const placeholders = cwdPaths.map(() => "?").join(", ");
      const startedAt = this.agentHost.agentStartedAt || 0;
      const recent = db
        .prepare(
          `SELECT id FROM session
           WHERE (directory IN (${placeholders}) OR path IN (${placeholders}))
              AND time_created >= ?
            ORDER BY time_created DESC LIMIT 1`
        )
        .get(...cwdPaths, ...cwdPaths, startedAt - 5000);
      if (recent) return recent.id;
      const latest = db
        .prepare(
          `SELECT id FROM session
           WHERE directory IN (${placeholders}) OR path IN (${placeholders})
            ORDER BY time_updated DESC LIMIT 1`
        )
        .get(...cwdPaths, ...cwdPaths);
      return latest ? latest.id : null;
    } catch (_) {
      return null;
    } finally {
      if (db) db.close();
    }
  }

  _hasStepFinish(db, messageId) {
    const rows = db.prepare("SELECT data FROM part WHERE message_id = ?").all(messageId);
    return rows.some((r) => {
      try {
        const d = JSON.parse(r.data);
        // Only a final "stop" finish counts as the agent's complete answer.
        // A "tool-calls" finish is just a tool round and may be followed by
        // the real text/envelope reply.
        return d.type === "step-finish" && d.reason === "stop";
      } catch (_) {
        return false;
      }
    });
  }

  /**
   * Check if the message has at least one `text` part (the actual assistant reply).
   * A message with only tool/results but no text is not a real answer.
   */
  _hasTextPart(db, messageId) {
    const rows = db.prepare("SELECT data FROM part WHERE message_id = ?").all(messageId);
    return rows.some((r) => {
      try {
        const d = JSON.parse(r.data);
        return d.type === "text" && typeof d.text === "string" && d.text.trim().length > 0;
      } catch (_) {
        return false;
      }
    });
  }

  /**
   * Check if the message still has tool parts whose state is not "completed"
   * (i.e. the agent is still waiting on a tool call). If so, the answer is not final.
   */
  _hasActiveTool(db, messageId) {
    const rows = db.prepare("SELECT data FROM part WHERE message_id = ?").all(messageId);
    return rows.some((r) => {
      try {
        const d = JSON.parse(r.data);
        return (
          d.type === "tool" &&
          (d.state?.status === "running" ||
           d.state?.status === "pending" ||
           d.state?.status === undefined)
        );
      } catch (_) {
        return false;
      }
    });
  }

  _getMessageText(db, messageId) {
    const rows = db
      .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY time_created ASC")
      .all(messageId);
    const texts = [];
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        if (d.type === "text" && typeof d.text === "string") {
          texts.push(d.text);
        }
        // Do NOT include tool call/result in the clean text answer,
        // only the actual assistant-written text.
      } catch (_) {
        // ignore
      }
    }
    return texts.join("\n");
  }

  _openDb() {
    const { DatabaseSync } = require("node:sqlite");
    // SQLite cannot reliably acquire a read lock across the WSL UNC bridge.
    // Snapshot the live database locally for each poll instead. The detector
    // is read-only, and a later poll will simply retry if OpenCode is writing.
    if (this.wslDbPath && this.snapshotDbPath) {
      fs.copyFileSync(this.wslDbPath, this.snapshotDbPath);
      const sourceWal = `${this.wslDbPath}-wal`;
      const snapshotWal = `${this.snapshotDbPath}-wal`;
      if (fs.existsSync(sourceWal)) fs.copyFileSync(sourceWal, snapshotWal);
      else if (fs.existsSync(snapshotWal)) fs.unlinkSync(snapshotWal);
      return new DatabaseSync(this.snapshotDbPath, { readOnly: true });
    }
    return new DatabaseSync(this.dbPath, { readOnly: true });
  }
}

/* ------------------------------------------------------------------ */
/* Claude Code (JSONL)                                                */
/* ------------------------------------------------------------------ */

const CLAUDE_TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
]);

class ClaudeCodeDetector extends BaseCompletionDetector {
  constructor(opts) {
    super(opts);
    this.sessionsRoot =
      opts.sessionsRoot || path.join(os.homedir(), ".claude", "projects");
    this.sessionFile = null;
    this.sentAt = 0;
  }

  start(task) {
    super.start(task);
    this.sentAt = Date.now();
    this.sessionFile = null;
    this.taskId = task?.task_id || null;
  }

  poll() {
    if (!this.sessionFile) {
      this.sessionFile = this._findSessionFile();
      if (!this.sessionFile) return;
    }

    const entries = readJsonLines(this.sessionFile);
    for (const entry of entries) {
      if (
        entry.type === "assistant" &&
        new Date(entry.timestamp || 0).getTime() > this.sentAt
      ) {
        const stopReason = entry.message?.stop_reason;
        if (CLAUDE_TERMINAL_STOP_REASONS.has(stopReason)) {
          const text = this._extractAssistantText(entry);
          // Claude persists thinking-only end_turn records before the visible
          // answer in some models. They are not a reply and must not turn
          // into the `[no text response]` placeholder sent to another agent.
          if (text.trim()) {
            this._finish(text);
            return;
          }
        }
      }
    }
  }

  _findSessionFile() {
    const cwd = this.agentHost.cwd || process.cwd();
    const encodedCwd = encodeClaudeProjectCwd(cwd);
    const dir = path.join(this.sessionsRoot, encodedCwd);
    const startedAt = this.agentHost.agentStartedAt || 0;
    const files = walkFiles(dir, (f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;

    // A Claude session is long-lived, so "most recently modified" is not a
    // safe identity: a response for a restored/old task can otherwise finish
    // whichever task happens to be current in AgentHost. Bind the session to
    // the Task ID that AgentHost actually submitted, just as the OpenCode
    // detector does. Do not fall back to an unrelated latest session.
    const needle = this.taskId ? `Task ID: ${this.taskId}` : null;
    const candidates = files
      .filter((f) => mtimeMs(f) >= startedAt - 5000)
      .sort((a, b) => mtimeMs(b) - mtimeMs(a));
    if (!needle) return candidates[0] || null;
    return candidates.find((f) => {
      try {
        return fs.readFileSync(f, "utf8").includes(needle);
      } catch (_) {
        return false;
      }
    }) || null;
  }

  _extractAssistantText(entry) {
    const content = entry.message?.content;
    const texts = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
    } else if (typeof content === "string") {
      texts.push(content);
    }
    return texts.join("\n");
  }
}

/* ------------------------------------------------------------------ */
/* Codex (rollout JSONL)                                              */
/* ------------------------------------------------------------------ */

class CodexDetector extends BaseCompletionDetector {
  constructor(opts) {
    super(opts);
    this.sessionsRoot =
      opts.sessionsRoot || path.join(os.homedir(), ".codex", "sessions");
    this.sessionFile = null;
    this.sentAt = 0;
    this.lastMtime = 0;
    this.lastChangeAt = 0;
    this.lastAssistantCount = 0;
    this.stableMs = opts.stableMs || 2500;
  }

  start(task) {
    super.start(task);
    this.sentAt = Date.now();
    this.sessionFile = null;
    this.lastMtime = 0;
    this.lastChangeAt = 0;
    this.lastAssistantCount = 0;
  }

  poll() {
    if (!this.sessionFile) {
      this.sessionFile = this._findSessionFile();
      if (!this.sessionFile) return;
    }

    const entries = readJsonLines(this.sessionFile);
    const assistantEntries = entries.filter(
      (e) =>
        e.type === "response_item" &&
        e.payload?.type === "message" &&
        (e.payload?.role === "assistant" || e.payload?.role === "developer") &&
        new Date(e.timestamp || 0).getTime() > this.sentAt
    );

    const turnCompleted = entries.some(
      (e) =>
        new Date(e.timestamp || 0).getTime() > this.sentAt &&
        ((e.type === "event_msg" && e.payload?.type === "turn_completed") ||
          (e.type === "event_msg" && e.payload?.type === "turn_completed"))
    );

    const currentMtime = mtimeMs(this.sessionFile);
    if (currentMtime !== this.lastMtime) {
      this.lastMtime = currentMtime;
      this.lastChangeAt = Date.now();
    }

    if (assistantEntries.length > 0) {
      if (turnCompleted) {
        const text = this._extractAssistantText(assistantEntries);
        this._finish(text);
        return;
      }
      // Heuristic: if the file has stopped changing for a while after an
      // assistant message appeared, treat the turn as complete.
      if (
        this.lastChangeAt > 0 &&
        Date.now() - this.lastChangeAt > this.stableMs &&
        assistantEntries.length > this.lastAssistantCount
      ) {
        const text = this._extractAssistantText(assistantEntries);
        this._finish(text);
        return;
      }
      this.lastAssistantCount = assistantEntries.length;
    }
  }

  _findSessionFile() {
    const startedAt = this.agentHost.agentStartedAt || 0;
    const cwd = this.agentHost.cwd || process.cwd();
    const roots = [this.sessionsRoot, path.join(os.homedir(), ".codex", "archived_sessions")];
    let files = [];
    for (const root of roots) {
      files = files.concat(walkFiles(root, (f) => /rollout-.*\.jsonl$/.test(f)));
    }
    if (files.length === 0) return null;

    // Prefer files modified after AgentHost started the agent and whose
    // session_meta cwd matches the working directory.
    const candidates = files.filter((f) => mtimeMs(f) >= startedAt - 5000);
    const withCwd = candidates.filter((f) => {
      const entries = readJsonLines(f);
      const meta = entries.find((e) => e.type === "session_meta");
      return meta?.cwd === cwd || meta?.payload?.cwd === cwd;
    });
    const pool = withCwd.length > 0 ? withCwd : candidates;
    if (pool.length === 0) return null;
    return pool.sort((a, b) => mtimeMs(b) - mtimeMs(a))[0];
  }

  _extractAssistantText(entries) {
    const texts = [];
    for (const entry of entries) {
      const content = entry.payload?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "output_text" && typeof block.text === "string") {
            texts.push(block.text);
          } else if (block?.type === "input_text" && typeof block.text === "string") {
            // assistant normally doesn't have input_text, but keep as fallback
            texts.push(block.text);
          }
        }
      }
    }
    // If there are no text blocks, collect function call names.
    if (texts.length === 0) {
      for (const entry of entries) {
        if (entry.payload?.type === "function_call") {
          texts.push(
            formatTool(entry.payload.name || "function", entry.payload.arguments)
          );
        }
      }
    }
    return texts.join("\n") || "[no text response]";
  }
}

/* ------------------------------------------------------------------ */
/* pi (JSONL tree sessions)                                           */
/* ------------------------------------------------------------------ */

const PI_TERMINAL_STOP_REASONS = new Set(["stop", "end_turn"]);

class PiDetector extends BaseCompletionDetector {
  constructor(opts) {
    super(opts);
    this.sessionsRoot =
      opts.sessionsRoot || path.join(os.homedir(), ".pi", "agent", "sessions");
    this.sessionFile = null;
    this.sentAt = 0;
  }

  start(task) {
    super.start(task);
    this.sentAt = Date.now();
    this.sessionFile = null;
  }

  poll() {
    if (!this.sessionFile) {
      this.sessionFile = this._findSessionFile();
      if (!this.sessionFile) return;
    }

    const entries = readJsonLines(this.sessionFile);
    for (const entry of entries) {
      const ts = this._entryTimestamp(entry);
      const role = this._entryRole(entry);
      if (role === "assistant" && ts > this.sentAt) {
        const stopReason = this._entryStopReason(entry);
        if (PI_TERMINAL_STOP_REASONS.has(stopReason)) {
          const text = this._extractAssistantText(entry);
          this._finish(text);
          return;
        }
      }
    }
  }

  _findSessionFile() {
    const startedAt = this.agentHost.agentStartedAt || 0;
    const cwd = this.agentHost.cwd || process.cwd();
    const cwdKey = String(cwd).replace(/\//g, "-");
    const files = walkFiles(this.sessionsRoot, (f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;

    const candidates = files.filter((f) => mtimeMs(f) >= startedAt - 5000);
    const withCwd = candidates.filter(
      (f) => f.includes(cwdKey) || this._fileHasCwd(f, cwd)
    );
    const pool = withCwd.length > 0 ? withCwd : candidates;
    if (pool.length === 0) return null;
    return pool.sort((a, b) => mtimeMs(b) - mtimeMs(a))[0];
  }

  _fileHasCwd(filePath, cwd) {
    const entries = readJsonLines(filePath);
    return entries.some((e) => e.cwd === cwd || e.directory === cwd);
  }

  _entryTimestamp(entry) {
    if (typeof entry.timestamp === "number") return entry.timestamp;
    if (typeof entry.timestamp === "string") return new Date(entry.timestamp).getTime();
    if (entry.time_created) return Number(entry.time_created) || 0;
    return 0;
  }

  _entryRole(entry) {
    if (entry.role) return entry.role;
    if (entry.type === "assistant") return "assistant";
    if (entry.type === "user") return "user";
    if (entry.type === "toolResult" || entry.type === "tool_result") return "toolResult";
    return entry.message?.role || "";
  }

  _entryStopReason(entry) {
    return (
      entry.stopReason ||
      entry.stop_reason ||
      entry.message?.stopReason ||
      entry.message?.stop_reason ||
      ""
    );
  }

  _extractAssistantText(entry) {
    const content = entry.content ?? entry.message?.content;
    const texts = [];
    if (typeof content === "string") {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (block?.type === "toolCall") {
          texts.push(formatTool(block.name, block.arguments));
        } else if (block?.type === "tool_use") {
          texts.push(formatTool(block.name, block.input));
        }
      }
    }
    return texts.join("\n") || "[no text response]";
  }
}

/* ------------------------------------------------------------------ */
/* Custom reader support                                              */
/* ------------------------------------------------------------------ */

function loadCustomDetector(filePath, opts) {
  let mod;
  try {
    mod = require(filePath);
  } catch (err) {
    throw new Error(`Failed to load custom reader file: ${err.message}`);
  }
  const Detector = mod.default || mod;
  let detector;
  if (typeof Detector === "function") {
    try {
      detector = new Detector(opts);
    } catch (_) {
      detector = Detector(opts);
    }
  } else if (Detector && typeof Detector.create === "function") {
    detector = Detector.create(opts);
  } else {
    throw new Error(
      "Custom reader must export a class/constructor or a factory function"
    );
  }
  if (!detector || typeof detector.start !== "function" || typeof detector.stop !== "function") {
    throw new Error("Custom reader must implement start(task) and stop()");
  }
  return detector;
}

/* ------------------------------------------------------------------ */
/* Registry                                                           */
/* ------------------------------------------------------------------ */

const COMPLETION_DETECTORS = {
  opencode: OpenCodeDetector,
  claude: ClaudeCodeDetector,
  codex: CodexDetector,
  pi: PiDetector,
  manual: null,
};

function detectProviderFromCommand(command) {
  const c = String(command || "").toLowerCase();
  if (c.includes("opencode")) return "opencode";
  if (c.includes("claude")) return "claude";
  if (c.includes("codex")) return "codex";
  if (/(^|\s)pi(\s|$)/.test(c)) return "pi";
  return "manual";
}

function createCompletionDetector(type, opts) {
  if (type === "custom") {
    if (!opts.file) return null;
    return loadCustomDetector(opts.file, opts);
  }
  const Cls = COMPLETION_DETECTORS[type];
  if (!Cls) return null;
  return new Cls(opts);
}

module.exports = {
  BaseCompletionDetector,
  OpenCodeDetector,
  ClaudeCodeDetector,
  CodexDetector,
  PiDetector,
  COMPLETION_DETECTORS,
  createCompletionDetector,
  detectProviderFromCommand,
  loadCustomDetector,
  encodeClaudeProjectCwd,
  findWslOpenCodeDb,
  openCodeSessionPathCandidates,
};
