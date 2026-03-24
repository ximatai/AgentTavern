# 对接接口

## 1. 目标

接口层服务以下目标：

- HTTP 负责创建、查询、提交动作
- WebSocket 负责房间实时事件广播
- Agent 调用通过统一 adapter 接入
- 接口表达业务语义，不绑定前端形态

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
- skill 上报当前 `backendThreadId`
- skill 可上报 thread 默认名
- 成功后返回房间、owner、成员名等加入结果

当前实现方向：

- `codex_cli` adapter 优先通过 `agent_bindings.backend_thread_id` 恢复已有 thread
- 已绑定的 Codex thread 被 `@` 时，不新建 thread
- 服务端优先使用 thread binding，再回退到普通本地子进程 adapter
