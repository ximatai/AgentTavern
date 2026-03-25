# 客户端本地 Agent Bridge 设计

## 1. 目标

本地 Agent 的执行端应运行在用户自己的客户端设备上，而不是服务端。

设计目标：

- 用户可将自己本机的 Agent 引入聊天室
- 服务端只负责房间、审批、任务路由和消息广播
- 本地 Agent 保留自己的上下文与运行环境
- `@Agent` 后由对应客户端本地执行，再把结果回传房间
- 后续可接入 Codex、Claude Code、Cursor、Gemini 等不同本地 Agent

## 1.1 当前阶段路线护栏

当前阶段的短期路线必须优先服务两个长期目标：

- 用户把自己本机的 Agent 引入房间并稳定协作
- 聊天核心与 UI 解耦，为未来像素酒馆式界面保留替换空间

因此当前阶段默认遵守以下规则：

- 先补运行时协议基线，再补恢复系统
- 先做真实可用性回归，再做基础设施深挖
- 若某项工作不能直接提升“本地 Agent 可接入性”“真实可用性”“UI 可替换性”，默认降级优先级
- `accepted` 任务恢复当前只停留在设计层，直到 `bridgeInstanceId` 基线和真实回归完成

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
- 将 `delta / completed / failed` 回传服务端

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

建议领域事件名：

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
7. Bridge 将 `delta / completed / failed` 回传服务端
8. 服务端广播给房间并固化最终消息

当前已落地的 HTTP 动作：

- `register`
- `heartbeat`
- `attach`
- `task pull`
- `task accept`
- `task delta`
- `task complete`
- `task fail`

说明：

- dotted name 用于领域事件名
- 短语名用于当前 HTTP 动作
- 后续代码、日志、测试优先使用 HTTP 动作名

当前约束：

- `attach` 必须保证同一 binding 在同一时刻只归属一个 Bridge
- `task pull` 必须采用可重试的 claim 语义
- `task accept` 必须采用条件更新
- Bridge 在执行前必须先 `accept`
- 超过租约时间仍未 `accept` 的 `assigned` 任务可重新领取
- Bridge 必须在本机持久化自己的身份信息
- 当前运行时接口使用 `bridgeId + bridgeToken + bridgeInstanceId`
- `accepted` 任务恢复仍处于设计阶段

当前执行基线：

- 本地 Bridge 已有 driver 分层
- 第一版 `codex_cli` driver 在 Bridge 本机执行
- 当前 `codex_cli` driver 仍是过渡实现，长期目标仍是 SDK thread/resume
- Codex 助理 skill 在接受邀请成功后，会尽量按本机 bridge 身份自动 attach
- `join-agent-tavern` skill 的仓库内源文件基线已建立，仓库内路径为 `tools/skills/join-agent-tavern`

## 8. Bridge 任务恢复设计

当前未冻结实现，先冻结设计边界。

### 恢复目标

- 避免 `accepted` 任务在 bridge 中途退出后永久卡死
- 避免两个 bridge 进程同时处理同一任务
- 恢复时保持 `bridge_tasks` 与 `agent_sessions` 状态一致

### 不接受的恢复方式

- bridge 启动后无条件把自己的 `assigned / accepted` 任务改回 `pending`
- 仅凭 `bridgeId + bridgeToken` 就直接重置执行中任务
- 只改 `bridge_tasks`，不处理对应 `agent_sessions`

这些方式会带来：

- 旧 bridge 仍在运行时的重复执行
- 旧 bridge 后续 `delta / complete / fail` 被服务器拒绝
- session 仍是 `running`，但底层任务已被重新排队

### 第一阶段建议语义

恢复采用 fenced recovery，而不是裸重排队。

需要增加两个概念：

- `bridgeInstanceId`
  - 每次 bridge 进程启动时生成新的实例 id
  - `register` 成功后，后续 `pull / accept / delta / complete / fail` 都带上该实例 id
- `accepted lease`
  - 任务从 `accept` 开始进入带实例归属的执行租约
  - 只有持有该租约的实例可以继续上报执行结果

### 推荐状态规则

1. `pull`
- 把任务从 `pending` 领到 `assigned`
- 只表示“这个 bridge 看到了任务”
- 不代表开始执行

2. `accept`
- 记录：
  - `acceptedAt`
  - `acceptedByBridgeId`
  - `acceptedByInstanceId`
- 同时将 `agent_session` 置为 `running`

3. `delta / complete / fail`
- 必须校验：
  - `bridgeId`
  - `bridgeInstanceId`
  - 任务当前仍归属于该实例

4. `recover`
- 不再是“把任务改回 pending”
- 只能回收：
  - 已超过 `accepted` 租约超时时间
  - 且当前实例明确声明要接管的任务
- 回收动作必须同时处理：
  - `bridge_tasks`
  - `agent_sessions`

### session 收口规则

如果后续采用“回收后重新执行”，则需要：

- 将旧的 `running session` 收口为 `failed` 或 `abandoned`
- 再重新创建新的 `agent_session`

如果后续采用“原 session 继续执行”，则需要：

- 保留同一个 `agent_session`
- 但要明确记录：
  - 恢复实例
  - 恢复时间
  - 原实例已失效

第一阶段更建议：

- 回收后重新创建新的 `agent_session`
- 原 session 明确标记为失败态

原因：

- 语义更简单
- 审计更清楚
- 不需要在一个 session 上叠多段执行所有权

### 第一阶段不做

- 不做“热接管仍在运行中的旧实例”
- 不做“无痕恢复同一个 session”
- 不做“跨 bridge 自动迁移执行上下文”

第一阶段只追求：

- 任务不会永久卡死
- 不会出现两个 bridge 同时声称自己在执行同一任务
- 房间内能看到清楚的失败和重试边界

### 设计级验证

下面这些场景必须在实现前先视为判定清单。

#### 场景 A：单实例正常执行

条件：

- Bridge 实例 A 注册成功
- A `pull -> accept -> delta -> complete`

期望：

- 任务只被 A 接收一次
- `AgentSession` 从 `queued / waiting_approval` 进入 `running`
- 最终进入 `completed`
- 不产生恢复动作

#### 场景 B：旧实例已死，新实例恢复

条件：

- 实例 A 已 `accept` 任务
- A 失联，超过 accepted lease
- 新实例 B 以同一 `bridgeId` 重连，并声明新的 `bridgeInstanceId`

期望：

- B 可以触发恢复
- 恢复后不会继续沿用 A 的实例所有权
- 旧执行会话必须有明确收口
- 新一轮执行必须有新的所有权记录

#### 场景 C：旧实例未死，新实例误恢复

条件：

- 实例 A 仍在正常执行
- 实例 B 试图以同一 `bridgeId` 发起恢复

期望：

- 服务端拒绝恢复
- A 后续 `delta / complete / fail` 仍然有效
- 不允许把正在执行的任务重排队

#### 场景 D：旧实例恢复后继续上报

条件：

- A 的实例所有权已经失效
- A 仍尝试发送 `delta / complete / fail`

期望：

- 服务端基于 `bridgeInstanceId` 拒绝这些请求
- 不污染当前活跃实例的任务状态

#### 场景 E：session 收口一致性

条件：

- 一个 `accepted` 任务被认定需要恢复

期望：

- 不允许只改 `bridge_tasks`
- 必须同时明确原 `agent_session` 的结束语义
- 第一阶段建议：
  - 原 session 进入失败态
  - 恢复执行创建新 session

#### 场景 F：任务开关关闭

条件：

- Bridge 以 `taskLoopEnabled=false` 运行

期望：

- 不应主动触发任务恢复
- 不应持有可执行任务的所有权

### 通过标准

Bridge 任务恢复设计只有在以下条件同时成立时才可进入实现：

- `bridgeInstanceId` 已进入所有运行时接口口径
- 旧实例与新实例的所有权冲突有明确拒绝规则
- `accepted lease` 的超时与回收条件已固定
- `bridge_tasks` 与 `agent_sessions` 的联动收口已固定
- 至少覆盖上面 A-F 六类场景的自动化验证方案已写出

## 9. 边界

第一阶段不追求：

- 服务端直接托管所有本地 Agent
- 服务端直接控制用户本机 thread
- 不同 provider 共用同一种 session/thread 语义

第一阶段优先保证：

- 本地执行位置正确
- 职责边界清晰
- provider 可扩展
- 失败态可收口

## 10. 迁移方向

从当前实现迁移时，按下面顺序推进：

1. 先冻结“服务端不再直接恢复客户端本地 Codex thread”这一原则
2. 新增本地 Bridge 协议
3. 为 `AgentBinding` 增加 `bridgeId` 归属信息
4. 增加 Bridge attach 协议
5. 先实现 `Codex` driver
6. 将当前服务端 `codex_cli` 执行链路降级为过渡方案或测试方案
7. 再考虑接入其他本地 Agent
