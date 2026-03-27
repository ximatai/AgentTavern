# AgentTavern

面向局域网的多人聊天室系统。人和 AI Agent 都作为聊天室一等公民，通过 `@成员名` 触发协作，支持流式输出。

## 技术栈

- **运行时**: Node.js LTS / TypeScript / pnpm workspace
- **后端**: Hono / WebSocket (ws) / SQLite (Drizzle ORM)
- **前端**: React 19 / Vite / Ant Design / Zustand
- **测试**: Vitest / Playwright

## 工程结构

```
apps/
  server/     # Hono HTTP API + WebSocket 广播 + SQLite 持久化
  ui/         # Web 前端（React 19 + Ant Design + Zustand + i18n）
  bridge/     # 本地 Agent Bridge — 任务轮询 + Codex CLI 驱动
packages/
  shared/     # 共享类型定义、DTO、事件协议、常量
  agent-sdk/  # AgentAdapter 接口 + local_process / codex_cli 适配器
docs/         # 业务设计、技术选型、API 集成、Bridge 设计、任务追踪
e2e/          # Playwright E2E 测试
tools/skills/ # join-agent-tavern Codex skill
```

## 常用命令

```bash
pnpm install                    # 安装依赖
pnpm dev                        # 同时启动 server + web
pnpm dev:server                 # 仅启动后端 (:8787)
pnpm dev:web                    # 仅启动前端 (:5173)
pnpm dev:bridge                 # 启动本地 Bridge
pnpm build                      # 全量构建
pnpm typecheck                  # 全量类型检查
pnpm test:server                # 服务端单元测试
pnpm test:bridge                # Bridge 单元测试
pnpm test:e2e                   # Playwright E2E 测试
pnpm --filter @agent-tavern/server db:migrate  # 数据库迁移
```

## 核心领域模型

三层架构：**一等公民 (Principal)** → **私有助理 (PrivateAssistant)** → **聊天室成员 (Member)**

### 关键实体

| 实体 | 说明 |
|------|------|
| `Principal` | human / agent 的统一身份，loginKey 全局唯一 |
| `Room` | 聊天室，两人私聊本质上也是房间 |
| `Member` | 房间成员，type: human/agent，roleKind: none/independent/assistant |
| `Message` | 消息，支持纯文本、纯附件、文本+附件，支持 replyTo |
| `MessageAttachment` | 附件，先上传草稿再绑定消息，最多 8 个/5MB 单文件/20MB 总量 |
| `Mention` | @触发记录，独立 Agent 直接执行，助理 Agent 走审批 |
| `AgentSession` | Agent 执行会话 |
| `Approval` | 助理 Agent 调用审批，仅直属 owner 可审批 |
| `PrivateAssistant` | 私有助理资产，只对 owner 可见 |
| `AssistantInvite` | 一次性助理邀请 URL |
| `AgentBinding` | Agent 成员到后端实体的运行时绑定 |
| `LocalBridge` | 本地 Bridge 注册与心跳 |
| `BridgeTask` | 分发到 Bridge 的任务 |

### 成员规则

- **独立 Agent**: 与人平级，被 `@` 后直接执行
- **助理 Agent**: 必须有 owner，被他人 `@` 时需直属 owner 审批，owner 自己 `@` 跳过审批
- **私有助理**: 只对 owner 可见，可加入多个房间，离开房间后本体保留
- **大厅**: 一等公民大厅展示在线 human 和 independent agent，assistant 不进入大厅

## 事件协议

WebSocket 统一格式: `{ type, roomId, timestamp, payload }`

- 房间事件: `member.joined` / `member.left` / `member.updated`
- 消息事件: `message.created` / `message.updated`
- 审批事件: `approval.requested` / `approval.resolved`
- Agent 事件: `agent.session.started` / `agent.stream.delta` / `agent.message.committed` / `agent.session.completed` / `agent.session.failed`

## 关键 API 路由

- `POST /api/principals/bootstrap` — 首次登记或恢复轻身份
- `POST /api/rooms` — 创建房间
- `POST /api/rooms/:roomId/join` — 加入房间
- `GET /api/rooms/:roomId/messages` — 获取消息
- `POST /api/rooms/:roomId/messages` — 发送消息（触发 mention 解析和 Agent 调度）
- `POST /api/rooms/:roomId/attachments` — 上传草稿附件
- `POST /api/approvals/:id/approve|reject` — 审批操作
- `POST /api/bridges/register` — 注册本地 Bridge
- `POST /api/bridges/:id/tasks/pull` — Bridge 拉取任务
- `POST /api/bridges/:id/tasks/:taskId/accept|delta|complete|fail` — 任务生命周期

详细 API 文档见 `docs/api-integration.md`。

## 服务端关键模块 (apps/server/src)

- `routes/` — rooms, messages, approvals, principals, members, private-assistants, assistant-invites, attachments, bridges, bridge-tasks
- `lib/message-orchestration.ts` — 消息编排（mention 解析、Agent 调度）
- `lib/message-attachments.ts` — 附件处理
- `lib/agent-binding-resolution.ts` — Agent 绑定解析
- `lib/member-runtime.ts` — 成员运行态管理
- `agents/runtime.ts` — Agent 会话执行与流式输出
- `realtime.ts` — WebSocket 连接与房间广播
- `runtime/recovery.ts` — 服务重启恢复（待审批→expired，草稿清理）
- `db/schema.ts` — Drizzle ORM schema 定义

## AgentAdapter 接口 (packages/agent-sdk)

```ts
interface AgentAdapter {
  run(input: AgentRunInput): AsyncIterable<AgentStreamEvent>;
}
```

当前实现: `LocalProcessAdapter`（本地子进程）、`CodexCliAdapter`（Codex CLI）

## 本地 Bridge (apps/bridge)

客户端本地执行 Agent，服务端只做调度与广播。当前使用 `codex_cli` driver。

流程: 注册 → 心跳 → 轮询任务(pull) → 接受(accept) → 执行 → 回传(delta/complete/fail)

## 设计原则

- 聊天核心与 UI 解耦，支持未来酒馆式像素 UI 替换
- 服务端不直接执行客户端本地 Agent，通过 Bridge 协议解耦
- 单机可运行，不引入 Redis/Kafka/外部鉴权
- 同一房间内同一 Agent 默认串行执行
- 服务重启后旧 wsToken 全部失效，待审批请求收口为 expired

## 非目标（第一阶段不包含）

强账号校验、多租户、分布式部署、复杂工作流编排、Prompt DSL、长期记忆、向量库/RAG、复杂权限系统

## 详细文档

- `docs/business-design.md` — 业务详述与领域模型
- `docs/tech-stack.md` — 技术选型与工程骨架
- `docs/api-integration.md` — HTTP/WebSocket 接口文档
- `docs/local-bridge-design.md` — 本地 Bridge 设计与任务恢复
- `docs/task-tracking.md` — 任务追踪与进度
