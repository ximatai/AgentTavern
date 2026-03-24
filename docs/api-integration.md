# 对接接口

本文档描述 AgentTavern 第一阶段建议采用的接口边界。当前以接口设计为主，不绑定最终实现框架。

## 1. 设计原则

- 前后端通过 HTTP + WebSocket 协作
- HTTP 负责创建、查询、提交动作
- WebSocket 负责房间内实时事件广播
- Agent 调用通过统一 adapter 层处理
- 接口优先描述领域含义，不提前陷入框架细节

## 2. HTTP 接口草案

## 2.1 房间

### `POST /api/rooms`

创建房间。

请求体示例：

```json
{
  "name": "Architecture Room"
}
```

响应体示例：

```json
{
  "id": "room_xxx",
  "name": "Architecture Room",
  "inviteToken": "xxxx",
  "inviteUrl": "http://<host>/join/xxxx"
}
```

### `GET /api/rooms/:roomId`

获取房间基础信息。

### `POST /api/rooms/:roomId/join`

通过昵称加入房间。

请求体示例：

```json
{
  "nickname": "Alice"
}
```

响应体示例：

```json
{
  "memberId": "mem_xxx",
  "roomId": "room_xxx",
  "displayName": "Alice",
  "wsToken": "local_session_xxx"
}
```

说明：

- 这里的 `wsToken` 不是账号体系 token
- 它仅用于当前房间连接态识别

### `POST /api/rooms/:roomId/invite/reset`

重置房间邀请链接。

## 2.2 成员

### `GET /api/rooms/:roomId/members`

获取房间成员列表。

响应成员字段建议：

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

### `POST /api/rooms/:roomId/members/agents`

向房间添加 Agent 成员。

请求体示例：

```json
{
  "displayName": "BackendDev",
  "roleKind": "assistant",
  "ownerMemberId": "mem_xxx",
  "adapterType": "local_process",
  "adapterConfig": {
    "command": "codex",
    "args": [
      "run"
    ]
  }
}
```

说明：

- `roleKind = independent` 时可不传 `ownerMemberId`
- `roleKind = assistant` 时必须传 `ownerMemberId`

## 2.3 消息

### `GET /api/rooms/:roomId/messages`

分页获取消息记录。

### `POST /api/rooms/:roomId/messages`

发送一条消息。

请求体示例：

```json
{
  "senderMemberId": "mem_xxx",
  "content": "@BackendDev 帮我看一下这个接口设计",
  "clientMessageId": "client_xxx"
}
```

服务端行为建议：

- 持久化消息
- 解析 mention
- 广播消息创建事件
- 如命中 agent，则发起调度或审批流程

## 2.4 审批

### `POST /api/approvals/:approvalId/approve`

同意一次助理调用。

请求体示例：

```json
{
  "actorMemberId": "mem_owner_xxx"
}
```

### `POST /api/approvals/:approvalId/reject`

拒绝一次助理调用。

请求体示例：

```json
{
  "actorMemberId": "mem_owner_xxx"
}
```

说明：

- 审批接口必须校验操作者就是直属 owner
- 同一审批只能处理一次

## 3. WebSocket 事件草案

建议连接方式：

`GET /ws?roomId=<roomId>&memberId=<memberId>&wsToken=<token>`

连接成功后，服务端只推送标准事件对象。

统一事件格式建议：

```json
{
  "type": "message.created",
  "roomId": "room_xxx",
  "timestamp": "2026-03-24T14:00:00.000Z",
  "payload": {}
}
```

## 3.1 房间事件

### `member.joined`

```json
{
  "type": "member.joined",
  "payload": {
    "member": {
      "id": "mem_xxx",
      "type": "human",
      "displayName": "Alice"
    }
  }
}
```

### `member.left`

成员离开房间。

### `member.updated`

成员信息变更，例如在线状态变化。

## 3.2 消息事件

### `message.created`

新消息已创建。

```json
{
  "type": "message.created",
  "payload": {
    "message": {
      "id": "msg_xxx",
      "senderMemberId": "mem_xxx",
      "messageType": "user_text",
      "content": "hello"
    }
  }
}
```

### `message.updated`

用于补充最终状态或修正文案。

## 3.3 审批事件

### `approval.requested`

有新的助理调用审批请求。

```json
{
  "type": "approval.requested",
  "payload": {
    "approvalId": "apr_xxx",
    "ownerMemberId": "mem_owner_xxx",
    "requesterMemberId": "mem_requester_xxx",
    "agentMemberId": "mem_agent_xxx",
    "triggerMessageId": "msg_xxx"
  }
}
```

### `approval.resolved`

审批被同意、拒绝或超时。

```json
{
  "type": "approval.resolved",
  "payload": {
    "approvalId": "apr_xxx",
    "result": "approved"
  }
}
```

## 3.4 Agent 会话事件

### `agent.session.started`

```json
{
  "type": "agent.session.started",
  "payload": {
    "sessionId": "as_xxx",
    "agentMemberId": "mem_agent_xxx"
  }
}
```

### `agent.stream.delta`

Agent 产生一段流式内容。

```json
{
  "type": "agent.stream.delta",
  "payload": {
    "sessionId": "as_xxx",
    "messageId": "msg_xxx",
    "delta": "正在分析"
  }
}
```

### `agent.message.committed`

流式输出完成并固化为最终消息。

### `agent.session.completed`

Agent 会话正常结束。

### `agent.session.failed`

Agent 会话异常结束。

## 4. Agent Adapter 接口建议

为了统一本地 Agent 和未来外部 Agent，建议抽象统一接口。

接口示意：

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

说明：

- 上层调度器只依赖 `AgentAdapter`
- 本地 CLI、守护进程、远端 API 都实现同一接口

## 5. 当前接口边界结论

当前建议的接口分层为：

- HTTP：动作入口
- WebSocket：房间事件广播
- Adapter：Agent 执行接入标准

这个划分足够支撑 MVP，也便于后续替换前端形态或增加 Agent 类型。
