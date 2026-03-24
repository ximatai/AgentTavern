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
- 重名时直接返回冲突错误
- `wsToken` 在本次加入房间时生成
- `wsToken` 仅用于当前 member 的连接态识别
- member 主动离开房间后，原 `wsToken` 失效
- 断线重连时可继续使用未失效的 `wsToken`
- 同一 member 允许存在多个并发连接

#### `POST /api/rooms/:roomId/invite/reset`

重置邀请链接。

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

#### `POST /api/rooms/:roomId/members/agents`

添加 Agent 成员。

请求体：

```json
{
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

### 消息

#### `GET /api/rooms/:roomId/messages`

分页获取消息记录。

#### `POST /api/rooms/:roomId/messages`

发送消息。

请求体：

```json
{
  "senderMemberId": "mem_xxx",
  "content": "@BackendDev 帮我看一下这个接口设计",
  "clientMessageId": "client_xxx"
}
```

服务端动作：

- 保存消息
- 解析 mention
- 广播消息事件
- 命中 agent 时启动调度或审批

### 审批

#### `POST /api/approvals/:approvalId/approve`

同意一次助理调用。

#### `POST /api/approvals/:approvalId/reject`

拒绝一次助理调用。

请求体：

```json
{
  "actorMemberId": "mem_owner_xxx"
}
```

约束：

- 仅直属 owner 可审批
- 同一审批只能处理一次

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

## 4. Agent Adapter

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
