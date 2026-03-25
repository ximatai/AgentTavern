# 对接接口

## 1. 目标

接口层服务以下目标：

- HTTP 负责创建、查询、提交动作
- WebSocket 负责房间实时事件广播
- Agent 调用通过统一执行协议接入
- 接口表达业务语义，不绑定前端形态
- 服务端长期不直接执行客户端本地 Agent

## 2. HTTP 接口

### 房间

#### `POST /api/rooms`

创建房间。

请求体：

```json
{
  "name": "Architecture Room"
}
```

响应体：

```json
{
  "id": "room_xxx",
  "name": "Architecture Room",
  "inviteToken": "xxxx",
  "inviteUrl": "http://<host>/join/xxxx"
}
```

#### `GET /api/rooms/:roomId`

获取房间信息。

#### `POST /api/rooms/:roomId/join`

通过昵称加入房间。

请求体：

```json
{
  "nickname": "Alice"
}
```

响应体：

```json
{
  "memberId": "mem_xxx",
  "roomId": "room_xxx",
  "displayName": "Alice",
  "wsToken": "local_session_xxx"
}
```

约束：

- 同一房间内 `displayName` 必须唯一
- `displayName` 不允许包含空格和 `@`
- 重名时直接返回冲突错误
- `wsToken` 在本次加入房间时生成
- `wsToken` 仅用于当前 member 的连接态识别
- member 主动离开房间后，原 `wsToken` 失效
- 断线重连时可继续使用未失效的 `wsToken`
- 同一 member 允许存在多个并发连接
- 服务重启后，旧 `wsToken` 全部失效

#### `POST /api/rooms/:roomId/invite/reset`

重置邀请链接。

#### `POST /api/rooms/:roomId/assistant-invites`

创建一次性助理邀请 URL。

请求体：

```json
{
  "actorMemberId": "mem_xxx",
  "wsToken": "local_session_xxx",
  "presetDisplayName": "BackendThread",
  "backendType": "codex_cli"
}
```

约束：

- `actorMemberId` 和 `wsToken` 必须匹配
- 邀请创建者自动成为直属 owner
- 邀请 token 一次性使用
- `presetDisplayName` 可为空
- 第一版 `backendType` 主要用于 `codex_cli`
- 服务端落库到 `assistant_invites`

### 邀请链接

#### `GET /api/invites/:inviteToken`

通过邀请 token 获取房间信息。

#### `POST /api/invites/:inviteToken/join`

通过邀请 token 和昵称加入房间。

请求体：

```json
{
  "nickname": "Alice"
}
```

行为与 `POST /api/rooms/:roomId/join` 保持一致。

### 助理邀请

#### `POST /api/assistant-invites/:inviteToken/accept`

接受一次性助理邀请，加入为 assistant agent。

请求体：

```json
{
  "backendThreadId": "thread_xxx",
  "displayName": "BackendThread"
}
```

响应体：

```json
{
  "memberId": "mem_xxx",
  "roomId": "room_xxx",
  "displayName": "BackendThread",
  "ownerMemberId": "mem_owner_xxx"
}
```

约束：

- 邀请 token 一次性使用
- `presetDisplayName` 存在时优先使用
- 房间侧自动分配唯一 `memberId`
- 接受时必须绑定 `backendThreadId`
- 第一版同一个 `backendThreadId` 只允许加入一个房间
- 第一版一个房间内不允许重复绑定同一 `backendThreadId`
- 接受动作适合封装为 Codex skill
- 接受成功后创建 `members` 与 `agent_bindings`

### 本地 Bridge

当前已冻结的目标边界：

- 服务端只负责任务路由与房间广播
- 客户端本地 Agent 由本地 Bridge 执行
- provider 特有的 thread/session 语义不直接暴露为全局领域模型

建议补充的 Bridge 领域事件：

- `bridge.register`
- `bridge.heartbeat`
- `bridge.agent.attached`
- `bridge.agent.detached`
- `task.assigned`
- `task.accepted`
- `task.delta`
- `task.completed`
- `task.failed`
- `task.recover`（设计中）

说明：

- 以上为下一阶段领域事件方向
- 具体字段以 `docs/local-bridge-design.md` 为准
- 当前服务端内置 `local_process` 仍可作为过渡执行方案
- 当前已落地的是 HTTP 接口，不是这些 dotted name 事件

后续需要补充的 binding 信息：

- `bridgeId`
- `bridgeStatus`
- `provider`
- provider 私有 metadata

规则：

- `AgentBinding` 的长期目标需要归属到某个已注册的本地 Bridge
- invite 接受成功后，可先创建 member 与基础 binding
- bridge 真正接管执行后，再将 binding 关联到具体 `bridgeId`
- `accepted` 任务的恢复不应采用无条件重排队，后续需要引入实例级 fencing
- 当前运行时基线已使用 `bridgeInstanceId`

#### `POST /api/bridges/register`

注册或重连一个本地 Bridge。

请求体：

```json
{
  "bridgeName": "Alice Laptop",
  "bridgeInstanceId": "binst_xxx",
  "platform": "macOS",
  "version": "0.1.0",
  "metadata": {
    "providers": ["codex"]
  }
}
```

重连时可附带：

```json
{
  "bridgeId": "brg_xxx",
  "bridgeToken": "xxxx",
  "bridgeInstanceId": "binst_xxx"
}
```

响应体：

```json
{
  "bridgeId": "brg_xxx",
  "bridgeToken": "xxxx",
  "bridgeInstanceId": "binst_xxx",
  "status": "online",
  "lastSeenAt": "2026-03-25T10:00:00.000Z"
}
```

规则：

- 无 `bridgeId + bridgeToken` 时创建新 Bridge
- 带有效 `bridgeId + bridgeToken` 时按原 Bridge 身份重连
- `bridgeInstanceId` 为当前 Bridge 进程实例 id，注册时必填
- 当前 `bridgeToken` 由服务端生成
- 当前 `bridgeToken` 用于本地 Bridge 后续 heartbeat 认证
- 本地 Bridge 应在本机持久化 `bridgeId + bridgeToken`
- Bridge 进程启动时生成新的 `bridgeInstanceId`

#### `POST /api/bridges/:bridgeId/heartbeat`

刷新本地 Bridge 在线状态。

```json
{
  "bridgeToken": "xxxx",
  "bridgeInstanceId": "binst_xxx",
  "metadata": {
    "activeAgents": 2
  }
}
```

规则：

- `bridgeId` 与 `bridgeToken` 必须匹配
- `bridgeInstanceId` 参与活跃实例判定
- heartbeat 成功后更新 `lastSeenAt`
- heartbeat 成功后当前 Bridge 状态刷新为 `online`
- 未显式传入 `metadata` 时保留原 metadata

#### `POST /api/bridges/:bridgeId/agents/attach`

将已有 `AgentBinding` 归属到某个已注册 Bridge。

请求体：

```json
{
  "bridgeToken": "xxxx",
  "backendThreadId": "thread_xxx",
  "cwd": "/Users/alice/workspace"
}
```

也可使用：

```json
{
  "bridgeToken": "xxxx",
  "memberId": "mem_xxx"
}
```

规则：

- `bridgeId` 与 `bridgeToken` 必须匹配
- 必须提供 `backendThreadId` 或 `memberId`
- 已绑定到其他 Bridge 的 binding 不可重复 attach
- attach 采用条件更新，同一 binding 不会被两个 Bridge 同时 attach 成功
- attach 成功后会更新 `agent_bindings.bridge_id`
- `cwd` 传入时会写回当前 binding

#### `POST /api/bridges/:bridgeId/tasks/pull`

拉取当前 Bridge 可执行的下一个任务。

```json
{
  "bridgeToken": "xxxx",
  "bridgeInstanceId": "binst_xxx"
}
```

规则：

- 仅返回归属当前 `bridgeId` 的待执行任务
- 领取采用条件更新，避免同一任务被重复拉取
- 拉取成功后任务进入 `assigned`
- 已 `assigned` 但超过租约时间仍未 `accept` 的任务可被重新领取
- 领取方需要显式声明当前 `bridgeInstanceId`

#### `POST /api/bridges/:bridgeId/tasks/:taskId/accept`

Bridge 接受任务并开始执行。

```json
{
  "bridgeToken": "xxxx",
  "bridgeInstanceId": "binst_xxx"
}
```

规则：

- 需要有效 `bridgeToken`
- 需要有效 `bridgeInstanceId`
- 成功后任务进入 `accepted`
- 成功后对应 `AgentSession` 进入 `running`
- Bridge 应在真正执行前先 `accept`
- `accept` 采用条件更新，重复 accept 同一任务返回 `409`

#### `POST /api/bridges/:bridgeId/tasks/:taskId/delta`

Bridge 回传增量输出。

```json
{
  "bridgeToken": "xxxx",
  "bridgeInstanceId": "binst_xxx",
  "delta": "partial output"
}
```

规则：

- 当前只负责广播流式事件
- delta 需要校验实例归属
- 最终消息仍以 `complete` 为准固化

#### `POST /api/bridges/:bridgeId/tasks/:taskId/complete`

Bridge 提交最终输出。

```json
{
  "bridgeToken": "xxxx",
  "bridgeInstanceId": "binst_xxx",
  "finalText": "final output"
}
```

规则：

- 成功后任务进入 `completed`
- complete 需要校验实例归属
- 成功后对应消息固化为 `agent_text`
- 成功后对应 `AgentSession` 进入 `completed`

#### `POST /api/bridges/:bridgeId/tasks/:taskId/fail`

Bridge 提交失败结果。

```json
{
  "bridgeToken": "xxxx",
  "bridgeInstanceId": "binst_xxx",
  "error": "driver not configured"
}
```

规则：

- 成功后任务进入 `failed`
- fail 需要校验实例归属
- 成功后对应 `AgentSession` 进入 `failed`
- 房间内补写失败系统消息

#### `POST /api/bridges/:bridgeId/tasks/recover`

说明：

- 当前仍处于设计阶段，尚未落地实现
- 用于 fenced recovery 下由新实例发起恢复动作

计划请求体：

```json
{
  "bridgeToken": "xxxx",
  "bridgeInstanceId": "binst_xxx",
  "targetTaskIds": ["btsk_xxx"]
}
```

计划规则：

- 只能恢复已超过 accepted lease 的任务
- 必须校验当前实例是否具备接管资格
- 恢复时必须同步处理 `bridge_tasks` 与 `agent_sessions`

### 运行时恢复

当前服务端采用保守恢复语义：

- 服务重启后，旧 `wsToken` 全部失效
- 服务重启后，内存中的在线状态全部丢失
- 服务启动时会扫描 `pending` 的审批请求
- 扫描到的 `pending approvals` 会统一转成 `expired`
- 对应的 `agent_sessions` 会统一转成 `rejected`
- 服务端会补写一条 `approval_result` 系统消息，说明该审批因服务重启而失效

### 成员

#### `GET /api/rooms/:roomId/members`

获取成员列表。

成员字段：

```json
{
  "id": "mem_xxx",
  "type": "agent",
  "roleKind": "assistant",
  "displayName": "ZhangSan-BackendDev",
  "ownerMemberId": "mem_owner_xxx",
  "presenceStatus": "online"
}
```

当前公开成员结构以 `packages/shared/src/dto.ts` 中的 `PublicMember` 为准。

#### `POST /api/rooms/:roomId/members/agents`

添加 Agent 成员。

请求体：

```json
{
  "actorMemberId": "mem_xxx",
  "wsToken": "local_session_xxx",
  "displayName": "BackendDev",
  "roleKind": "assistant",
  "ownerMemberId": "mem_xxx",
  "adapterType": "local_process",
  "adapterConfig": {
    "command": "codex",
    "args": ["run"]
  }
}
```

约束：

- `independent` 可不传 `ownerMemberId`
- `assistant` 必须传 `ownerMemberId`
- `displayName` 不允许包含空格和 `@`
- `actorMemberId` 和 `wsToken` 必须匹配
- 当前必须提供 `adapterType`
- 当前必须提供 `adapterConfig`
- 第一版支持 `local_process`
- 成员公开数据不返回底层 adapter 配置

### 消息

#### `GET /api/rooms/:roomId/messages`

获取消息记录。

当前公开消息结构以 `packages/shared/src/dto.ts` 中的 `PublicMessage` 为准。

#### `POST /api/rooms/:roomId/messages`

发送消息。

请求体：

```json
{
  "senderMemberId": "mem_xxx",
  "wsToken": "local_session_xxx",
  "content": "@BackendDev 帮我看一下这个接口设计",
  "clientMessageId": "client_xxx"
}
```

服务端动作：

- 校验 `wsToken` 与 `senderMemberId` 绑定关系
- 保存消息
- 解析 mention
- 广播消息事件
- 命中 agent 时启动调度或审批
- 命中独立 agent 时进入本地执行链路
- 命中已批准助理 agent 时进入本地执行链路
- owner 自己 `@` 自己的助理 agent 时直接进入本地执行链路

### 审批

#### `POST /api/approvals/:approvalId/approve`

同意一次助理调用。

#### `POST /api/approvals/:approvalId/reject`

拒绝一次助理调用。

请求体：

```json
{
  "actorMemberId": "mem_owner_xxx",
  "wsToken": "local_session_xxx"
}
```

约束：

- 仅直属 owner 可审批
- `wsToken` 必须与 `actorMemberId` 匹配
- 同一审批只能处理一次
- 审批成功后，对应 session 进入待执行状态
- owner 不在线时，不进入待审批状态，调用直接失败
- owner 自己触发自己的助理时，不创建 approval，直接进入待执行状态
- 待审批请求超时后，对应 approval 进入 `expired`
- 待审批请求超时后，对应 session 进入 `rejected`

#### `POST /api/approvals/:approvalId/reject`

拒绝一次助理调用。

- 审批拒绝后，对应 session 进入 `rejected`

审批接口的公开返回结构以 `packages/shared/src/dto.ts` 中的 `PublicApproval` 为准。

## 3. WebSocket

连接方式：

`GET /ws?roomId=<roomId>&memberId=<memberId>&wsToken=<token>`

连接规则：

- 连接时必须校验 `roomId`、`memberId` 和 `wsToken`
- `wsToken` 无效时拒绝连接
- 断线后允许使用同一 `wsToken` 重连
- member 离开房间后，旧连接和旧 `wsToken` 一并失效
- 多连接共享同一 member 身份和房间事件流

统一事件格式：

```json
{
  "type": "message.created",
  "roomId": "room_xxx",
  "timestamp": "2026-03-24T14:00:00.000Z",
  "payload": {}
}
```

### 房间事件

- `member.joined`
- `member.left`
- `member.updated`

### 消息事件

- `message.created`
- `message.updated`

### 审批事件

- `approval.requested`
- `approval.resolved`

### Agent 事件

- `agent.session.started`
- `agent.stream.delta`
- `agent.message.committed`
- `agent.session.completed`
- `agent.session.failed`

事件载荷以 `packages/shared` 中的 `RealtimeEvent` 定义为准。
其中成员、消息、审批的公开数据分别使用 `PublicMember`、`PublicMessage`、`PublicApproval`，不直接暴露服务端内部模型。

## 4. Agent Adapter

第一版约定：

- 当前统一接口定义在 `packages/agent-sdk`
- 服务端按成员上的 `adapterType` 和 `adapterConfig` 选择 adapter
- 第一版支持 `local_process`
- `local_process` 通过本地子进程执行
- stdin 默认写入 prompt 文本
- `inputFormat=json` 时，stdin 写入完整 `AgentRunInput`
- 子进程超时后强制结束并返回失败事件
- stdout 按增量内容广播为 `agent.stream.delta`
- 流结束后，最终文本固化为 `agent_text` 消息

统一接口：

```ts
type AgentRunInput = {
  roomId: string;
  agentMemberId: string;
  requesterMemberId: string;
  triggerMessageId: string;
  contextMessages: Array<{
    senderName: string;
    content: string;
    createdAt: string;
  }>;
};

type AgentStreamEvent =
  | { type: "delta"; text: string }
  | { type: "completed"; finalText?: string }
  | { type: "failed"; error: string };

interface AgentAdapter {
  run(input: AgentRunInput): AsyncIterable<AgentStreamEvent>;
}
```

目标：

- 上层只依赖 `AgentAdapter`
- 本地 CLI、守护进程、远端服务都可按同一方式接入

## 5. Codex Thread 接入

第一版目标：

- 支持将已开启的 Codex thread 作为 assistant agent 加入房间
- thread 保留自己的原始上下文
- thread 只在被 `@` 时接收消息
- 第一版不自动附带最近房间聊天历史
- 推荐通过专用 Codex skill 处理助理邀请 URL

Skill 入口建议：

- skill 接收一次性助理邀请 URL
- skill 调用接受邀请接口
- skill 通过 `CODEX_THREAD_ID` 上报当前 `backendThreadId`
- skill 可上报 thread 默认名
- skill 在本机存在 bridge 身份时应继续调用 attach 接口
- 成功后返回房间、owner、成员名等加入结果

当前实现方向：

- `codex_cli` adapter 优先通过 `agent_bindings.backend_thread_id` 恢复已有 thread
- 已绑定的 Codex thread 被 `@` 时，不新建 thread
- 服务端优先使用 thread binding，再回退到普通本地子进程 adapter
- 本地 skill 位于 `/Users/aruis/.codex/skills/join-agent-tavern`
