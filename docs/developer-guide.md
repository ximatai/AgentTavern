# 开发者指南

这份文档面向准备开发、重构或扩展 AgentTavern 的人。

README 的重点是解释“项目为什么存在、用户怎么快速上手”；本文档的重点是解释：

- 这个项目的核心模型是什么
- 主链路怎么流转
- 各个包和应用各自负责什么
- 从哪里进入代码最合适
- 当前已经支持哪些本地 AI 工具，以及怎么接入

## 1. 先建立整体心智模型

这个项目的主线不是“聊天 UI”，也不是“把很多 Agent 放进一个界面里”。

从当前产品定位看，AgentTavern 更接近：

- 一个可本地部署的协作执行空间
- 一个围绕 owner / approval / authorization 运转的 Agent 协作框架
- 一个把房间上下文、本地执行和权限边界放在一起的系统

因此，系统里最重要的不是按钮和页面，而是“谁拥有能力、谁可以借用能力、能力最终在哪里执行”。

代码层最值得先抓住的是这三层关系：

1. `Citizen`
2. `PrivateAssistant`
3. `Member`

其中：

- `Citizen` 是房间外的主体身份，分为 `human` 和 `agent`
- `PrivateAssistant` 是归属于某个 Citizen 的私有助理资产
- `Member` 是进入具体房间后的成员投影

这三层关系决定了后面很多设计：

- 为什么大厅显示的是 citizen，而不是 member
- 为什么助理不是大厅主体
- 为什么审批是围绕 owner 和 assistant 展开的
- 为什么房间里的执行绑定不直接挂在 UI 组件上
- 为什么服务端负责调度，而本地 Bridge 才负责执行

## 2. 核心领域对象

项目里最值得优先理解的实体有这些：

- `Citizen`
- `Room`
- `Member`
- `Message`
- `MessageAttachment`
- `Mention`
- `AgentSession`
- `Approval`
- `PrivateAssistant`
- `AgentBinding`
- `LocalBridge`
- `BridgeTask`

建议你把它们分成三组理解：

### 2.1 协作模型

- `Citizen`
- `Room`
- `Member`
- `Message`
- `MessageAttachment`

### 2.2 Agent 调度模型

- `Mention`
- `AgentSession`
- `Approval`
- `AgentBinding`

### 2.3 本地执行模型

- `LocalBridge`
- `BridgeTask`

### 2.4 助理资产模型

- `PrivateAssistant`
- `PrivateAssistantInvite`

## 3. 最重要的几条业务规则

### 3.1 成员类型

- 独立 Agent：和人平级，被 `@` 后直接执行
- 助理 Agent：必须有 owner，别人调用时默认要审批
- 私有助理：只对 owner 可见，可加入多个房间

### 3.2 审批规则

- owner 自己 `@` 自己的助理时，默认跳过审批
- 其他成员 `@` 某个助理时，需要直属 owner 审批
- 审批的结果会影响 mention、session 和房间事件流
- 审批的意义不只是“放行一次执行”，更是显式维护能力借用时的责任边界

### 3.3 运行规则

- 服务端负责调度，不直接托管客户端本地 Agent 执行
- 本地执行统一通过 Bridge 协议完成
- 同一房间内同一 Agent 默认串行执行
- 普通 independent agent 默认仍通过 `@` 或 reply 触发
- room secretary 是当前唯一具备“观察普通房间消息并自主协调”能力的角色
- assistant 永远被动，但被动回复时已经支持 `@member`、附件和摘要更新

## 4. 主链路怎么走

一个典型的执行链路是：

1. 某个成员在房间里发送消息
2. 服务端解析 mention、reply target，必要时再补 secretary observe 触发
3. 如果目标是助理且需要审批，则先创建 `Approval`
4. 如果允许执行，则创建 `AgentSession`
5. 服务端根据 `AgentBinding` 找到对应 backend 和 Bridge
6. 服务端创建 `BridgeTask`
7. 本地 Bridge 轮询拉取任务
8. Bridge 根据 `backendType` 选择 driver
9. driver 调用对应本地 AI 工具
10. delta / complete / fail 结果回传服务端
11. 服务端把结果统一收口成 message action，再广播房间事件并更新消息流

如果你要理解运行时，建议顺着这条链路读，而不是先分散看单个模块。

更直接地说：

- 房间是协作上下文
- 审批是权限边界
- Bridge 是本地执行落点
- message action 是结果收口协议

## 5. 工程结构

```text
apps/
  server/     # HTTP API + WebSocket + SQLite + 调度
  ui/         # React Web 前端
  bridge/     # 本地 Bridge 进程
packages/
  shared/     # 共享类型、DTO、事件协议、常量
  agent-sdk/  # AgentAdapter 接口与本地 adapter 实现
docs/         # 设计、接口、技术与任务文档
tools/        # skills 与辅助脚本
```

## 6. 每个目录最值得先看的文件

### 6.1 `apps/server`

如果你要理解服务端，建议先看：

- `apps/server/src/app.ts`
- `apps/server/src/routes/`
- `apps/server/src/agents/runtime.ts`
- `apps/server/src/realtime.ts`
- `apps/server/src/db/schema.ts`

再往后看：

- `apps/server/src/lib/message-orchestration.ts`
- `apps/server/src/lib/agent-binding-resolution.ts`
- `apps/server/src/runtime/recovery.ts`

### 6.2 `apps/ui`

如果你要理解前端，建议先看：

- `apps/ui/src/App.tsx`
- `apps/ui/src/components/`
- `apps/ui/src/hooks/useRoomWebSocket.ts`
- `apps/ui/src/stores/`

重点不是单个样式，而是：

- HTTP 请求如何组织
- WebSocket 事件如何落到 store
- 房间消息流和运行态怎么同步更新

### 6.3 `apps/bridge`

如果你要理解本地执行，建议先看：

- `apps/bridge/src/index.ts`
- `apps/bridge/src/task-processor.ts`
- `apps/bridge/src/drivers.ts`

这里是“服务端调度”和“本地 AI 工具执行”真正接起来的地方。

### 6.4 近期新增的关键心智

如果你最近才接手这个项目，先记住这三点：

- `secretary` 已经是已落地的房间角色，不只是设计概念
- agent 输出已经统一收口到 message `action`，不再只是假定“纯文本完成”
- Bridge / local runtime 两条路径都已经支持：
  - 文本
  - mentions
  - room summary
  - agent 生成附件

### 6.4 `packages/shared`

这里定义的是跨端共识。

优先看：

- `packages/shared/src/domain.ts`
- `packages/shared/src/events.ts`
- `packages/shared/src/dto.ts`

原则上不要绕开这里私自扩散协议定义。

### 6.5 `packages/agent-sdk`

这里是本地执行适配层。

优先看：

- `packages/agent-sdk/src/index.ts`
- `packages/agent-sdk/src/local-process.ts`
- `packages/agent-sdk/src/codex-cli.ts`
- `packages/agent-sdk/src/claude-code.ts`
- `packages/agent-sdk/src/opencode.ts`

## 7. 当前支持的本地 AI 工具

当前已接好的 backend：

- `local_process`
- `codex_cli`
- `claude_code`
- `opencode`

### 7.1 设计原则

这些工具都按同一条原则处理：

- CLI 是可选依赖
- 缺失时只影响对应任务
- 不应该把 Bridge 进程整体打崩

当前统一的缺失行为是：

- `codex CLI not found — ensure Codex is installed`
- `claude CLI not found — ensure Claude Code is installed`
- `opencode CLI not found — ensure OpenCode is installed`

### 7.2 如果你要新增一个 backend

最小落地范围通常包括：

1. 在 `packages/shared/src/domain.ts` 增加新的 `AgentBackendType`
2. 在 server 的支持校验里放行该 backend
3. 在 `packages/agent-sdk` 新增 adapter
4. 在 `apps/bridge/src/drivers.ts` 注册 driver
5. 在 UI 中增加 backend 选项和展示文案
6. 补 adapter 测试和 bridge 测试

## 8. 本地 Bridge 的职责

Bridge 不负责产品逻辑，只负责执行。

它要做的事很明确：

- 注册本机 Bridge 身份
- 发送 heartbeat
- 拉取分配给自己的任务
- 接受任务
- 调用本地 backend 执行
- 将 delta / complete / fail 回传服务端

一句话概括：

**服务端负责“该不该跑、跑给谁看”，Bridge 负责“在本机把它跑出来”。**

## 9. 测试与验证

当前常用命令：

```bash
pnpm typecheck
pnpm test:agent-sdk
pnpm test:server
pnpm test:bridge
pnpm test:e2e
```

### 9.1 测试分层建议

- `agent-sdk`：验证 CLI 协议、流式输出、CLI 缺失时的优雅失败
- `bridge`：验证任务接受、delta 回传、失败处理、session 回写
- `server`：验证业务规则、审批、运行时状态迁移、接口契约
- `e2e`：验证 UI 主链路

如果你要改本地 AI 工具接入，优先补：

- adapter 单测
- bridge 任务测试

## 10. 改动时最容易踩的坑

### 10.1 把协议定义散落到各端

共享 DTO、事件协议、backend type 尽量统一收口到 `packages/shared`。

### 10.2 把 Bridge 当成业务中心

Bridge 只负责本地执行，不应该承载审批、成员关系或房间权限逻辑。

### 10.3 忘记考虑“本机没装某个工具”

所有 CLI backend 都应该按“可选依赖”处理，而不是默认开发者机器上全都有。

### 10.4 只改 UI，不补事件和运行时校验

这个项目的很多问题不是页面状态问题，而是消息、session、approval、bridge task 之间的一致性问题。

## 11. 推荐阅读顺序

如果你是第一次参与开发，建议按这个顺序：

1. 读 [README](../README.md)
2. 读 [docs/business-design.md](business-design.md)
3. 读 [docs/api-integration.md](api-integration.md)
4. 跑一次 `pnpm dev` + `pnpm dev:bridge`
5. 顺着本指南里的代码入口开始读

## 12. 相关文档

- [README](../README.md)
- [业务设计](business-design.md)
- [接口设计](api-integration.md)
- [本地 Bridge 设计](local-bridge-design.md)
- [技术基线](tech-stack.md)
- [任务跟踪](task-tracking.md)
