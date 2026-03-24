# AgentTavern

AgentTavern 是一个面向局域网场景的多人房间聊天系统。它的核心目标不是传统 IM，而是把人和 Agent 都视为聊天室成员，在同一个房间内进行实时协作。

项目在第一阶段会先提供标准聊天界面，但从架构上会明确为未来的酒馆式像素 UI / 游戏化 UI 预留替换能力。

项目强调以下能力：

- 多人进入同一房间实时聊天
- 通过链接邀请加入，无需用户体系
- Agent 可作为独立成员加入房间
- Agent 也可作为某个成员的助理加入房间
- 通过 `@Agent` 直接触发调用，无需复杂指令体系
- 助理型 Agent 需要直属 owner 同意后才可执行
- Agent 输出支持流式广播，房间内所有成员可实时看到过程
- 支持接入本地运行的 Agent，且调用方式统一
- 支持将已开启的本地 Codex thread 作为助理加入房间
- 后端聊天逻辑与前端 UI 解耦，便于未来替换为像素风或游戏化界面
- 支持未来演进为酒馆式像素 UI，而无需重写聊天后端
- 单机可运行，尽量减少外部依赖

## 当前阶段

当前仓库已经完成第一批后端基线实现。

项目计划以 MIT 协议开源发布到 GitHub。

当前已落地：

- 文档基线
- pnpm workspace 工程骨架
- 房间聊天 MVP
- Agent 成员与助理审批链路
- 本地 Agent `local_process` adapter 基线
- 流式事件广播与最终消息提交
- 标准 Web 演示壳
- Codex thread 助理接入规则已明确

## 项目定位

系统本质上由三部分组成：

1. 聊天房间与实时消息系统
2. Agent 成员与调度系统
3. 与 UI 解耦的事件协议层

其中最重要的设计原则是：

- `human` 和 `agent` 都是房间成员
- Agent 发言是消息，不是工具结果面板
- 流式输出是协议层的一等能力
- 本地 Agent 接入通过统一 adapter 抽象实现
- 聊天核心与表现层解耦，支持标准 Web UI 与未来酒馆式像素 UI 共存

## MVP 范围

第一阶段计划覆盖以下能力：

- 创建房间
- 通过链接邀请成员加入房间
- 房间内多人实时聊天
- Agent 作为独立成员加入房间
- Agent 作为助理成员加入房间
- 识别消息中的 `@Agent`
- 独立 Agent 被 `@` 后直接执行
- 助理 Agent 被 `@` 后，由直属 owner 审批
- Agent 流式输出消息内容
- 输出过程向房间内全员广播
- 保存最终消息结果与关键过程状态

## 已确认业务规则

### 1. 房间与成员

- 不做账号体系
- 局域网场景使用，通过房间链接加入
- 成员统一抽象为 `member`
- 成员类型包括 `human` 和 `agent`

### 2. Agent 身份

Agent 分为两种角色：

- `independent`：独立成员，和人平级
- `assistant`：助理成员，必须归属于某个直属 owner

owner 可以是：

- human
- independent agent
- assistant agent

这意味着系统支持多级助理链。

### 3. 触发规则

- 房间内通过 `@显示名` 触发成员响应
- `@independent agent` 时直接执行
- `@assistant agent` 时，需要直属 owner 明确同意
- 每次触发都需要单独审批
- owner 不在线时，助理不可执行
- 多级助理只检查直属 owner，不做逐级审批

### 4. 可见性与透明度

- 助理成员默认对全房间可见
- 审批结果通过房间系统消息体现
- Agent 回复过程对全房间实时可见

### 5. Codex Thread 助理

- 已进入房间的成员可以生成一次性助理邀请 URL
- Codex thread 保留自己的原始上下文
- Codex thread 只接收 `@` 到它的消息
- 推荐通过专用 Codex skill 完成加入动作

### 6. 并发策略

- 同一房间内，同一个 Agent 默认串行执行
- 先确保稳定和可预期，再考虑后续并发扩展

## 文档目录

详细文档见 [docs/business-design.md](/Users/aruis/develop/workspace-github/AgentTavern/docs/business-design.md)、[docs/tech-stack.md](/Users/aruis/develop/workspace-github/AgentTavern/docs/tech-stack.md)、[docs/task-tracking.md](/Users/aruis/develop/workspace-github/AgentTavern/docs/task-tracking.md)、[docs/api-integration.md](/Users/aruis/develop/workspace-github/AgentTavern/docs/api-integration.md)。

## 技术选型

当前确认的第一阶段技术基线如下：

- 运行时：`Node.js LTS`
- 包管理：`pnpm`
- 语言：`TypeScript`
- 后端：`Hono`
- 实时通信：原生 `WebSocket` + `ws`
- 数据库：`SQLite`
- ORM：`Drizzle ORM`
- 前端：`React` + `Vite`
- 测试：`Vitest` + `Playwright`

当前目标：

- 单机可运行
- 局域网部署简单
- 本地 Agent 接入直接
- 适合快速开发与后续演进

这些技术选型是当前阶段的建议基线，不是长期不可变更的约束。后续可根据产品形态、部署方式和协作需求调整。

## 下一步

下一阶段建议进入：

1. 服务端路由与应用结构拆分
2. 前端把演示壳收成稳定聊天页
3. 强化重启后的会话与在线状态语义
4. 验证 Codex thread 助理的长期使用体验

## 开发启动

安装依赖：

```bash
pnpm install
```

启动后端：

```bash
pnpm dev:server
```

启动前端：

```bash
pnpm dev:web
```

同时启动前后端：

```bash
pnpm dev
```

当前默认地址：

- 后端：`http://localhost:8787`
- 前端：`http://127.0.0.1:5173`

## License

本项目使用 [MIT License](/Users/aruis/develop/workspace-github/AgentTavern/LICENSE)。
