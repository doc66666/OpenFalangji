# Master

中心化管控应用（最小实现）：**Agent 注册、心跳、邻居发现、前端管理页、Host 可见权限**。

> 设计原则：Master 只做“目录 + 控制面”，不中转业务消息。AgentHost 之间直接 P2P 通信。

## 运行

```bash
cd master
npm start
# 或
node src/index.js --port 9300
```

默认监听 `http://127.0.0.1:9300`，打开 `http://127.0.0.1:9300/` 即前端管理页。

## API

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/` | 前端管理页 |
| `GET` | `/health` | 健康检查 + 在线 Agent 数 |
| `POST` | `/v1/registrations` | Host 提交注册申请 |
| `GET` | `/v1/registrations` | 查看注册申请列表 |
| `GET` | `/v1/registrations/:id` | 查看单个申请 |
| `POST` | `/v1/registrations/:id/approve` | 确认注册 |
| `POST` | `/v1/registrations/:id/reject` | 拒绝注册 |
| `DELETE` | `/v1/registrations/:id` | 取消申请 |
| `POST` | `/v1/agents/register` | （兼容）直接注册/更新 |
| `POST` | `/v1/agents/:agentId/heartbeat` | AgentHost 心跳（仅已确认的 Host 可用） |
| `GET` | `/v1/agents` | 列出所有 Agent |
| `GET` | `/v1/agents/:agentId` | 查看单个 Agent |
| `DELETE` | `/v1/agents/:agentId` | 注销 Agent |
| `GET` | `/v1/agents/:agentId/permissions` | 查看某 Host 的可见权限 |
| `PUT` | `/v1/agents/:agentId/permissions` | 设置可见权限 |
| `GET` | `/v1/neighbors?agent_id=xxx` | 邻居发现：返回允许 xxx 可见的在线 Agent |

权限模型：

- 每条 Host 默认 `allow_all: true`（所有 Host 都能发现它）；
- 可改为 `allow_all: false` + `allowed_hosts: ["host-a", ...]`，只有名单内的 Host 才能通过邻居发现看到它；
- 权限保存在 Master 的独立状态中，Host 或 Master 重启后都可以恢复。

Master 会持久化注册申请、权限、Leader、Host 目录、全局任务索引和终态同步集合。默认文件为 `master/.data/master-state.json`，可用 `--data-file <path>` 覆盖。

注册流程：

1. AgentHost 向 Master 提交注册申请；
2. Master 前端“注册申请”页看到 pending 条目；
3. 管理员点击“确认”或“拒绝”；
4. AgentHost 每 3s 轮询申请状态：
   - `approved` -> 开始心跳 + 邻居发现，状态显示“已注册”；
   - `rejected` -> 状态显示“被拒绝”，不会心跳/发现邻居；
   - `pending` -> 状态显示“等待中”。

心跳超时：

- Master 不会删除心跳超时的 Host，而是保留并标记 `online: false`；
- 邻居发现接口不会把 offline 的 Host 返回给别人；
- Host 会每 10s 重新拉取邻居，因此离线邻居会被移除。
- Master 重启后恢复的 Host 初始为离线状态，收到新心跳后自动恢复在线，无需重新审批。

Agent 存活检测：

- AgentHost 心跳里上报 `agent_alive`（当前是否有 PTY 进程在跑）；
- Master 前端 Host 列表会显示“Agent 状态：运行中 / 已停止”。

## AgentHost 接入

AgentHost 启动时加上 `--center-url`：

```bash
node src/index.js --agent-id test-a --center-url http://127.0.0.1:9300 --port 9120
```

接入后 AgentHost 会自动：

1. 启动时向 Master 注册；
2. 每 5s 心跳一次；
3. 每 10s 从 Master 拉取一次邻居列表，**以 Master 返回为准替换本地邻居表**；
4. 停止时向 Master 注销（best-effort）。

## 示例

```bash
# 注册两个 host
curl -X POST http://127.0.0.1:9300/v1/agents/register \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"test-a","base_url":"http://127.0.0.1:9120","mode":"task"}'

curl -X POST http://127.0.0.1:9300/v1/agents/register \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"test-b","base_url":"http://127.0.0.1:9121","mode":"task"}'

# 邻居发现
curl 'http://127.0.0.1:9300/v1/neighbors?agent_id=test-a'
# => {"agent_id":"test-a","neighbors":[{"agent_id":"test-b","base_url":"http://127.0.0.1:9121",...}]}

# 设置 test-a 只允许 test-b 发现
curl -X PUT http://127.0.0.1:9300/v1/agents/test-a/permissions \
  -H 'Content-Type: application/json' \
  -d '{"allow_all":false,"allowed_hosts":["test-b"]}'
```
