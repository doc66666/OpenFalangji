(function () {
  "use strict";

  // UI language is intentionally client-local: a shared Master must not let
  // one operator change the display language for every other operator.
  const translations = {
    en: {
      "刷新状态": "Refresh", "01 / 总览": "01 / Overview", "02 / Hosts": "02 / Hosts",
      "03 / 注册审批": "03 / Registration", "04 / 任务中心": "04 / Tasks",
      "05 / 权限": "05 / Permissions", "06 / 设置": "06 / Settings",
      "系统总览": "System overview", "目录、状态与任务故障面板": "Directory, health, and task fault dashboard",
      "已注册节点": "Registered nodes", "心跳正常": "Healthy heartbeats", "等待审批": "Awaiting approval", "正在协作": "In collaboration",
      "控制面，不是消息中转站": "A control plane, not a message relay",
      "Master 管理注册、邻居发现、Leader 和全局任务状态。业务内容继续由 AgentHost 之间直接传递。": "Master manages registration, discovery, leaders, and global task state. Work content continues directly between AgentHosts.",
      "查看 Hosts →": "View Hosts →", "故障会传播，状态会恢复": "Failures propagate; state recovers",
      "Host 失联会终止受影响任务；终态任务通过广播与心跳同步清理，Master 状态已持久化。": "A lost Host terminates affected tasks; terminal state is synchronized by broadcasts and heartbeats, and Master state is persistent.",
      "打开任务中心 →": "Open Tasks →", "权限跟随 Host 配置": "Permissions follow Host configuration",
      "在 Hosts 页面为每个节点设置“全部可见”或允许发现它的 Host 白名单。": "Set each node to visible to all Hosts or restrict discovery to a Host allowlist on the Hosts page.",
      "前往 Hosts": "Go to Hosts", "Master 状态文件": "Master state file",
      "默认保存到": "Saved by default to", "也可通过": "or configure it with",
      "指定。": ".", "本地安全边界": "Local security boundary",
      "当前仅监听 127.0.0.1。跨主机部署前应增加认证、TLS 和来源校验。": "The service listens only on 127.0.0.1. Add authentication, TLS, and origin validation before multi-host deployment.",
      "权限设置": "Permission settings", "允许全部 Host 发现我": "Allow discovery by all Hosts", "仅允许以下 Host 发现我": "Allow discovery only by these Hosts", "取消": "Cancel", "保存": "Save"
    }
  };
  const textOriginal = new WeakMap();
  function localize(root = document.body) {
    const lang = localStorage.getItem("openfalangji-language") || "zh";
    document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
    document.title = lang === "en" ? "OpenFalangji / Master" : "OpenFalangji / Master 控制台";
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (["SCRIPT", "STYLE"].includes(node.parentElement?.tagName) || node.parentElement?.id === "language-toggle") return;
      const base = textOriginal.get(node) ?? node.nodeValue;
      textOriginal.set(node, base);
      const key = base.trim(); const translated = translations[lang]?.[key];
      if (translated) node.nodeValue = base.replace(key, translated);
      else if (lang === "zh") node.nodeValue = base;
    });
    document.querySelectorAll("[placeholder],[title],[aria-label]").forEach((el) => {
      ["placeholder", "title", "aria-label"].forEach((attr) => {
        if (!el.hasAttribute(attr)) return;
        const key = `i18n-${attr}`;
        const base = el.dataset[key] ?? el.getAttribute(attr);
        el.dataset[key] = base;
        el.setAttribute(attr, translations[lang]?.[base] || base);
      });
    });
    const toggle = document.getElementById("language-toggle");
    if (toggle) {
      const nextLabel = lang === "en" ? "中文" : "EN";
      toggle.dataset.language = lang;
      toggle.textContent = nextLabel;
      requestAnimationFrame(() => { toggle.textContent = nextLabel; });
    }
  }
  function setLanguage(lang) { localStorage.setItem("openfalangji-language", lang); localize(); }
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("language-toggle")?.addEventListener("click", () =>
      setLanguage((localStorage.getItem("openfalangji-language") || "zh") === "zh" ? "en" : "zh"));
    localize();
    new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) localize(node);
    }))).observe(document.body, { childList: true, subtree: true });
  });

  const tbody = document.getElementById("host-tbody");
  const summaryEl = document.getElementById("host-summary");
  const regTbody = document.getElementById("registration-tbody");
  const regSummaryEl = document.getElementById("registration-summary");
  const taskTbody = document.getElementById("task-tbody");
  const taskSummaryEl = document.getElementById("task-summary");
  const refreshBtn = document.getElementById("refresh-btn");
  const modal = document.getElementById("permission-modal");
  const permissionAgentLabel = document.getElementById("permission-agent-label");
  const allowedHostsList = document.getElementById("allowed-hosts-list");
  const cancelBtn = document.getElementById("permission-cancel-btn");
  const saveBtn = document.getElementById("permission-save-btn");
  const metricHosts = document.getElementById("metric-hosts");
  const metricOnline = document.getElementById("metric-online");
  const metricPending = document.getElementById("metric-pending");
  const metricTasks = document.getElementById("metric-tasks");

  let agents = [];
  let registrations = [];
  let tasks = [];
  let editingAgentId = null;

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusClass(status, online) {
    if (online === false) return "status-offline";
    if (status === "running") return "status-online";
    return "status-stopped";
  }

  function statusText(status, online) {
    if (online === false) return "offline";
    if (status === "running") return "online";
    return status || "stopped";
  }

  function permissionsText(p) {
    if (!p) return "允许全部";
    if (p.allow_all === true) return "允许全部";
    return `仅 ${(p.allowed_hosts || []).length} 个 Host`;
  }

  async function loadAgents() {
    try {
      const res = await fetch("/v1/agents");
      const data = await res.json();
      agents = data.agents || [];
      renderTable();
      renderMetrics();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="9" class="muted">加载失败: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function loadRegistrations() {
    try {
      const res = await fetch("/v1/registrations");
      const data = await res.json();
      registrations = data.registrations || [];
      renderRegistrations();
      renderMetrics();
    } catch (err) {
      regTbody.innerHTML = `<tr><td colspan="6" class="muted">加载失败: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  async function loadTasks() {
    try {
      const res = await fetch("/v1/tasks");
      const data = await res.json();
      tasks = data.tasks || [];
      renderTasks();
      renderMetrics();
    } catch (err) {
      taskTbody.innerHTML = `<tr><td colspan="9" class="muted">加载失败: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function renderTable() {
    if (agents.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">暂无注册的 Host</td></tr>';
      summaryEl.textContent = "共 0 个 Host";
      return;
    }
    const onlineCount = agents.filter((a) => a.online !== false).length;
    summaryEl.textContent = `共 ${agents.length} 个 Host，在线 ${onlineCount} 个`;

    tbody.innerHTML = agents
      .map((a) => {
        const cls = statusClass(a.status, a.online);
        const st = statusText(a.status, a.online);
        const agentAlive = a.agent_alive === true;
        const agentCls = agentAlive ? "status-online" : "status-stopped";
        const agentSt = a.online === false ? "-" : agentAlive ? "运行中" : "已停止";
        const leaderBadge = a.is_leader ? ' <span class="status-badge status-online">Leader</span>' : "";
        const leaderBtn = a.is_leader
          ? `<button class="btn secondary" data-unleader="${escapeHtml(a.agent_id)}">取消 Leader</button>`
          : `<button class="btn secondary" data-leader="${escapeHtml(a.agent_id)}">设为 Leader</button>`;
        return `<tr>
          <td><b>${escapeHtml(a.agent_id)}</b>${leaderBadge}</td>
          <td>${escapeHtml(a.base_url)}</td>
          <td>${escapeHtml(a.mode || "-")}</td>
          <td><span class="status-badge ${cls}">${escapeHtml(st)}</span></td>
          <td><span class="status-badge ${agentCls}">${escapeHtml(agentSt)}</span></td>
          <td>${escapeHtml(a.command || "-")}</td>
          <td>${escapeHtml(a.last_seen || "-")}</td>
          <td>${escapeHtml(permissionsText(a.permissions))}</td>
          <td>
            <button class="btn secondary" data-edit="${escapeHtml(a.agent_id)}">编辑权限</button>
            ${leaderBtn}
          </td>
        </tr>`;
      })
      .join("");
  }

  function renderMetrics() {
    if (!metricHosts) return;
    metricHosts.textContent = agents.length;
    metricOnline.textContent = agents.filter((a) => a.online !== false).length;
    metricPending.textContent = registrations.filter((r) => r.status === "pending").length;
    metricTasks.textContent = tasks.filter((t) => ["active", "queued", "running"].includes(t.status)).length;
  }

  function renderTasks() {
    if (tasks.length === 0) {
      taskTbody.innerHTML = '<tr><td colspan="9" class="muted">暂无任务</td></tr>';
      taskSummaryEl.textContent = "共 0 个任务";
      return;
    }
    const activeCount = tasks.filter((t) => t.status === "active" || t.status === "queued" || t.status === "running").length;
    taskSummaryEl.textContent = `共 ${tasks.length} 个任务，活跃 ${activeCount} 个`;
    taskTbody.innerHTML = tasks
      .map((t) => {
        const statusCls =
          t.status === "completed" ? "status-online" :
          t.status === "failed" || t.status === "max_hops_exceeded" ? "status-offline" :
          "status-stopped";
        return `<tr>
          <td><b>${escapeHtml(t.task_id)}</b></td>
          <td>${escapeHtml(t.title || "-")}</td>
          <td><span class="status-badge ${statusCls}">${escapeHtml(t.status)}</span></td>
          <td>${escapeHtml(t.created_by || "-")}</td>
          <td>${escapeHtml(t.current_owner || "-")}</td>
          <td>${escapeHtml((t.participants || []).join(", ") || "-")}</td>
          <td>${escapeHtml(t.created_at || "-")}</td>
          <td>${escapeHtml(t.terminated_at || "-")}</td>
          <td>${escapeHtml(t.termination_reason || "-")}</td>
        </tr>`;
      })
      .join("");
  }

  function renderRegistrations() {
    const pending = registrations.filter((r) => r.status === "pending").length;
    regSummaryEl.textContent = `共 ${registrations.length} 条申请，等待审批 ${pending} 条`;

    if (registrations.length === 0) {
      regTbody.innerHTML = '<tr><td colspan="6" class="muted">暂无注册申请</td></tr>';
      return;
    }

    regTbody.innerHTML = registrations
      .map((r) => {
        const statusCls =
          r.status === "pending"
            ? "status-stopped"
            : r.status === "approved"
              ? "status-online"
              : "status-offline";
        const actions =
          r.status === "pending"
            ? `<button class="btn primary" data-approve="${escapeHtml(r.id)}">确认</button> ` +
              `<button class="btn secondary" data-reject="${escapeHtml(r.id)}">拒绝</button>`
            : `<span class="muted">${escapeHtml(r.status)}</span>`;
        return `<tr>
          <td>${escapeHtml(r.created_at || "-")}</td>
          <td><b>${escapeHtml(r.agent_id)}</b></td>
          <td>${escapeHtml(r.base_url)}</td>
          <td>${escapeHtml(r.mode || "-")}</td>
          <td><span class="status-badge ${statusCls}">${escapeHtml(r.status)}</span></td>
          <td>${actions}</td>
        </tr>`;
      })
      .join("");
  }

  function switchModule(name) {
    document.querySelectorAll(".nav-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.module === name);
    });
    document.querySelectorAll(".module").forEach((el) => {
      el.classList.toggle("hidden", el.id !== `module-${name}`);
    });
    const titles = {
      overview: "系统总览",
      hosts: "Host 列表",
      registrations: "注册申请",
      tasks: "任务中心",
      permissions: "权限管理",
      settings: "设置",
    };
    document.getElementById("page-title").textContent = titles[name] || name;
    location.hash = name;
    if (name === "overview") { loadAgents(); loadRegistrations(); loadTasks(); }
    if (name === "registrations") loadRegistrations();
    if (name === "tasks") loadTasks();
  }

  function openPermissionModal(agent) {
    editingAgentId = agent.agent_id;
    permissionAgentLabel.textContent = `${agent.agent_id} @ ${agent.base_url}`;
    const p = agent.permissions || { allow_all: true, allowed_hosts: [] };
    const allowAll = p.allow_all !== false;
    document.querySelectorAll('input[name="allow-all"]').forEach((radio) => {
      radio.checked = radio.value === (allowAll ? "all" : "some");
    });
    renderAllowedHosts(allowAll ? [] : p.allowed_hosts || []);
    modal.classList.remove("hidden");
  }

  function renderAllowedHosts(selectedHosts) {
    const others = agents.filter((a) => a.agent_id !== editingAgentId);
    if (others.length === 0) {
      allowedHostsList.innerHTML = '<div class="muted">暂无其他 Host</div>';
      return;
    }
    allowedHostsList.innerHTML = others
      .map((a) => {
        const checked = selectedHosts.includes(a.agent_id);
        return `<label><input type="checkbox" value="${escapeHtml(a.agent_id)}" ${checked ? "checked" : ""} /> ${escapeHtml(a.agent_id)} @ ${escapeHtml(a.base_url)}</label>`;
      })
      .join("");
  }

  function closeModal() {
    modal.classList.add("hidden");
    editingAgentId = null;
  }

  async function savePermissions() {
    if (!editingAgentId) return;
    const allowAll = document.querySelector('input[name="allow-all"]:checked').value === "all";
    const allowedHosts = Array.from(
      allowedHostsList.querySelectorAll('input[type="checkbox"]:checked')
    ).map((cb) => cb.value);
    try {
      const res = await fetch(`/v1/agents/${encodeURIComponent(editingAgentId)}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow_all: allowAll, allowed_hosts: allowedHosts }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`保存失败: ${data.error || res.status}`);
        return;
      }
      closeModal();
      await loadAgents();
    } catch (err) {
      alert(`保存失败: ${err.message}`);
    }
  }

  async function decideRegistration(id, action) {
    try {
      const res = await fetch(`/v1/registrations/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`操作失败: ${data.error || res.status}`);
        return;
      }
      await loadRegistrations();
      await loadAgents();
    } catch (err) {
      alert(`操作失败: ${err.message}`);
    }
  }

  document.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      switchModule(el.dataset.module);
    });
  });

  document.querySelectorAll(".jump-link").forEach((el) => {
    el.addEventListener("click", () => switchModule(el.dataset.jump));
  });

  refreshBtn.addEventListener("click", () => {
    loadAgents();
    loadRegistrations();
    loadTasks();
  });

  tbody.addEventListener("click", (ev) => {
    const editBtn = ev.target.closest("button[data-edit]");
    if (editBtn) {
      const agent = agents.find((a) => a.agent_id === editBtn.dataset.edit);
      if (agent) openPermissionModal(agent);
      return;
    }
    const leaderBtn = ev.target.closest("button[data-leader]");
    if (leaderBtn) {
      setLeader(leaderBtn.dataset.leader, true);
      return;
    }
    const unleaderBtn = ev.target.closest("button[data-unleader]");
    if (unleaderBtn) {
      setLeader(unleaderBtn.dataset.unleader, false);
    }
  });

  async function setLeader(agentId, isLeader) {
    try {
      const res = await fetch("/v1/leader", {
        method: isLeader ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: isLeader ? JSON.stringify({ agent_id: agentId }) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(`设置失败: ${data.error || res.status}`);
        return;
      }
      await loadAgents();
    } catch (err) {
      alert(`设置失败: ${err.message}`);
    }
  }

  regTbody.addEventListener("click", (ev) => {
    const approveBtn = ev.target.closest("button[data-approve]");
    if (approveBtn) {
      decideRegistration(approveBtn.dataset.approve, "approve");
      return;
    }
    const rejectBtn = ev.target.closest("button[data-reject]");
    if (rejectBtn) {
      decideRegistration(rejectBtn.dataset.reject, "reject");
    }
  });

  document.querySelectorAll('input[name="allow-all"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const allowAll = document.querySelector('input[name="allow-all"]:checked').value === "all";
      renderAllowedHosts(allowAll ? [] : (agents.find((a) => a.agent_id === editingAgentId)?.permissions?.allowed_hosts || []));
    });
  });

  cancelBtn.addEventListener("click", closeModal);
  saveBtn.addEventListener("click", savePermissions);
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) closeModal();
  });

  // Poll every 5s to keep online/registration status fresh.
  loadAgents();
  loadRegistrations();
  loadTasks();
  const initialModule = location.hash.replace("#", "");
  if (["overview", "hosts", "registrations", "tasks", "permissions", "settings"].includes(initialModule)) {
    switchModule(initialModule);
  }
  setInterval(() => {
    loadAgents();
    loadRegistrations();
  }, 5000);
})();
