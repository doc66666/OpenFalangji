(function () {
  const translations = {
    en: {
      "01 / 终端": "01 / Terminal", "02 / 任务": "02 / Tasks", "03 / 网络": "03 / Network", "04 / 设置": "04 / Settings",
      "Agent 终端": "Agent terminal", "标记完成": "Mark complete", "执行状态": "Execution state", "当前任务": "Current task", "接收队列": "Inbound queue", "发送队列": "Outbound queue",
      "键盘输入将直接发送给 Agent": "Keyboard input is sent directly to the Agent", "任务输入": "Task input", "入队发送 →": "Enqueue →",
      "任务与路由": "Tasks & routing", "全局决策咨询": "Global decision consultation", "发起咨询": "Consult",
      "发送任务给邻居": "Send task to neighbor", "发送任务": "Send task", "网络与 Master": "Network & Master",
      "Master 注册": "Master registration", "Master 地址": "Master URL", "发送注册申请": "Request registration",
      "手动邻居": "Manual neighbor", "刷新": "Refresh", "Host 地址": "Host URL", "添加邻居": "Add neighbor", "已发现节点": "Discovered nodes",
      "运行设置": "Runtime settings", "终端环境": "Terminal environment", "执行环境": "Execution environment", "Windows 原生": "Windows native", "WSL 发行版（可选）": "WSL distribution (optional)",
      "Agent 启动命令": "Agent start command", "工作目录": "Working directory", "完成检测": "Completion detector", "自动识别": "Auto detect", "手动": "Manual", "自定义 Reader": "Custom reader",
      "启动 / 重启 Agent": "Start / restart Agent", "协作参数": "Collaboration settings", "协作模式": "Collaboration mode", "极简模式": "Minimal mode", "任务模式": "Task mode", "最大跳转": "Maximum hops", "保存配置": "Save configuration",
      "等待中": "Pending", "已注册": "Registered", "被拒绝": "Rejected", "未申请": "Not requested", "暂无邻居，等待 Master 发现或手动添加。": "No neighbors yet. Wait for Master discovery or add one manually.",
      "请选择邻居并填写任务内容": "Select a neighbor and enter task content", "请输入 Master 地址": "Enter a Master URL", "请填写邻居 Agent ID 和地址": "Enter a neighbor Agent ID and URL", "请先输入 Agent 启动命令": "Enter an Agent start command",
      "Host 配置已保存": "Host configuration saved", "邻居已添加": "Neighbor added", "注册申请已发送": "Registration request sent"
    }
  };
  const textOriginal = new WeakMap();
  function localize(root = document.body) {
    const lang = localStorage.getItem("openfalangji-language") || "zh";
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    document.title = lang === "en" ? "OpenFalangji / AgentHost" : "OpenFalangji / AgentHost 控制台";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (["SCRIPT", "STYLE"].includes(node.parentElement?.tagName) || node.parentElement?.id === "language-toggle") return;
      const base = textOriginal.get(node) ?? node.nodeValue; textOriginal.set(node, base);
      const key = base.trim(); const translated = translations[lang]?.[key];
      if (translated) node.nodeValue = base.replace(key, translated); else if (lang === "zh") node.nodeValue = base;
    });
    document.querySelectorAll("[placeholder],[title],[aria-label]").forEach((el) => ["placeholder", "title", "aria-label"].forEach((attr) => {
      if (!el.hasAttribute(attr)) return;
      const key = `i18n-${attr}`, base = el.dataset[key] ?? el.getAttribute(attr); el.dataset[key] = base;
      el.setAttribute(attr, translations[lang]?.[base] || base);
    }));
    const toggle = document.getElementById("language-toggle"); if (toggle) {
      const nextLabel = lang === "en" ? "中文" : "EN";
      toggle.dataset.language = lang;
      toggle.textContent = nextLabel;
      requestAnimationFrame(() => { toggle.textContent = nextLabel; });
    }
  }
  function setLanguage(lang) { localStorage.setItem("openfalangji-language", lang); localize(); }
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("language-toggle")?.addEventListener("click", () => setLanguage((localStorage.getItem("openfalangji-language") || "zh") === "zh" ? "en" : "zh"));
    localize();
    new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => { if (node.nodeType === Node.ELEMENT_NODE) localize(node); }))).observe(document.body, { childList: true, subtree: true });
  });
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "Menlo, Consolas, 'Courier New', monospace",
    theme: { background: "#1e1e1e", foreground: "#eee" },
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(document.getElementById("terminal-container"));
  fitAddon.fit();

  const statusEl = document.getElementById("status");
  const agentIdEl = document.getElementById("agent-id");
  const commandInput = document.getElementById("command-input");
  const cwdInput = document.getElementById("cwd-input");
  const completionProviderSelect = document.getElementById("completion-provider");
  const customReaderFile = document.getElementById("custom-reader-file");
  const startBtn = document.getElementById("start-btn");
  const completeBtn = document.getElementById("complete-btn");
  const replyToInput = document.getElementById("reply-to-input");
  const inputEl = document.getElementById("prompt-input");
  const sendBtn = document.getElementById("send-btn");
  const sendNeighborSelect = document.getElementById("send-neighbor-select");
  const sendNeighborPrompt = document.getElementById("send-neighbor-prompt");
  const sendNeighborBtn = document.getElementById("send-neighbor-btn");
  const busyStateEl = document.getElementById("busy-state");
  const currentTaskEl = document.getElementById("current-task");
  const inboundLengthEl = document.getElementById("inbound-length");
  const outboundLengthEl = document.getElementById("outbound-length");
  const inboundListEl = document.getElementById("inbound-list");
  const outboundListEl = document.getElementById("outbound-list");
  const agentIdConfig = document.getElementById("agent-id-config");
  const modeSelect = document.getElementById("mode-select");
  const maxHopsInput = document.getElementById("max-hops-input");
  const saveConfigBtn = document.getElementById("save-config-btn");
  const neighborIdInput = document.getElementById("neighbor-id-input");
  const neighborUrlInput = document.getElementById("neighbor-url-input");
  const addNeighborBtn = document.getElementById("add-neighbor-btn");
  const refreshNeighborsBtn = document.getElementById("refresh-neighbors-btn");
  const neighborListEl = document.getElementById("neighbor-list");
  const masterUrlInput = document.getElementById("master-url-input");
  const masterRegisterBtn = document.getElementById("master-register-btn");
  const masterStatusEl = document.getElementById("master-status");
  const terminalEnvSelect = document.getElementById("terminal-env-select");
  const wslDistroInput = document.getElementById("wsl-distro-input");
  const sidebarEnv = document.getElementById("sidebar-env");
  const toastEl = document.getElementById("toast");

  const leaderPanel = document.getElementById("leader-panel");
  const leaderConsultInput = document.getElementById("leader-consult-input");
  const leaderConsultBtn = document.getElementById("leader-consult-btn");
  const leaderConsultResult = document.getElementById("leader-consult-result");

  let toastTimer = null;
  function toast(message, tone) {
    toastEl.textContent = message;
    toastEl.style.background = tone === "error" ? "#ff6b6b" : tone === "success" ? "#4ecdc4" : "#ffe66d";
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  function switchPage(name) {
    document.querySelectorAll(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.page === name));
    document.querySelectorAll("[data-page-panel]").forEach((el) => el.classList.toggle("active", el.dataset.pagePanel === name));
    location.hash = name;
    if (name === "terminal") setTimeout(() => fitAddon.fit(), 30);
  }
  document.querySelectorAll(".nav-item").forEach((el) => el.addEventListener("click", () => switchPage(el.dataset.page)));
  const initialPage = location.hash.replace("#", "");
  if (["terminal", "tasks", "network", "settings"].includes(initialPage)) switchPage(initialPage);

  const wsUrl =
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    "/ws";
  const ws = new WebSocket(wsUrl);

  function setStatus(text, online) {
    statusEl.textContent = text;
    statusEl.className = online ? "online" : "offline";
  }

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function syncCustomReaderVisibility() {
    customReaderFile.hidden = completionProviderSelect.value !== "custom";
  }

  function stripAnsi(s) {
    return String(s)
      .replace(/\x1B\[[0-9;?]*[ -\/]*[@-~]/g, "")
      .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
      .replace(/\x1B[()][0-9A-Z]/g, "")
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderStatus(status) {
    if (!status) return;
    if (status.command && commandInput !== document.activeElement) commandInput.value = status.command;
    if (status.cwd && cwdInput !== document.activeElement) cwdInput.value = status.cwd;
    if (status.terminal_env && terminalEnvSelect !== document.activeElement) terminalEnvSelect.value = status.terminal_env;
    if (status.wsl_distro != null && wslDistroInput !== document.activeElement) wslDistroInput.value = status.wsl_distro;
    if (status.center_url && masterUrlInput !== document.activeElement) masterUrlInput.value = status.center_url;
    sidebarEnv.textContent = (status.terminal_env || "native").toUpperCase();
    renderConfig(status);
    if (status.completion_provider) {
      completionProviderSelect.value = status.completion_provider;
      syncCustomReaderVisibility();
      if (status.completion_config?.file) {
        customReaderFile.value = status.completion_config.file;
      }
    }
    busyStateEl.textContent = status.busy ? "busy" : "idle";
    currentTaskEl.textContent = status.current_task
      ? status.current_task.task_id
      : "-";
    inboundLengthEl.textContent = status.inbound_queue_length ?? 0;
    outboundLengthEl.textContent = status.outbound_queue_length ?? 0;
    renderInbound(status.inbound_queue || []);
    renderOutbound(status.outbound_queue || []);
    renderMasterStatus(status.center_status);

    // Show/hide leader consult panel based on is_leader flag.
    if (status.is_leader) {
      leaderPanel.hidden = false;
    } else {
      leaderPanel.hidden = true;
    }
  }

  function renderMasterStatus(centerStatus) {
    if (!centerStatus || !centerStatus.state) {
      masterStatusEl.textContent = "未申请";
      masterStatusEl.className = "master-status";
      return;
    }
    const state = centerStatus.state;
    const labels = {
      pending: "等待中",
      registered: "已注册",
      rejected: "被拒绝",
      none: "未申请",
    };
    masterStatusEl.textContent = labels[state] || state;
    if (centerStatus.message) {
      masterStatusEl.title = centerStatus.message;
    }
    masterStatusEl.className = "master-status " + state;
  }

  function renderInbound(list) {
    if (!list || list.length === 0) {
      inboundListEl.innerHTML = '<div class="muted">(empty)</div>';
      return;
    }
    inboundListEl.innerHTML = list
      .map((item) => {
        const prompt = item.prompt || item.payload?.prompt || "";
        return (
          `<div><span class="task-id">${escapeHtml(item.task_id || "-")}</span> ` +
          `<span>[${escapeHtml(item.type || "?")}]</span> ` +
          `<span>${escapeHtml(prompt.slice(0, 60))}</span></div>`
        );
      })
      .join("");
  }

  function renderOutbound(list) {
    if (!list || list.length === 0) {
      outboundListEl.innerHTML = '<div class="muted">(empty)</div>';
      return;
    }
    outboundListEl.innerHTML = list
      .map((item) => {
        const taskId = item.task_id || item.payload?.task_id || "-";
        const content =
          item.output ||
          item.payload?.final_output ||
          item.payload?.content ||
          item.payload?.output ||
          "";
        const clean = stripAnsi(content || "");
        const status = item.status || item.payload?.status || "";
        return (
          `<div><span class="task-id">${escapeHtml(taskId)}</span> ` +
          `<span>[${escapeHtml(status)}]</span> ` +
          `<span>${escapeHtml(clean.slice(-120) || "(no output)")}</span></div>`
        );
      })
      .join("");
  }

  function renderNeighbors(neighbors) {
    // Preserve the user's current selection in the neighbor select
    const prevSelected = sendNeighborSelect.value;

    if (!neighbors || neighbors.length === 0) {
      neighborListEl.innerHTML = "<span>暂无邻居，等待 Master 发现或手动添加。</span>";
      sendNeighborSelect.innerHTML = '<option value="">选择邻居...</option>';
      return;
    }
    neighborListEl.innerHTML =
      neighbors
        .map((n) => `<span><b>${escapeHtml(n.agent_id)}</b><br>${escapeHtml(n.base_url)}<br><small>${escapeHtml(n.description || n.mode || "agent")}</small></span>`)
        .join("");
    sendNeighborSelect.innerHTML =
      '<option value="">选择邻居...</option>' +
      neighbors
        .map((n) => `<option value="${escapeHtml(n.agent_id)}">${escapeHtml(n.agent_id)}</option>`)
        .join("");
    // Restore selection, if still valid
    if (prevSelected) sendNeighborSelect.value = prevSelected;
  }

  function renderConfig(status) {
    if (!status) return;
    // Only set values if the user is not actively editing that field
    if (status.agent_id && agentIdConfig !== document.activeElement) agentIdConfig.value = status.agent_id;
    if (status.mode && modeSelect !== document.activeElement) modeSelect.value = status.mode;
    if (status.max_hops && maxHopsInput !== document.activeElement) maxHopsInput.value = status.max_hops;
    renderNeighbors(status.neighbors);
  }

  async function saveConfig() {
    const body = {
      agent_id: agentIdConfig.value.trim() || undefined,
      mode: modeSelect.value,
      max_hops: parseInt(maxHopsInput.value, 10) || undefined,
      terminal_env: terminalEnvSelect.value,
      wsl_distro: wslDistroInput.value.trim(),
    };
    const res = await fetch("/v1/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    renderConfig(data);
    toast("Host 配置已保存", "success");
  }

  async function addNeighbor() {
    const agent_id = neighborIdInput.value.trim();
    const base_url = neighborUrlInput.value.trim();
    if (!agent_id || !base_url) {
      toast("请填写邻居 Agent ID 和地址", "error");
      return;
    }
    const res = await fetch("/v1/neighbors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id, base_url }),
    });
    const data = await res.json();
    if (data.ok) {
      neighborIdInput.value = "";
      neighborUrlInput.value = "";
      await refreshNeighbors();
      toast("邻居已添加", "success");
    }
  }

  async function refreshNeighbors() {
    const res = await fetch("/v1/neighbors");
    const data = await res.json();
    renderNeighbors(data.neighbors);
  }

  saveConfigBtn.addEventListener("click", saveConfig);
  masterRegisterBtn.addEventListener("click", async () => {
    const url = masterUrlInput.value.trim();
    if (!url) {
      toast("请输入 Master 地址", "error");
      return;
    }
    try {
      const res = await fetch("/master/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ center_url: url }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || "注册申请发送失败", "error");
        return;
      }
      renderMasterStatus(data.status);
      toast("注册申请已发送", "success");
    } catch (err) {
      toast(`发送失败: ${err.message}`, "error");
    }
  });
  addNeighborBtn.addEventListener("click", addNeighbor);
  refreshNeighborsBtn.addEventListener("click", refreshNeighbors);

  sendNeighborBtn.addEventListener("click", async () => {
    const to_agent_id = sendNeighborSelect.value;
    const prompt = sendNeighborPrompt.value.trim();
    if (!to_agent_id || !prompt) {
      toast("请选择邻居并填写任务内容", "error");
      return;
    }
    const res = await fetch("/v1/send-task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_agent_id, prompt }),
    });
    const data = await res.json();
    if (data.ok) {
      sendNeighborPrompt.value = "";
      toast(`任务已发送: ${data.task_id}`, "success");
    } else {
      toast(`发送失败: ${data.error || res.status}`, "error");
    }
  });

  leaderConsultBtn.addEventListener("click", async () => {
    const text = leaderConsultInput.value.trim();
    if (!text) {
      toast("请输入咨询内容", "error");
      return;
    }
    leaderConsultResult.textContent = "发送中…";
    try {
      const res = await fetch("/v1/leader/consult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const data = await res.json();
      if (data.ok) {
        leaderConsultInput.value = "";
        leaderConsultResult.textContent = "✅ 已入队，请在终端中等待 Agent 回应";
      } else {
        leaderConsultResult.textContent = `❌ ${data.error || "失败"}`;
      }
    } catch (err) {
      leaderConsultResult.textContent = `❌ ${err.message}`;
    }
  });
  leaderConsultInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      leaderConsultBtn.click();
    }
  });

  ws.onopen = () => {
    setStatus("online", true);
  };

  ws.onclose = () => {
    setStatus("offline", false);
    term.write("\r\n[connection lost]\r\n");
  };

  ws.onerror = () => {
    setStatus("error", false);
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }

    if (msg.type === "ready") {
      agentIdEl.textContent = msg.agentId || "-";
      term.resize(msg.cols || 80, msg.rows || 24);
      renderStatus(msg.status);
      fitAddon.fit();
      send({
        type: "resize",
        cols: term.cols,
        rows: term.rows,
      });
    } else if (msg.type === "output") {
      term.write(msg.data);
    } else if (msg.type === "exit") {
      setStatus(`exited (${msg.exitCode})`, false);
      term.write(`\r\n[agent exited code=${msg.exitCode} signal=${msg.signal}]\r\n`);
    } else if (msg.type === "status") {
      renderStatus(msg);
    } else if (msg.type === "task_completed") {
      // Completion is reflected by the following status message.
      // Do NOT write into the terminal screen (avoids overlapping TUIs).
    } else if (msg.type === "agent_started") {
      // Same: avoid writing into the terminal screen.
    } else if (msg.type === "pong") {
      // no-op
    }
  };

  term.onData((data) => {
    // Direct terminal interaction, bypasses the queue.
    send({ type: "input", data });
  });

  function enqueuePrompt() {
    const text = inputEl.value;
    if (!text.trim()) return;
    send({
      type: "enqueue",
      prompt: text,
      reply_to: replyToInput.value.trim() || undefined,
    });
    inputEl.value = "";
  }

  sendBtn.addEventListener("click", enqueuePrompt);
  inputEl.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      enqueuePrompt();
    }
  });

  completionProviderSelect.addEventListener("change", syncCustomReaderVisibility);

  startBtn.addEventListener("click", () => {
    const command = commandInput.value.trim();
    if (!command) {
      toast("请先输入 Agent 启动命令", "error");
      return;
    }
    const cwd = cwdInput.value.trim() || undefined;
    const completionProvider = completionProviderSelect.value;
    const completionConfig =
      completionProvider === "custom"
        ? { file: customReaderFile.value.trim() || undefined }
        : undefined;
    send({ type: "start", command, cwd, completionProvider, completionConfig, terminalEnv: terminalEnvSelect.value, wslDistro: wslDistroInput.value.trim() });
    toast(`正在 ${terminalEnvSelect.value.toUpperCase()} 环境启动 Agent`, "success");
  });

  completeBtn.addEventListener("click", () => {
    send({ type: "complete" });
  });

  syncCustomReaderVisibility();

  window.addEventListener("resize", () => {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      send({
        type: "resize",
        cols: term.cols,
        rows: term.rows,
      });
    }
  });
})();
