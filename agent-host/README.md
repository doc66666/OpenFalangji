# AgentHost

本地 Agent 终端宿主服务。

AgentHost 自己创建 PTY/ConPTY 并启动 Agent CLI，因此天然拥有终端的完整输入输出权。它对外暴露一个本地网络服务，并提供 Web 终端管理页。

## 能力

- 创建 PTY 并启动 Agent CLI（`claude` / `codex` / 任意 shell 命令）
- 管理页可自定义输入 Agent 启动命令和工作目录，随时启动/重启
  - 工作目录用于：Agent 进程的 `cwd`、CompletionDetector 定位会话历史
  - 避免在错误目录启动 Agent 造成文件污染
- 两个消息队列：
  - 接收队列：输入框/`/enqueue` 的任务先入队
  - 发送队列：已完成任务的结果
  - 严格按“上一个任务完成后再发下一个”，不是看输入框是否空闲
- 可扩展的 CompletionDetector：
  - 通过读取 Agent 自己的会话历史/日志判断任务是否真正完成
  - 当前已支持：`opencode`（SQLite）、`claude`（JSONL）、`codex`（rollout JSONL）、`pi`（JSONL）
  - `manual` 作为兜底
  - 管理页下拉框可选择：自动 / opencode / Claude Code / Codex / pi / 手动 / 自定义 Reader
  - 自定义 Reader：选择 `custom` 后填写 JS 文件路径，由用户注入自己的读取逻辑
  - CLI：`--completion-provider opencode|claude|codex|pi|manual|custom`
  - 自定义 Reader 文件：`--completion-config-file <path>`
  - 默认根据启动命令自动识别
  - 会话定位安全：按“用户指定的工作目录 + AgentHost 本次启动时间”锁定当前活跃会话，避免读错目录/旧 session
- 暴露本地 HTTP 端口：
  - `GET  /health`   健康状态
  - `GET  /status`   详细状态
  - `GET  /queue`    队列状态
  - `POST /start`    启动/重启 Agent（`{command, cwd?}`）
  - `POST /enqueue`  任务入队（`{prompt, task_id?, expect_marker?}`）
  - `POST /inbox`    兼容别名，等同 `/enqueue`
  - `POST /complete` 手动标记当前任务完成
  - `POST /interrupt` 发送 Ctrl-C
  - `POST /stop`     停止 AgentHost
  - `GET  /v1/tasks/:taskId/log`  读取共享任务日志（JSON 或 `?format=text`）
  - `POST /v1/tasks/:taskId/log`  写入共享任务日志（Q&A）
  - `WS   /ws`       WebSocket 双向终端通道
- Web 管理页：
  - 实时终端（xterm.js）
  - Agent 启动命令输入框
  - 队列状态展示
  - 管理端输入框（入队发送）
  - “标记当前任务完成”按钮
- 默认尝试打开一个系统终端窗口供用户观察
  - Windows: 优先 Windows Terminal，退回新控制台窗口
  - WSL: 优先 Windows Terminal（`wt.exe`），退回 Windows 控制台窗口
  - macOS: Terminal.app
  - Linux: `$TERMINAL` / gnome-terminal / konsole / xterm 等

## 安装

```bash
cd agent-host
npm install
```

> `node-pty` 需要本地编译，Linux 需要 `make` 和 `gcc/g++`。

## 运行

```bash
# 启动一个 bash 作为演示 agent
npm start -- --agent-id demo --command "bash" --port 9101

# 启动 claude
npm start -- --agent-id claude-01 --command "claude" --port 9102

# 启动 codex
npm start -- --agent-id codex-01 --command "codex exec" --port 9103

# 不开系统终端窗口（纯 headless）
npm start -- --agent-id demo --command "bash" --no-open-terminal --port 9101

# Windows Host 上使用 WSL 运行 Agent
npm start -- --agent-id claude-wsl --command "claude" --port 9102 \
  --terminal-env wsl --wsl-distro FedoraLinux-43 --cwd D:\\OpenFalangji
```

启动后：

- Web 管理端：`http://127.0.0.1:<port>/`
- 健康检查：`http://127.0.0.1:<port>/health`

Windows 下可在管理页“设置 → 终端环境”选择 Windows 原生或 WSL。WSL 模式可指定发行版，并会把 `D:\\project` 形式的工作目录自动转换为 `/mnt/d/project`。Claude Code 的 TUI 提交采用“先写文本、再延时独立发送 Enter”，避免大段 Prompt 的末尾回车被当作粘贴内容吞掉。

## 持久化

- 每个任务保存 `task.json`、`history.jsonl`、`log.jsonl` 和共享文件；
- Host 的运行配置、邻居、接收/发送队列、脏任务 ID 保存为 `<agent-id>-host-state.json`；
- Host 重启时，未完成的当前任务会重新回到接收队列；
- 默认目录仍为 `~/.agent-host/tasks/`。

## 发送任务

```bash
curl -X POST http://127.0.0.1:9101/inbox \
  -H "Content-Type: application/json" \
  -d '{"prompt": "请实现登录模块", "task_id": "t1"}'
```

## 接入 Master（中心发现）

```bash
node src/index.js --agent-id claude-01 --command "claude" --port 9102 \
  --center-url http://127.0.0.1:9300
```

接入后 AgentHost 不会直接注册，而是先向 Master **提交注册申请**：

1. 启动时向 Master `POST /v1/registrations` 提交申请；
2. Master 管理员确认后，AgentHost 轮询到 `approved`，开始：
   - 每 5s 心跳；
   - 每 10s 从 Master 拉取在线 Agent，以 Master 返回为准替换邻居列表；
3. 如果被拒绝，则状态显示“被拒绝”，不会心跳/发现邻居；
4. 停止时注销（best-effort）。

也可以在 AgentHost 管理页的“Master 地址”输入框填写 `http://127.0.0.1:9300`，点击“发送注册申请”。

管理页会在状态旁边显示：**未申请 / 等待中 / 已注册 / 被拒绝**。

## 共享任务日志

任务模式下，AgentHost 会在 prompt 中给出 `Log URL`，并要求 Agent **先读取任务日志再执行**。

- 日志文件保存在**任务提出方**的 `~/.agent-host/tasks/<task_id>/log.jsonl`；
- 每个参与 Host 在完成一轮执行后，会把“原始问题 + Agent 回答”硬编码写回任务提出方的 `/v1/tasks/:id/log`；
- 读接口支持 JSON 和纯文本：`GET /v1/tasks/:id/log?format=text`；
- 写接口：`POST /v1/tasks/:id/log`，body 示例：

```json
{
  "task_id": "task-001",
  "agent_id": "agent-b",
  "round": 2,
  "question": "B 你继续",
  "answer": "好的，我继续"
}
```

- 并发控制：读者可并发，写者独占；锁冲突时返回 `423 { "error": "并发读写，请重试" }`，调用方会重试。

## 原生终端观察

默认会尝试打开一个系统终端窗口，里面运行 `terminal-viewer.js`，它会连接 AgentHost 的 WebSocket，把终端键盘输入转发给 Agent PTY，并把输出显示出来。

你也可以手动在任意终端里运行：

```bash
node src/terminal-viewer.js --url ws://127.0.0.1:9101/ws
```

## 目录

```
src/
  index.js             CLI 入口
  agent-host.js        AgentHost 核心服务
  terminal-viewer.js   原生终端观察客户端
  terminal-launcher.js 打开系统终端窗口
public/
  index.html           Web 管理页
  main.js              Web 终端逻辑
```

## 自定义 Reader API

选择 `custom` 后，提供一个 JS 文件，导出以下任一形式：

```js
// 形式 1：继承 BaseCompletionDetector
const { BaseCompletionDetector } = require("agent-host/src/completion-detectors");

class MyReader extends BaseCompletionDetector {
  start(task) {
    super.start(task);
    this.sentAt = Date.now();
  }
  poll() {
    // 在这里读取你自己的 Agent 历史，检测到完成后调用：
    this._finish("干净的回复文本");
  }
}

module.exports = MyReader;
```

```js
// 形式 2：工厂函数
module.exports = function (opts) {
  return {
    start(task) {},
    stop() {},
    poll() {},
  };
};
```

要求：

- 必须有 `start(task)` 和 `stop()`
- 完成时调用 `this._finish(cleanOutput)` 或 `agentHost.completeCurrentTask(cleanOutput)`
- 可通过 `this.agentHost.cwd`、`this.agentHost.agentStartedAt` 定位正确的会话

## 协作能力（v0.2）

- 邻居列表：管理页手动添加邻居（agent_id + base_url），也支持 REST API
- 两种模式：
  - `minimal`：只把原始 prompt 发给 Agent，不跟踪任务，回复给调用方
  - `task`：跟踪任务、轮次、跳转、参与者、共享文件、历史
- 外部 API：
  - `POST /v1/tasks` 接收任务
  - `POST /v1/send-task` 向邻居发送任务
  - `POST /v1/tasks/:id/reply` 接收回复/更新
  - `POST /v1/tasks/:id/terminate` 终止任务
  - `GET /v1/tasks` / `GET /v1/tasks/:id` 任务清单/详情
  - `GET/PUT /v1/tasks/:id/files/*` 共享文件
  - `GET/POST/DELETE /v1/neighbors` 邻居管理
  - `POST /v1/config` 配置 Agent ID / 模式 / 最大跳转
- 任务模式：
  - prompt 会附带任务 ID、来源、轮次、最大跳转、参与者、历史、共享文件地址
  - Agent 可以以 `<<TASK_OVER>>` 结尾表示任务完成
  - 超过 `max_hops` / `max_rounds` 自动标记 `max_hops_exceeded`
- 队列实体：
  - InboundQueueItem 保存完整 HTTP 元数据（reply、request_id、from）
  - 出队给 Agent 时解封装，只保留 prompt 和 reply
  - 完成后重新封装为 OutboundQueueItem，HTTP 回调给调用方

## 下一步

- 接入中心化应用：注册、心跳、任务队列、失败任务列表
- 完善 Claude Code / Codex / pi 的 Reader 实机验证
- 多 Agent 编排与 Handoff
- 面向 Agent 的 P2P 组播清理
