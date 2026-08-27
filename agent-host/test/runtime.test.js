"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { AgentHost, toWslPath } = require("../src/agent-host");
const { ClaudeCodeDetector, encodeClaudeProjectCwd, openCodeSessionPathCandidates } = require("../src/completion-detectors");
const { TaskStore } = require("../src/task-store");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Windows paths are translated for WSL", () => {
  assert.equal(toWslPath("D:\\OpenFalangji\\demo"), "/mnt/d/OpenFalangji/demo");
  assert.equal(toWslPath("/home/dev/project"), "/home/dev/project");
});

test("OpenCode session lookup includes the WSL form of a Windows cwd", () => {
  const paths = openCodeSessionPathCandidates({
    terminalEnv: "wsl",
    cwd: "D:\\OpenFalangji\\agent-host",
  });
  assert.ok(paths.includes("D:\\OpenFalangji\\agent-host"));
  assert.ok(paths.includes("/mnt/d/OpenFalangji/agent-host"));
});

test("TaskStore restores task snapshots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-store-"));
  try {
    const first = new TaskStore({ root });
    first.ensureTask({ task_id: "persist-1", description: "restore me" });
    first.update("persist-1", { status: "completed" });
    const restored = new TaskStore({ root });
    assert.equal(restored.get("persist-1").status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude prompt submission sends Enter as a separate delayed PTY write", async () => {
  const writes = [];
  const host = Object.create(AgentHost.prototype);
  host.command = "claude";
  host.completionProvider = "claude";
  host.currentTask = { task_id: "claude-submit" };
  host.ptyProcess = { write: (value) => writes.push(value) };
  host._submitPrompt("hello claude\n");
  assert.deepEqual(writes, ["\x1b[200~hello claude\x1b[201~"]);
  await wait(60);
  assert.deepEqual(writes, ["\x1b[200~hello claude\x1b[201~", "\r"]);
});

test("Claude Windows project directory is encoded like Claude Code", () => {
  assert.equal(encodeClaudeProjectCwd("D:\\OpenFalangji\\agent-host"), "D--OpenFalangji-agent-host");
});

test("Claude detector finds a Windows session directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sessions-"));
  try {
    const project = path.join(root, "D--OpenFalangji-agent-host");
    fs.mkdirSync(project, { recursive: true });
    const session = path.join(project, "session.jsonl");
    fs.writeFileSync(session, "{}\n", "utf8");
    const detector = new ClaudeCodeDetector({
      sessionsRoot: root,
      agentHost: { cwd: "D:\\OpenFalangji\\agent-host", agentStartedAt: 0 },
    });
    assert.equal(detector._findSessionFile(), session);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude detector binds to the session containing the current Task ID", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-task-session-"));
  try {
    const project = path.join(root, "D--OpenFalangji-agent-host");
    fs.mkdirSync(project, { recursive: true });
    const target = path.join(project, "target.jsonl");
    const unrelated = path.join(project, "unrelated.jsonl");
    fs.writeFileSync(target, '{"type":"last-prompt","lastPrompt":"Task ID: task-current"}\n', "utf8");
    fs.writeFileSync(unrelated, '{"type":"last-prompt","lastPrompt":"Task ID: task-stale"}\n', "utf8");
    fs.utimesSync(unrelated, new Date(), new Date(Date.now() + 1000));
    const detector = new ClaudeCodeDetector({
      sessionsRoot: root,
      agentHost: { cwd: "D:\\OpenFalangji\\agent-host", agentStartedAt: 0 },
    });
    detector.start({ task_id: "task-current" });
    assert.equal(detector._findSessionFile(), target);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Claude detector skips thinking-only end_turn records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-text-only-"));
  try {
    const session = path.join(root, "session.jsonl");
    const timestamp = new Date().toISOString();
    const thinking = { type: "assistant", timestamp, message: { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "internal" }] } };
    const final = { type: "assistant", timestamp, message: { stop_reason: "end_turn", content: [{ type: "text", text: "visible reply" }] } };
    fs.writeFileSync(session, `${JSON.stringify(thinking)}\n${JSON.stringify(final)}\n`, "utf8");
    const detector = new ClaudeCodeDetector({ sessionsRoot: root, agentHost: {} });
    let completed = null;
    detector._finish = (text) => { completed = text; };
    detector.sentAt = Date.now() - 1000;
    detector.sessionFile = session;
    detector.poll();
    assert.equal(completed, "visible reply");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mismatched reply envelope is ignored instead of contaminating current task", () => {
  const host = Object.create(AgentHost.prototype);
  const history = [];
  host.currentTask = {
    task_id: "task-current",
    inboundItem: { type: "task" },
    unwrapped: { reply: null, prompt: "hello" },
    outputBuffer: "",
  };
  host.busy = true;
  host.mode = "task";
  host._stopCompletionDetector = () => {};
  host._clearLeaderEventTimer = () => {};
  host._broadcastStatus = () => {};
  host._pumpQueue = () => {};
  host.taskStore = {
    get: () => ({ task_id: "task-current", description: "hello", round: 1 }),
    appendHistory: (_id, entry) => history.push(entry),
  };
  const result = host.completeCurrentTask(
    '<<AGENT_REPLY>>\n{ "action": "silent", "task_id": "task-stale" }\n<<END_AGENT_REPLY>>'
  );
  assert.equal(result.ignored, "mismatched_task_id");
  assert.equal(host.busy, false);
  assert.equal(history[0].received_task_id, "task-stale");
});

test("forward always preserves the current task ID", () => {
  const host = Object.create(AgentHost.prototype);
  const sent = [];
  host.neighbors = new Map([["next", { agent_id: "next", base_url: "http://next" }]]);
  host.taskStore = { update: () => {} };
  host._taskOriginBaseUrl = () => "http://origin";
  host._taskOriginReplyUrl = () => "http://origin/reply";
  host._sendForwardTask = (...args) => sent.push(args);
  host._handleAgentRouting(
    { task_id: "task-current", title: "", hops: 0 },
    {},
    { action: "forward", to_agent_id: "next", task_id: "task-incorrect", content: "continue" },
    null,
    "continue"
  );
  assert.equal(sent[0][1], "task-current");
});

test("create keeps a deliberately new task ID", () => {
  const host = Object.create(AgentHost.prototype);
  let received = null;
  host._handleAgentCreate = (envelope, task, ctx) => { received = { envelope, task, ctx }; };
  const task = { task_id: "task-current" };
  const envelope = { action: "create", to_agent_id: "next", task_id: "task-new", content: "new work" };
  host._handleAgentRouting(task, {}, envelope, null, "new work");
  assert.equal(received.envelope.task_id, "task-new");
  assert.equal(received.ctx.task.task_id, "task-current");
});

test("WebSocket local enqueue creates a non-null minimal task", () => {
  const host = Object.create(AgentHost.prototype);
  host.agentId = "local-agent";
  let received = null;
  host.enqueueInbound = (item) => { received = item; };
  host._handleClientMessage({}, { type: "enqueue", prompt: "/model" });
  assert.equal(received.type, "minimal");
  assert.match(received.task_id, /^task-/);
});

test("native Windows PTY starts and emits output", { skip: process.platform !== "win32" }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-native-"));
  const host = new AgentHost({ agentId: "native-smoke", openTerminal: false, taskStoreRoot: root });
  let output = "";
  host._handleAgentOutput = (data) => { output += data; };
  try {
    host.startAgent("Write-Output NATIVE_PTY_OK", process.cwd());
    await wait(3500);
    assert.match(output, /NATIVE_PTY_OK/);
  } finally {
    if (host.ptyProcess) host.ptyProcess.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WSL PTY starts from a Windows Host", { skip: process.platform !== "win32" }, async (t) => {
  const probe = spawnSync("wsl.exe", ["-l", "-q"], { encoding: "utf8" });
  if (probe.status !== 0 || !probe.stdout.trim()) return t.skip("WSL is unavailable");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-wsl-"));
  const host = new AgentHost({ agentId: "wsl-smoke", openTerminal: false, taskStoreRoot: root, terminalEnv: "wsl" });
  let output = "";
  host._handleAgentOutput = (data) => { output += data; };
  try {
    host.startAgent("printf WSL_PTY_OK", process.cwd());
    await wait(5000);
    assert.match(output, /WSL_PTY_OK/);
  } finally {
    if (host.ptyProcess) host.ptyProcess.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
