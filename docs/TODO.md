# AgentHost / 多 Agent 协作 TODO

> 这是我们的进行中任务清单。将来你随时可以问我“我们 TODO 到哪了”。

## 已完成

- [x] AgentHost 基础：PTY / 终端 / Web 管理页
- [x] 双队列：接收队列 / 发送队列
- [x] 队列严格按“上一任务完成后再发下一个”
- [x] 管理页自定义 Agent 启动命令 / 工作目录
- [x] 系统终端观察窗口（Windows Terminal / WSL / Linux / macOS）
- [x] CompletionDetector 可扩展架构
- [x] opencode 自动完成检测（SQLite）
- [x] Claude Code / Codex / pi Reader 实现（待实机验证）
- [x] 自定义 Reader 注入机制
- [x] 管理页“完成检测”下拉框
- [x] 邻居列表（手动配置）
- [x] Agent ID / 模式 / 最大跳转配置
- [x] 任务模式 / 极简模式
- [x] Inbound/Outbound HTTP 实体封装/解封装
- [x] 外部 API：/v1/tasks、/v1/send-task、/v1/tasks/:id/reply、/v1/tasks/:id/terminate、文件、邻居、config
- [x] 两个 AgentHost 最小互通测试通过（A 发任务给 B，B 回调 A）
- [x] Master 中心应用（最小版）：Agent 注册 / 心跳 / 邻居发现
- [x] AgentHost 接入 Master：启动注册、周期心跳、自动发现邻居
- [x] Master 前端：侧边栏模块化页面 + Host 列表 + 在线状态
- [x] Master 权限模型：每条 Host 可设置 allow_all / 指定 Host 可见，并持久化到 Host 重启
- [x] AgentHost 共享任务日志：GET/POST /v1/tasks/:id/log，Q&A 写回任务提出方
- [x] 任务日志并发读写锁：读者可并发、写者独占、锁冲突返回“并发读写，请重试”
- [x] 任务 prompt 改为“先读任务日志再执行”，移除旧 URL 禁止指令
- [x] Master 注册审批流：Host 提交申请 -> Master 确认/拒绝 -> Host 轮询状态
- [x] AgentHost 前端：输入 Master 地址发送注册申请 + 显示等待/已注册/被拒绝
- [x] Master 前端：注册申请表（确认/拒绝按钮）
- [x] 心跳超时：Master 保留 Host 并显示离线，邻居发现不再返回离线 Host
- [x] Agent 存活检测：Host 上报 agent_alive（PTY 是否存在），Master 展示
- [x] Master 全局任务索引（AgentHost 上报任务状态到 Master）
- [x] 任务结束广播：Host 向 Master 上报结束，Master 向所有 Host 广播清理
- [x] 回调重试：指数退避，最多 5 次
- [x] 任务超时：`timeout_ms` 到期自动失败
- [x] 任务幂等：同一 task_id 重复投递返回已有状态
- [x] Host 失联/Agent 崩溃检测：Master 注销该 Host，失败其关联任务并广播
- [x] 脏任务标记：清理后再次入队立即移除，Host 离线回来后心跳同步清理
- [x] Claude Code TUI 输入后独立延时发送 Enter
- [x] Windows 原生 ConPTY 与 Windows Host 启动 WSL Agent
- [x] Master / AgentHost Neo-Brutalism 分区式管理界面
- [x] Master 状态、Task 快照、Host 配置和队列持久化恢复

## 待办（按优先级）

- [ ] Master 配置 AgentHost 地址/端口/邻居的接口
- [ ] Handoff 完整闭环：Agent 可通过输出触发转交给下一个 Agent
- [ ] 共享文件跨节点实际拉取测试
- [ ] 持久化压力与损坏恢复测试（当前已有原子 JSON 快照与 JSONL 历史）
- [ ] Claude Code Reader 实机验证
- [ ] Codex Reader 实机验证
- [ ] pi Reader 实机验证
- [ ] WebSocket 事件推送（可选）
- [ ] 面向 Agent 的 P2P 网络（可选）
