"use strict";

const crypto = require("crypto");

const TASK_OVER_MARKER = "<<TASK_OVER>>";
const AGENT_REPLY_START = "<<AGENT_REPLY>>";
const AGENT_REPLY_END = "<<END_AGENT_REPLY>>";

function newId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Wrap an incoming HTTP request into an InboundQueueItem.
 */
function wrapInbound({ type, task_id, payload, reply }) {
  return {
    queue_id: newId("q-in"),
    type: type || "minimal",
    task_id: task_id || null,
    payload: payload || {},
    reply: reply || null,
    enqueued_at: new Date().toISOString(),
  };
}

/**
 * Unwrap an InboundQueueItem before giving it to the agent executor.
 * Only the fields the agent needs remain.
 */
function unwrapInbound(item) {
  return {
    task_id: item.task_id,
    prompt: item.payload.prompt || "",
    reply: item.reply
      ? {
          url: item.reply.url,
          request_id: item.reply.request_id,
          from: item.reply.from,
          task_origin: item.reply.task_origin,
        }
      : null,
  };
}

/**
 * Wrap an outbound response into an OutboundQueueItem.
 */
function wrapOutbound({ type, to, request_id, task_id, payload, from, headers }) {
  return {
    queue_id: newId("q-out"),
    type: type || "task_reply",
    to,
    request_id: request_id || null,
    task_id: task_id || null,
    from: from || null,
    payload: payload || {},
    headers: headers || null,
    status: "pending",
    retries: 0,
    created_at: new Date().toISOString(),
  };
}

function containsTaskOverMarker(output) {
  return String(output || "").includes(TASK_OVER_MARKER);
}

/**
 * Parse the agent's reply envelope. The agent can end its output with:
 *
 * <<AGENT_REPLY>>
 * { "action": "forward|complete|create|silent", ... }
 * <<END_AGENT_REPLY>>
 *
 * Returns null when no envelope is present (caller falls back to old
 * "reply to original requester" behavior).
 */
function parseAgentReply(output) {
  const text = String(output || "");
  const start = text.indexOf(AGENT_REPLY_START);
  const end = text.lastIndexOf(AGENT_REPLY_END);
  if (start === -1 || end === -1 || end <= start) return null;
  const raw = text.slice(start + AGENT_REPLY_START.length, end).trim();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const action = String(parsed.action || "").toLowerCase();
    if (!["forward", "complete", "create", "silent"].includes(action)) {
      // Unknown action: fall back to forward with provided content.
      return {
        action: "forward",
        to_agent_id: parsed.to_agent_id || null,
        task_id: parsed.task_id || null,
        title: parsed.title || null,
        description: parsed.description || null,
        content: String(parsed.content || "").trim() || text.replace(AGENT_REPLY_START, "").replace(AGENT_REPLY_END, "").trim(),
        end_current: parsed.end_current === true,
      };
    }
    return {
      action,
      to_agent_id: parsed.to_agent_id || null,
      task_id: parsed.task_id || null,
      title: parsed.title || null,
      description: parsed.description || null,
      content: String(parsed.content || "").trim(),
      end_current: parsed.end_current === true,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Extract the visible reply content from agent output (strip the envelope).
 */
function extractAgentReplyContent(output) {
  const text = String(output || "");
  const start = text.indexOf(AGENT_REPLY_START);
  const end = text.lastIndexOf(AGENT_REPLY_END);
  if (start === -1 || end === -1 || end <= start) return text;
  const before = text.slice(0, start).trim();
  const after = text.slice(end + AGENT_REPLY_END.length).trim();
  // Prefer content outside envelope; if only envelope exists, use empty.
  return before || after;
}

/**
 * Build a short "neighbor list" section with agent cards.
 * Each card includes id, base_url, description and capabilities.
 */
function buildNeighborInfo(neighbors) {
  const list = Array.from(neighbors || []);
  if (list.length === 0) return "Known neighbors: none";
  const lines = list.map((n) => {
    const caps = Array.isArray(n.capabilities) && n.capabilities.length
      ? n.capabilities.join(", ")
      : (n.mode || "unknown");
    const desc = n.description ? ` — ${n.description}` : "";
    return `- ${n.agent_id} @ ${n.base_url} [${caps}]${desc}`;
  });
  return `Known neighbors (agent cards):\n${lines.join("\n")}`;
}

/**
 * Routing instructions injected into task-mode prompts. Tells the agent how
 * to decide where (and whether) to send its reply, using the envelope block.
 */
function buildRoutingInstructions() {
  const lines = [];
  lines.push("Reply Routing Instructions:");
  lines.push(`- You may reply to any neighbor, not only the sender.`);
  lines.push(`- If you want to send a reply/forward, end your response with a JSON envelope:`);
  lines.push(AGENT_REPLY_START);
  lines.push(`{ "action": "forward", "to_agent_id": "<neighbor agent id>", "task_id": "<current task id>", "content": "<your message>" }`);
  lines.push(AGENT_REPLY_END);
  lines.push(`- Actions:`);
  lines.push(`  * "forward": send content to to_agent_id and continue the SAME task. task_id must be the current task ID (or omitted).`);
  lines.push(`  * "complete": finish current task. If to_agent_id is set, send final output there; otherwise end silently.`);
  lines.push(`  * "create": create and send a NEW task (give a new task_id or leave empty for auto) to to_agent_id. Set end_current=true to finish current task, false to keep it active.`);
  lines.push(`  * "silent": do not send anything. Use this only when no action is needed.`);
  lines.push(`- If you do NOT include an envelope, AgentHost will automatically send your plain reply back to the original requester (backward compatible).`);
  lines.push(`- to_agent_id must be one of the known neighbors above. If empty for forward, it means original requester.`);
  lines.push(`- For "create", always provide a clear title and description for the new task.`);
  lines.push(`- "content" MUST be plain readable text only. Never put an envelope, JSON, or these markers inside "content".`);
  lines.push(`- STOP RULE: if "Task Status" above is already "completed" or "failed", the work is finished.`);
  lines.push(`  Do NOT forward it and do NOT create anything. Reply with action "silent".`);
  lines.push(`  Never forward a task back to an agent that already appears in the log unless it asked you a new question.`);
  return lines.join("\n");
}

/**
 * Build a task-mode prompt. The agent now receives:
 * - task metadata + log URL
 * - neighbor agent cards
 * - routing instructions
 * - original prompt
 */
function buildTaskPrompt(task, incoming, opts = {}) {
  const neighbors = opts.neighbors || [];
  const lines = [];
  lines.push("[Task Mode]");
  lines.push(`Task ID: ${task.task_id}`);
  lines.push(`Task Status: ${task.status || "active"}`);
  lines.push(`From: ${incoming?.reply?.from || task.created_by || "unknown"}`);
  lines.push(`Round: ${task.round}`);
  lines.push(`Max Hops: ${task.max_hops}`);
  lines.push(`Current Hops: ${task.hops}`);
  lines.push(`Participants: ${task.participants.join(", ") || "-"}`);
  lines.push(`Task Status: ${task.status || "active"}`);
  const logUrl = task.shared_store_url
    ? task.shared_store_url.replace(/\/files$/, "/log")
    : null;
  if (logUrl) {
    lines.push(`Log URL: ${logUrl}`);
  }
  if (task.latest_reply) {
    lines.push(
      `Latest Reply (from ${task.latest_reply.agent_id || "unknown"}): ${task.latest_reply.content}`
    );
  }
  lines.push("");
  lines.push(buildNeighborInfo(neighbors));
  lines.push("");
  lines.push("Instructions:");
  lines.push(`- This is a shared multi-agent task. You may continue the work, forward it to another agent, create subtasks, or mark it over.`);
  if (logUrl) {
    lines.push(`- The task log contains previous questions and answers. Read it with curl when available; for a local http://127.0.0.1 URL, do not use WebFetch because it may force HTTPS.`);
    lines.push(`- An empty entries array is valid for a first-round task. If the log endpoint/tool is unavailable or denied, continue from this prompt and Latest Reply; never refuse, stop, or omit your envelope solely because log reading failed.`);
  }
  lines.push(`- Put your answer ONLY in the envelope's "content" field. Do not repeat the envelope JSON outside the envelope.`);
  lines.push(`- CONTINUE-ON-SAME-TASK RULE: if this task's goal is still in progress, keep using the SAME task_id and action "forward". Do NOT complete it and do NOT create a new task just because your turn is done. Only the last agent in the chain uses "complete".`);
  lines.push(`- STOP RULES:`);
  lines.push(`  * If "Task Status" above is already completed or failed, the task is DONE. Use action "silent" and send nothing. Do NOT forward it.`);
  lines.push(`  * If the log shows the goal is already achieved, use "complete" (or "silent"), never "forward".`);
  lines.push(`  * Only use "forward" when there is concrete remaining work that another agent must do.`);
  lines.push(`  * Never forward a task back to the agent it just came from unless you are adding new information.`);
  lines.push("");
  lines.push(buildRoutingInstructions());
  lines.push("");
  lines.push(`Original Prompt:`);
  lines.push(incoming?.payload?.prompt || task.description || "");
  return lines.join("\n");
}

/**
 * Build a prompt for the leader when Master reports a task/event decision.
 * The leader gets all agent cards + task context and is told to stay silent
 * unless it really needs to create a new task.
 */
function buildLeaderDecisionPrompt({ event_type, task, reason, agents, logUrls, neighbors }) {
  const lines = [];
  lines.push("[Leader Decision Mode]");
  lines.push(`Event: ${event_type}`);
  if (task) {
    lines.push(`Task ID: ${task.task_id || "-"}`);
    lines.push(`Task Status: ${task.status || "-"}`);
    lines.push(`Task Title: ${task.title || "-"}`);
    lines.push(`Participants: ${(task.participants || []).join(", ") || "-"}`);
  }
  if (reason) lines.push(`Reason: ${reason}`);
  if (logUrls && logUrls.length) {
    lines.push(`Task Log URLs: ${logUrls.join(", ")}`);
  }
  lines.push("");
  lines.push("All available agents:");
  const agentList = Array.isArray(agents) && agents.length ? agents : (neighbors || []);
  if (agentList.length === 0) {
    lines.push("- none");
  } else {
    for (const a of agentList) {
      const caps = Array.isArray(a.capabilities) && a.capabilities.length
        ? a.capabilities.join(", ")
        : (a.mode || "unknown");
      lines.push(`- ${a.agent_id} @ ${a.base_url} [${caps}]${a.description ? ` — ${a.description}` : ""}`);
    }
  }
  lines.push("");
  lines.push("You are the LEADER. Master reports the above event.");
  lines.push(`- First read the task logs above if any.`);
  lines.push(`- Check whether the overall goal needs a new task, who is best suited, and what its prompt should be.`);
  lines.push(`- Unless it is NECESSARY, do NOT create any new task. Keep silent.`);
  lines.push(`- LEADER RULE: You are NOT a task executor. NEVER create a task where to_agent_id is yourself.`);
  lines.push(`- ONE TASK RULE: if the goal can be satisfied by ONE task description plus per-round replies, create exactly ONE task. Do NOT create a new task per round/turn.`);
  lines.push(`- The task description MUST tell workers to reply and forward the SAME task_id to the next agent; only the last worker uses "complete".`);
  lines.push(`- When you allocate a task, the instruction MUST tell the worker to "complete" or "silent" when done,`);
  lines.push(`  NOT to forward back to you. If the worker forwards back to you, it is a bug.`);
  lines.push("");
  lines.push(buildRoutingInstructions());
  lines.push("");
  lines.push(`If you decide to create a new task, use action "create" with to_agent_id, title, description and content.`);
  lines.push(`If you decide no action is needed, use action "silent".`);
  return lines.join("\n");
}

/**
 * Unified agent prompt constructor.
 *
 * For task mode we now include neighbor cards + routing instructions.
 * For minimal mode we keep the original prompt unchanged.
 */
function buildAgentPrompt({ mode, task, incoming, rawPrompt, neighbors }) {
  if (mode === "task") {
    return buildTaskPrompt(task, incoming, { neighbors });
  }
  return rawPrompt;
}

/**
 * Build the HTTP request entity for sending a task to a neighbor.
 * This is the "first-round request constructor".
 */
function buildOutboundTaskRequest({
  from,
  replyTo,
  taskOrigin,
  taskId,
  title,
  description,
  prompt,
  requestId,
  timeoutMs,
}) {
  const body = {
    task_id: taskId,
    title: title || "",
    description: description || prompt || "",
    prompt: prompt || "",
    context: {},
  };
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    body.context.timeout_ms = timeoutMs;
  }
  const headers = {
    "Content-Type": "application/json",
    "X-Request-Id": requestId || newId("req"),
    "X-From": from,
    "X-Reply-To": replyTo,
    "X-Task-Origin": taskOrigin,
  };
  return { body, headers };
}

/**
 * Construct a canonical AgentRequest from local/UI input.
 * This lets a first-round request from the management page carry routing
 * attributes (reply_to, from, request_id) so AgentHost knows where to reply.
 */
function createLocalRequest({ prompt, task_id, from, reply_to, request_id, type }) {
  const rid = request_id || newId("req");
  return {
    request_id: rid,
    type: type || "minimal",
    task_id: task_id || null,
    from: from || null,
    to: null,
    reply_to: reply_to || null,
    task_origin: null,
    payload: {
      prompt: prompt || "",
      title: "",
      description: prompt || "",
      context: {},
    },
    headers: {
      "X-Request-Id": rid,
      "X-From": from || "",
      "X-Reply-To": reply_to || "",
      "X-Task-Origin": "",
    },
  };
}

/**
 * Parse an incoming HTTP request into a canonical AgentRequest object.
 * This is the constructor used when an external AgentHost/center calls us.
 */
function parseIncomingHttpRequest(headers, body) {
  const b = body || {};
  const requestId = headers["x-request-id"] || b.request_id || newId("req");
  const from = headers["x-from"] || b.from || null;
  const replyTo = headers["x-reply-to"] || b.reply_to || null;
  const taskOrigin = headers["x-task-origin"] || b.task_origin || null;
  const taskId = b.task_id || null;
  const prompt = b.prompt || b.description || b.context?.prompt || "";

  return {
    request_id: requestId,
    type: b.type || "task",
    task_id: taskId,
    from,
    to: null, // filled by the receiver (this AgentHost)
    reply_to: replyTo,
    task_origin: taskOrigin,
    payload: {
      prompt,
      title: b.title || "",
      description: b.description || prompt,
      context: b.context || {},
    },
    headers: {
      "X-Request-Id": requestId,
      "X-From": from || "",
      "X-Reply-To": replyTo || "",
      "X-Task-Origin": taskOrigin || "",
    },
  };
}

/**
 * Build the HTTP request entity for replying to a caller.
 * This wraps the response back to the address/port stored in the original
 * request's X-Reply-To header.
 */
function buildReplyHttpRequest(reply, payload) {
  const url = reply?.url || reply?.reply_to || null;
  const headers = {
    "Content-Type": "application/json",
    "X-Request-Id": reply?.request_id || "",
    "X-From": reply?.from || "",
    "X-Task-Id": payload?.task_id || "",
  };
  return { url, headers, body: payload };
}

module.exports = {
  TASK_OVER_MARKER,
  AGENT_REPLY_START,
  AGENT_REPLY_END,
  newId,
  wrapInbound,
  unwrapInbound,
  wrapOutbound,
  buildTaskPrompt,
  buildNeighborInfo,
  buildRoutingInstructions,
  buildLeaderDecisionPrompt,
  buildAgentPrompt,
  buildOutboundTaskRequest,
  createLocalRequest,
  parseIncomingHttpRequest,
  buildReplyHttpRequest,
  containsTaskOverMarker,
  parseAgentReply,
  extractAgentReplyContent,
};
