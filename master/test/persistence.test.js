"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Master } = require("../src/index");

test("Master restores registrations, permissions, tasks and leader", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "master-state-"));
  const dataFile = path.join(root, "state.json");
  try {
    const first = new Master({ dataFile });
    first.registerAgent({ agent_id: "agent-a", base_url: "http://127.0.0.1:9101", mode: "task" });
    first.setPermissions("agent-a", { allow_all: false, allowed_hosts: ["agent-b"] });
    first.setLeader("agent-a");
    first.reportTask({ task_id: "task-a", created_by: "agent-a", participants: ["agent-a"] });
    first._persistState();

    const restored = new Master({ dataFile });
    assert.equal(restored.getAgent("agent-a").permissions.allow_all, false);
    assert.equal(restored.getLeader().agent_id, "agent-a");
    assert.equal(restored.getTask("task-a").task_id, "task-a");
    assert.equal(restored.listAgents()[0].online, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("offline hosts remain registered but disappear from discovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "master-offline-"));
  try {
    const master = new Master({ dataFile: path.join(root, "state.json"), onlineTimeoutMs: 1 });
    master.registerAgent({ agent_id: "agent-a", base_url: "http://127.0.0.1:9101" });
    master.registerAgent({ agent_id: "agent-b", base_url: "http://127.0.0.1:9102" });
    master.agents.get("agent-b").last_seen_ms = 0;
    master.pruneOffline();
    assert.ok(master.getAgent("agent-b"));
    assert.equal(master.discoverNeighbors("agent-a").neighbors.some((n) => n.agent_id === "agent-b"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
