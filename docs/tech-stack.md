# 技术选型与工程骨架

## 1. 文档定位

本文档用于描述当前阶段的工程基线，目的是统一启动方式和实现方向。

本文档不是长期冻结协议，后续维护者可以根据实际需要调整技术实现，只要不破坏以下目标：

- 单机可运行
- 局域网可部署
- 本地 Agent 易接入
- 本地执行链路保持清晰
- 审批与协作边界不被基础设施复杂度掩盖
- 聊天核心与 UI 解耦
- 后续可扩展为酒馆式像素 UI
- 工程结构尽量轻量

## 2. 当前技术基线

### 2.1 运行时与语言

- 运行时：`Node.js LTS`
- 包管理：`pnpm`
- 语言：`TypeScript`

### 2.2 后端

- HTTP 框架：`Hono`
- WebSocket：原生 `WebSocket` 协议
- Node WebSocket 库：`ws`

### 2.3 数据层

- 数据库：`SQLite`
- ORM：`Drizzle ORM`

### 2.4 前端

- UI 框架：`React`
- 构建工具：`Vite`

### 2.5 测试与验证

- 单元测试：`node:test` + `tsx`
- 端到端测试：`Playwright`

## 3. 变更原则

以下内容允许后续按需要调整：

- 具体版本号
- 前端技术实现
- ORM 实现
- WebSocket 封装方式
- 项目目录拆分粒度

变更时建议优先保证：

- 房间聊天模型不被破坏
- 房间上下文、审批边界和本地执行这三层分工不被破坏
- Agent adapter 抽象继续成立
- UI 与聊天核心继续解耦
- 单机部署复杂度不要明显上升
- 本地 Agent 接入成本不要明显上升

## 4. 工程结构基线

建议直接使用 pnpm workspace，按以下结构组织：

```text
AgentTavern/
  apps/
    server/
    ui/
    bridge/
  packages/
    shared/
    agent-sdk/
  docs/
  README.md
  LICENSE
  pnpm-workspace.yaml
  package.json
```

### 4.1 `apps/server`

职责：

- Hono HTTP API
- WebSocket 连接与房间广播
- SQLite schema 与迁移
- 消息持久化
- Mention 解析
- 审批流程
- Agent 调度

### 4.2 `apps/ui`

职责：

- 标准 Web 聊天界面
- 优先服务 human 主链路
- 房间成员视图
- 消息视图
- Agent 流式输出渲染
- 审批交互入口

### 4.3 `apps/bridge`

职责：

- 本地 Bridge 注册与心跳
- 本地 Agent 任务拉取与执行
- provider driver 装配
- 将本机执行结果回传服务端

### 4.4 `packages/shared`

职责：

- 领域类型定义
- 事件协议定义
- DTO 与 schema
- 前后端共享常量

### 4.5 `packages/agent-sdk`

职责：

- `AgentAdapter` 接口
- 本地 Agent 标准输入输出模型
- 本地 CLI adapter 实现
- 未来远程 adapter 扩展点

补充说明：

- agent 不要求统一通过 Web UI 接入
- URL、CLI、skill、本地 Bridge 都应能复用这套接入与执行抽象

## 5. 第一阶段依赖边界

第一阶段建议尽量把依赖控制在以下范围：

- Node.js
- SQLite
- pnpm workspace
- Hono
- ws
- Drizzle
- React
- Vite
- node:test
- Playwright

原则：

- 不引入 Redis
- 不引入 Kafka
- 不引入外部鉴权服务
- 不引入外部数据库
- 不引入复杂消息中间件

## 6. 第一阶段部署形态

建议部署方式：

- 单机运行
- 一个后端进程
- 一个 SQLite 文件
- 一个前端静态资源目录

可选部署形式：

- 直接本机运行
- PM2 守护
- Docker 打包

不建议第一阶段就做：

- 分布式部署
- 容器编排
- 云原生拆分

## 7. 当前结论

当前项目的工程基线为：

- `Node.js LTS`
- `pnpm`
- `TypeScript`
- `Hono`
- `WebSocket + ws`
- `SQLite`
- `Drizzle ORM`
- `React`
- `Vite`
- `node:test + tsx`
- `Playwright`

这套基线用于当前阶段启动项目，不代表后续不可调整。
