# AgentHost 间通信协议设计（v0.1）

> 当前阶段：先实现两个 AgentHost 之间的直接交互，不依赖中心化应用。
> 架构采用“混合模型”：任务提出方持有权威任务记录和共享文件，其他 AgentHost 持有本地参与记录；未来中心化应用只做全局索引和失败列表。

---

## 1. 核心概念

### 1.1 AgentHost 身份

每个 AgentHost 有一个唯一标识和可被回调的地址：

```json
{
  "agent_id": "codex-01",
  "base_url": "http://127.0.0.1:9100",
  "callback_url": "http://127.0.0.1:9100/v1/tasks/:taskId/reply"
}
```

- `agent_id`：全局唯一
- `base_url`：其他节点访问本节点的根地址
- `callback_url`：任务完成后/更新时，接收方应该回调的地址（通常由请求方在 header 中给出）

### 1.2 Task

Task 是一个持久化工作实体，不是一次性消息：

```json
{
  "task_id": "task-001",
  "title": "实现登录模块",
  "description": "最初的完整目标",
  "status": "active",
  "current_owner": "agent-b",
  "participants": ["agent-a", "agent-b"],
  "round": 3,
  "max_rounds": 10,
  "hops": 1,
  "max_hops": 5,
  "visited_agents": ["agent-a", "agent-b"],
  "latest_reply": {
    "agent_id": "agent-b",
    "content": "B 的最新回复",
    "at": "2026-08-19T..."
  },
  "history": [
    { "round": 1, "agent": "agent-a", "type": "reply", "content": "..." }
  ],
  "shared_store_url": "http://agent-a:9100/v1/tasks/task-001/files",
  "created_by": "agent-a",
  "created_at": "...",
  "terminated_at": null
}
```

### 1.3 权威状态

- **任务提出方**（`created_by`）持有 Task 的权威记录和共享文件。
- **其他参与者**只保存本地参与记录/缓存。
- 未来中心化应用持有全局索引和失败任务列表，但不复制详细历史。

---

## 2. HTTP 公共头

所有 AgentHost 间请求都应携带以下 header：

| Header | 必填 | 说明 |
|---|---|---|
| `X-Request-Id` | 是 | 全局唯一请求 ID，用于追踪和幂等 |
| `X-From` | 是 | 发送方 `agent_id` |
| `X-Reply-To` | 视接口 | 接收方完成/更新时应该回调的 URL |
| `X-Task-Origin` | 视接口 | 任务提出方的 `base_url`，用于定位权威 Task 和共享文件 |
| `Authorization` | 否 | 预留鉴权 |

示例：

```http
POST /v1/tasks
Content-Type: application/json
X-Request-Id: 7f9f...
X-From: agent-a
X-Reply-To: http://127.0.0.1:9100/v1/tasks/task-001/reply
X-Task-Origin: http://127.0.0.1:9100
```

---

## 3. 接口定义

### 3.1 创建/投递任务

**`POST /v1/tasks`**（接收方：目标 AgentHost）

请求体：

```json
{
  "task_id": "task-001",
  "title": "实现登录模块",
  "description": "请实现一个登录模块",
  "context": {
    "shared_store_url": "http://agent-a:9100/v1/tasks/task-001/files",
    "max_hops": 5,
    "max_rounds": 10
  }
}
```

响应 `202 Accepted`：

```json
{
  "ok": true,
  "agent_id": "agent-b",
  "task_id": "task-001",
  "status": "queued"
}
```

接收方行为：

1. 校验 `task_id` 是否已存在；存在则幂等返回。
2. 生成本地参与记录。
3. 包装成 InboundQueueItem 入队。

---

### 3.2 回复/更新任务

**`POST /v1/tasks/:taskId/reply`**（接收方：通常是任务提出方）

请求体：

```json
{
  "task_id": "task-001",
  "status": "active",
  "round": 2,
  "agent_id": "agent-b",
  "content": "B 完成了 spec，等待下一步指示",
  "files": ["spec.md"],
  "shared_store_url": "http://agent-a:9100/v1/tasks/task-001/files"
}
```

如果任务结束：

```json
{
  "task_id": "task-001",
  "status": "completed",
  "final_output": "登录模块已实现",
  "files": ["login.py"]
}
```

响应 `200 OK`：

```json
{ "ok": true }
```

接收方行为：

1. 更新权威 Task 记录。
2. 把回复追加到 `history`。
3. 更新 `latest_reply`。
4. 如果 `status` 是终态，标记任务结束，并触发清理通知。

---

### 3.3 转交任务（Handoff）

**`POST /v1/tasks/:taskId/handoff`**（接收方：下一个 AgentHost）

请求体：

```json
{
  "task_id": "task-001",
  "to_agent_id": "agent-c",
  "note": "我完成了 spec，请你实现代码",
  "context": {
    "latest_reply": "这是 A/B 的最新回复",
    "shared_store_url": "http://agent-a:9100/v1/tasks/task-001/files",
    "participants": ["agent-a", "agent-b", "agent-c"],
    "round": 3,
    "hops": 2,
    "max_hops": 5,
    "max_rounds": 10,
    "visited_agents": ["agent-a", "agent-b"]
  }
}
```

响应 `202 Accepted`：

```json
{ "ok": true, "task_id": "task-001", "status": "queued" }
```

接收方行为：

1. 校验 `hops` / `max_hops`、`round` / `max_rounds`。
2. 超限则直接向 `X-Task-Origin` 发送 `terminate`。
3. 否则入队，`current_owner` 更新为接收方。

---

### 3.4 终止任务

**`POST /v1/tasks/:taskId/terminate`**（接收方：任务提出方/所有参与者）

请求体：

```json
{
  "task_id": "task-001",
  "status": "completed",
  "reason": "目标已实现",
  "final_output": "最终结果",
  "failed": false
}
```

响应 `200 OK`。

接收方行为：

1. 标记 Task 终态。
2. 如果超限，记录失败原因。
3. 向所有参与者发送清理通知。

---

### 3.5 任务清单

**`GET /v1/tasks`**（本 AgentHost 上自己参与/创建的任务）

```json
{
  "tasks": [
    {
      "task_id": "task-001",
      "title": "实现登录模块",
      "status": "active",
      "current_owner": "agent-b",
      "round": 3,
      "latest_reply": "...",
      "shared_store_url": "...",
      "updated_at": "..."
    }
  ]
}
```

---

### 3.6 任务详情

**`GET /v1/tasks/:taskId`**

```json
{
  "task_id": "task-001",
  "title": "...",
  "status": "active",
  "participants": ["agent-a", "agent-b"],
  "round": 3,
  "hops": 2,
  "history": [...],
  "shared_store_url": "...",
  "files": ["spec.md"]
}
```

---

### 3.7 共享文件

**`GET /v1/tasks/:taskId/files`** —— 列出文件

**`GET /v1/tasks/:taskId/files/:name`** —— 下载文件

**`PUT /v1/tasks/:taskId/files/:name`** —— 上传/更新文件

```http
PUT /v1/tasks/task-001/files/spec.md
Content-Type: text/plain

文件内容...
```

响应：

```json
{ "ok": true, "name": "spec.md", "size": 123 }
```

---

### 3.8 清理通知

**`POST /v1/events/task-terminated`**（接收方：所有参与过该任务的 AgentHost）

```json
{
  "task_id": "task-001",
  "status": "completed",
  "reason": "目标已实现"
}
```

接收方行为：

1. 从本地任务清单中移除或归档该任务。
2. 释放本地缓存的共享文件（可选）。

---

## 4. 队列实体设计

### 4.1 InboundQueueItem

```json
{
  "queue_id": "q-in-001",
  "type": "new_task",
  "task_id": "task-001",
  "payload": {
    "prompt": "请实现登录模块",
    "context": {}
  },
  "reply": {
    "url": "http://agent-a:9100/v1/tasks/task-001/reply",
    "request_id": "7f9f...",
    "from": "agent-a",
    "task_origin": "http://agent-a:9100",
    "headers": {}
  },
  "enqueued_at": "..."
}
```

出队给 Agent 时“解封装”：

```json
{
  "task_id": "task-001",
  "prompt": "请实现登录模块",
  "reply": {
    "url": "...",
    "request_id": "...",
    "from": "agent-a"
  }
}
```

### 4.2 OutboundQueueItem

```json
{
  "queue_id": "q-out-001",
  "type": "task_reply",
  "to": "http://agent-a:9100/v1/tasks/task-001/reply",
  "request_id": "7f9f...",
  "task_id": "task-001",
  "payload": {
    "status": "active",
    "agent_id": "agent-b",
    "content": "B 的最新回复",
    "round": 2
  }
}
```

发送队列 worker：

```
出队 -> HTTP POST to -> 成功标记 sent
                     -> 失败指数退避重试（最多 3 次）
                     -> 仍失败标记 callback_failed，人工可查
```

---

## 5. 任务状态机

```
active
  ├──> completed
  ├──> failed
  ├──> canceled
  └──> max_hops_exceeded
```

- `active`：还在多 Agent 间流转
- `completed`：某个 Agent 认定完成
- `failed`：执行失败
- `canceled`：被取消
- `max_hops_exceeded`：超过最大跳转/轮次

---

## 6. 防死循环机制

| 机制 | 说明 |
|---|---|
| `max_hops` | 任务最多转手给多少个不同 Agent |
| `max_rounds` | 任务最多发生多少轮回复 |
| `visited_agents` | 记录访问过的 Agent，可检测循环 |
| 幂等 | 同一 `task_id` 重复投递返回已有状态 |
| 超时 | 任务长时间无进展自动失败（后续加） |

---

## 7. 实现顺序建议

1. **TaskStore**：每个 AgentHost 内存维护 Task 记录（权威/参与）
2. **Inbound/Outbound 队列升级**：支持 `type` 和 `reply` 元数据
3. **API**：`POST /v1/tasks`、`POST /v1/tasks/:id/reply`、`GET /v1/tasks`、`GET /v1/tasks/:id`
4. **Outbound worker**：HTTP 回调
5. **共享文件**：`GET/PUT /v1/tasks/:id/files/*`
6. **Handoff + Terminate + 清理通知**
7. **接入中心化应用**：注册、全局索引、失败列表
