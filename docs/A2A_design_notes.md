# A2A 设计借鉴笔记

> 本文档记录我们从 A2A（Agent2Agent）协议中提取的、对自研 Agent 协作体系有借鉴价值的设计思路。
> 我们**不采用 A2A 作为核心协议**，但会吸收其中一些通用建模思想。

---

## 1. 我们的结论

A2A 的核心定位是“Agent 与 Agent 之间的任务通信协议”，它假设 Agent 已经作为一个网络服务存在。

它**不解决**我们最关心的几个问题：

- 发现本机已运行的 Agent 进程/终端
- 向已有终端窗口写入输入、读取输出
- Agent 进程/会话的生命周期管理
- 开发者实时观察真实运行过程
- 任务编排、DAG、Leader、死锁检测

因此我们决定：**核心体系自研，不依赖 A2A**。

但 A2A 中以下设计思路仍然值得借鉴。

---

## 2. 值得借鉴的设计

### 2.1 Agent 自描述（Agent Card）

**A2A 的做法：**
每个 Agent 对外暴露一份 JSON 元数据，描述名称、描述、接口地址、能力、输入输出模式、技能、安全要求。

**我们可以借鉴：**
每个本地 Agent 在注册时上报一份“Agent 描述”，包括：

```json
{
  "id": "codex-01",
  "name": "Codex",
  "description": "负责写代码和修 bug",
  "transport": "tmux://main",
  "capabilities": ["coding", "terminal"],
  "input_modes": ["text"],
  "output_modes": ["text", "file"],
  "session_modes": ["attach", "spawn"],
  "observe_modes": ["tmux", "web"]
}
```

好处：
- 中心不需要知道“它是哪家产品”，只需要知道“它能干什么、怎么连”。
- 新接入 Agent 时，只改注册信息，不改中心逻辑。

---

### 2.2 会话上下文 ID（context_id）

**A2A 的做法：**
用 `context_id` 把多个 Task / Message 归到同一个会话，表示“继续之前的对话”。

**我们可以借鉴：**
自研协议中维护 `session_id` / `context_id`：

```json
{
  "type": "send",
  "agent": "codex-01",
  "session_id": "login-module",
  "prompt": "继续实现登录模块"
}
```

- 一个 `session_id` 对应一个真实终端会话/窗口。
- 后续任务复用同一个 `session_id`，就是“继续同一个对话”。
- 这比每次新开进程更符合开发者观察需求。

---

### 2.3 任务状态机（Task Lifecycle）

**A2A 的做法：**
Task 有明确生命周期：

```
submitted -> working -> input-required / auth-required -> completed / failed / canceled / rejected
```

**我们可以借鉴：**
自研任务模型也使用状态机：

```json
{
  "task_id": "t1",
  "state": "working",
  "agent": "codex-01",
  "session_id": "login-module"
}
```

状态机好处：
- 中心能知道任务是否卡住、是否需要人工介入。
- 可以统一处理超时、重试、失败。
- 为未来的 DAG 调度提供基础。

---

### 2.4 内容类型分离（Message / Part / Artifact）

**A2A 的做法：**
- Message：一轮对话
- Part：内容片段（文本、文件 URL、内联字节、结构化数据）
- Artifact：任务产物（文档、图片、JSON）

**我们可以借鉴：**
不要只传纯文本，把“输入”和“产物”分开：

```json
{
  "input": {
    "text": "请实现登录模块",
    "files": ["spec.md"]
  },
  "output": {
    "text": "已完成",
    "artifacts": ["/path/to/login.py"]
  }
}
```

好处：
- 后续 Agent 可以直接引用前一个 Agent 的产物文件。
- 结构化数据可以程序化处理，不用解析文本。

---

### 2.5 流式输出（SSE）

**A2A 的做法：**
支持 Server-Sent Events 实时推送任务状态、增量输出、产物更新。

**我们可以借鉴：**
自研 Bridge 的“读取输出”应支持流式：

```text
send prompt
  -> 状态: working
  -> 输出片段1
  -> 输出片段2
  -> 状态: completed
```

这样：
- 开发者/中心能实时看到 Agent 在干什么。
- 不用等整个任务结束才拿结果。
- 可以提前发现卡住或跑偏。

---

### 2.6 异步与推送分离

**A2A 的做法：**
支持同步轮询、流式订阅、Webhook 推送三种模式。

**我们可以借鉴：**
- 短任务：同步返回。
- 长任务：中心通过 WebSocket/SSE 订阅。
- 断连场景：可选 Webhook 通知。

但初期不需要全做，先做“同步 + 流式”即可。

---

### 2.7 注册与发现机制

**A2A 的做法：**
- Well-Known URI：`/.well-known/agent-card.json`
- 注册中心/目录
- 直接配置

**我们可以借鉴：**
自研中心支持三种接入方式：

1. **自动注册**：Agent Bridge 启动时上报中心。
2. **直接配置**：中心配置文件里写死 Agent 地址。
3. **本地发现**：扫描 tmux session / 本地进程列表。

初期建议先做“直接配置 + 自动注册”。

---

### 2.8 传输抽象

**A2A 的做法：**
同一套操作可以映射到 JSON-RPC、REST、gRPC。

**我们可以借鉴：**
自研 Bridge 的接口不要绑死具体传输：

```
Bridge API
  ├── HTTP/JSON
  ├── WebSocket
  └── 本地 IPC（Unix socket / stdin-stdout）
```

好处：
- 本地进程之间可以用轻量 IPC。
- 跨机器时可以用 HTTP/WebSocket。
- 以后想接外部 Agent，可以再加适配层。

---

### 2.9 扩展机制

**A2A 的做法：**
用 URI 标识扩展，支持：
- 纯数据扩展
- Profile 约束扩展
- 新增 RPC 方法扩展
- 状态机扩展

**我们可以借鉴：**
自研协议保留一个 `ext` 字段，允许后续扩展而不破坏核心：

```json
{
  "type": "send",
  "agent": "codex-01",
  "prompt": "hello",
  "ext": {
    "require_observation": true,
    "attach_tmux": "main"
  }
}
```

好处：
- 新需求不用频繁改协议核心。
- 每个扩展可以独立演进。

---

### 2.10 安全声明前置

**A2A 的做法：**
Agent Card 里声明认证方式、安全要求，客户端先看卡再决定怎么调用。

**我们可以借鉴：**
每个 Agent 注册时声明：

```json
{
  "security": {
    "type": "none"
  }
}
```

或者：

```json
{
  "security": {
    "type": "token",
    "location": "header"
  }
}
```

好处：
- 中心统一做鉴权，不用每个 Agent 各自实现。
- 以后接入外部 Agent 时有统一安全模型。

---

## 3. 我们明确不采用/需要自研的部分

| A2A 概念 | 我们的处理 |
|---|---|
| Agent Card 作为唯一发现机制 | 保留“自描述”思想，但用中心注册表实现 |
| Task 协议细节 | 借鉴状态机，但简化字段 |
| Message / Part / Artifact 协议格式 | 借鉴内容分离，但用更简单的 JSON |
| 假设 Agent 是网络服务 | 放弃，改为“发现/附加已有本地进程” |
| 不关心进程生命周期 | 自研：spawn / attach / detach / stop |
| 不关心终端输入输出 | 自研：tmux send-keys / capture-pane / PTY |
| 不关心开发者观察 | 自研：tmux attach / Web 看板 |

---

## 4. 一句话总结

> A2A 给了我们一套不错的“抽象建模”思路：自描述、会话 ID、任务状态、内容分离、流式输出、扩展机制。
> 但它不符合我们的核心场景：**发现并操作本机已有 Agent 进程/终端**。
> 所以我们保留思想，删除实现，自研一套更贴合本地 Agent 协作的轻量协议。
