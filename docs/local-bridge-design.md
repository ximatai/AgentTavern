# 客户端本地 Agent Bridge 设计

## 1. 目标

本地 Agent 的执行端应运行在用户自己的客户端设备上，而不是服务端。

设计目标：

- 用户可将自己本机的 Agent 引入聊天室
- 服务端只负责房间、审批、任务路由和消息广播
- 本地 Agent 保留自己的上下文与运行环境
- `@Agent` 后由对应客户端本地执行，再把结果回传房间
- 后续可接入 Codex、Claude Code、Cursor、Gemini 等不同本地 Agent

## 2. 三层结构

### 服务端

职责：

- 房间与成员管理
- 助理邀请与审批
- 任务分发
- 流式消息广播
- 持久化关键状态

不负责：

- 直接恢复客户端本地 thread
- 直接拉起用户本机 Agent 进程

### 本地 Bridge

职责：

- 运行在用户自己的设备上
- 接受一次性邀请并注册本地 Agent
- 与服务端保持出站连接
- 接收发往本地 Agent 的任务
- 在本机恢复或启动 Agent
- 将 `started / delta / completed / failed` 回传服务端

### Provider Driver

职责：

- 封装某一类本地 Agent 的具体执行方式
- 将本地 Agent 的能力映射为统一执行事件

第一阶段预留的 driver 方向：

- `codex`
- `claude_code`
- `cursor`
- `gemini`
- `local_process`

## 3. Codex 方向

Codex 采用：

- 本地 Bridge 持有并恢复本机 Codex thread
- 优先使用 Codex SDK 的 `thread / resume` 语义
- 不再以“服务端直接 `codex exec resume`”作为目标架构

当前判断：

- Codex SDK thread/resume 更适合客户端本地执行
- CLI 文本解析只适合作为兜底或过渡方案

## 4. 服务端与 Bridge 的统一协议

服务端与本地 Bridge 之间只定义统一任务协议，不暴露具体 provider 细节。

建议事件：

- `bridge.register`
- `bridge.heartbeat`
- `bridge.agent.attached`
- `bridge.agent.detached`
- `task.assigned`
- `task.accepted`
- `task.delta`
- `task.completed`
- `task.failed`

规则：

- 服务端按 `member -> binding -> bridge connection` 路由任务
- 服务端不直接感知某个 provider 的私有 thread API
- provider 特有字段保留在 binding metadata 或 driver 内部

## 5. 成员与绑定

房间里的 Agent 仍保持现有模型：

- `Member`
- `AgentBinding`
- `AgentSession`

新增约束：

- `AgentBinding` 需要明确归属到某个本地 Bridge
- 一个本地 Agent 的执行位置应可追踪到具体客户端
- 服务端不假定所有 Agent 都可在本机执行

## 6. 邀请与加入

一次性助理邀请仍保留，但加入后的执行模型调整为：

1. 房间成员生成一次性助理邀请 URL
2. 用户本机上的 Bridge 或 skill 接受邀请
3. 服务端创建 `agent member` 与 `binding`
4. binding 后续通过 attach 协议关联到本地 Bridge 与本地 provider 信息
5. 后续被 `@` 时，服务端把任务投递到该 Bridge

## 7. 任务执行

统一执行流程：

1. 房间消息命中 `@Agent`
2. 服务端创建 `AgentSession`
3. 若需要审批，先走审批
4. 审批通过后，服务端向目标 Bridge 下发任务
5. Bridge 在本机调用对应 driver
6. driver 在本机恢复或启动 Agent
7. Bridge 将流式事件回传服务端
8. 服务端广播给房间并固化最终消息

当前已落地的最小协议：

- `register`
- `heartbeat`
- `attach`
- `task pull`
- `task accept`
- `task delta`
- `task complete`
- `task fail`

当前约束：

- `attach` 必须保证同一 binding 在同一时刻只归属一个 Bridge
- `task pull` 必须采用可重试的 claim 语义
- `task accept` 必须采用条件更新
- Bridge 在执行前必须先 `accept`
- 超过租约时间仍未 `accept` 的 `assigned` 任务可重新领取
- Bridge 必须在本机持久化自己的身份信息

当前执行基线：

- 本地 Bridge 已有 driver 分层
- 第一版 `codex_cli` driver 在 Bridge 本机执行
- 当前 `codex_cli` driver 仍是过渡实现，长期目标仍是 SDK thread/resume
- Codex 助理 skill 在接受邀请成功后，会尽量按本机 bridge 身份自动 attach
- `join-agent-tavern` skill 的仓库内源文件基线已建立，仓库内路径为 `tools/skills/join-agent-tavern`

## 8. 边界

第一阶段不追求：

- 服务端直接托管所有本地 Agent
- 服务端直接控制用户本机 thread
- 不同 provider 共用同一种 session/thread 语义

第一阶段优先保证：

- 本地执行位置正确
- 职责边界清晰
- provider 可扩展
- 失败态可收口

## 9. 迁移方向

从当前实现迁移时，按下面顺序推进：

1. 先冻结“服务端不再直接恢复客户端本地 Codex thread”这一原则
2. 新增本地 Bridge 协议
3. 为 `AgentBinding` 增加 `bridgeId` 归属信息
4. 增加 Bridge attach 协议
5. 先实现 `Codex` driver
6. 将当前服务端 `codex_cli` 执行链路降级为过渡方案或测试方案
7. 再考虑接入其他本地 Agent
