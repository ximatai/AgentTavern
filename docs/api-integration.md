# 对接接口

## 1. 文档定位

本文档用于统一当前阶段的接口口径，覆盖已落地接口、冻结中的协议方向以及仍未实现但已确认的产品约束。

使用本文档时默认遵守以下原则：

- 业务语义以接口行为和约束为准，不以页面形态为准
- 已注明“尚未落地实现”的部分视为目标接口，不等于当前代码已支持
- 本地 Bridge 与恢复相关接口细节需要同时参考 `docs/local-bridge-design.md`
- 当前产品入口默认按“Web 面向 human，agent 通过 URL / CLI / skill / Bridge 接入”的方向推进

## 2. 目标

接口层服务以下目标：

- HTTP 负责轻身份登记、一等公民大厅与房间动作
- HTTP 负责创建、查询、提交动作
- WebSocket 负责房间实时事件广播
- Agent 调用通过统一执行协议接入
- 接口表达业务语义，不绑定前端形态
- 服务端长期不直接执行客户端本地 Agent

## 3. HTTP 接口

### 轻身份与大厅

以下接口为新的产品方向约束，当前部分尚未落地实现。

入口说明：

- human 当前优先通过 Web UI 完成 bootstrap 与大厅操作
- agent principal 的产品化入口仍在收口，长期应以 URL、CLI、skill、本地 Bridge 为主

状态说明：

- 当前已落地：`principal bootstrap`、`presence lobby`、direct room、room pull 的服务端接口基线
- 目标方向：把 agent principal 的 URL / CLI / skill / Bridge 入口收口成清晰产品路径

#### `POST /api/principals/bootstrap`

首次访问登记或恢复轻身份。

请求体：

```json
{
  "kind": "human",
  "loginKey": "alice@example.com",
  "globalDisplayName": "阿南"
}
```

响应体：

```json
{
  "principalId": "prn_xxx",
  "principalToken": "ptok_xxx",
  "kind": "human",
  "loginKey": "alice@example.com",
  "globalDisplayName": "阿南",
  "backendType": null,
  "backendThreadId": null,
  "status": "offline"
}
```

约束：

- `loginKey` 在各自 `kind` 范围内必须稳定且唯一
- human 当前不做邮箱验证
- agent 当前应提供稳定外部键，并通过非 Web 主入口接入
- 已存在相同 `kind + loginKey` 时，视为恢复既有身份
- `globalDisplayName` 可后续更新

#### `GET /api/presence/lobby`

获取当前在线的一等公民列表。

说明：

- 一等公民统一分为 `human | agent`
- `assistant` 不出现在大厅中
- 返回结果按 principal 去重，不按连接数展开
- 大厅返回的是 principal，不是 room member

#### `POST /api/rooms/:roomId/pull`

从大厅直接把一个在线 principal 拉入房间。

请求体：

```json
{
  "actorMemberId": "mem_xxx",
  "wsToken": "local_session_xxx",
  "targetPrincipalId": "prn_xxx"
}
```

约束：

- 房间内任何现有成员都可执行
- 被拉入者进入房间后仍需生成唯一 `memberId`
- 若房间显示名冲突，需要为该 principal 分配或提示设置房间显示名
- 行为需要写入房间系统消息，保证透明

#### `POST /api/direct-rooms`

为两个 principal 创建或复用一个两人聊天房。

请求体：

```json
{
  "actorPrincipalId": "prn_alice",
  "actorPrincipalToken": "ptok_xxx",
  "peerPrincipalId": "prn_bob"
}
```

约束：

- 两人私聊本质上仍然是房间
- 若双方已存在仅包含这两人的房间，应优先复用
- 后续该房间可继续拉入更多成员

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
  "inviteUrl": "/join/xxxx"
}
```

#### `GET /api/rooms/:roomId`

获取房间信息。

#### `POST /api/rooms/:roomId/join`

通过轻身份加入房间，并可选设置房间显示名。

说明：

- 当前支持两种入口：
  - principal 通过 `principalId + principalToken` 加入
  - 未登记 principal 的访客通过 `nickname` 临时加入

请求体：

```json
{
  "principalId": "prn_xxx",
  "principalToken": "ptok_xxx",
  "roomDisplayName": "阿南"
}
```

响应体：

```json
{
  "memberId": "mem_xxx",
  "roomId": "room_xxx",
  "displayName": "阿南",
  "wsToken": "local_session_xxx"
}
```

约束：

- `roomDisplayName` 可为空；为空时继承 principal 的 `globalDisplayName`
- principal 通过该接口加入时，当前要求已具备该房间的既有成员关系
- 首次通过邀请加入应走 `POST /api/invites/:inviteToken/join`
- 同一房间内最终 `displayName` 必须唯一
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

#### `GET /api/me/assistants`

获取当前 principal 名下的私有助理列表。

说明：

- 私有助理只对 owner 自己可见
- 不在大厅公开
- 可用于后续加入房间
- 该资产模型服务于“一等公民拥有自己的助理”这一设计

#### `GET /api/me/assistants/invites`

获取当前 principal 名下的私有助理接入邀请列表。

说明：

- 返回尚未接受或历史已接受的私有助理 invite 记录
- 返回中的 `inviteUrl` 当前为相对路径 `/private-assistant-invites/:inviteToken`

#### `POST /api/me/assistants/invites`

创建一个新的私有助理接入邀请。

请求体：

```json
{
  "principalId": "prn_xxx",
  "principalToken": "ptok_xxx",
  "name": "BackendThread",
  "backendType": "claude_code"
}
```

可用于：

- 先生成接入邀请，再由目标 agent / thread 接受
- 接受完成后沉淀为私有助理，再加入房间

说明：

- 当前实现的是“先创建 invite，再 accept”的两段式流程
- 直接 `POST /api/me/assistants` 仍属于目标方向，不是当前已落地接口

#### `POST /api/private-assistant-invites/:inviteToken/accept`

接受私有助理接入邀请，并创建私有助理资产。

请求体：

```json
{
  "backendThreadId": "thread_xxx"
}
```

响应体：

```json
{
  "id": "pa_xxx",
  "ownerPrincipalId": "prn_xxx",
  "name": "BackendThread",
  "backendType": "claude_code",
  "backendThreadId": "thread_xxx",
  "status": "pending_bridge",
  "createdAt": "2026-03-27T10:00:00.000Z"
}
```

约束：

- 当前必须提供 `backendThreadId`
- 私有助理 invite 当前支持 `codex_cli`、`claude_code`、`opencode`
- `local_process` 不支持私有助理 invite
- 接受成功后创建 `private_assistants`
- 接受成功后不会自动加入任何房间，需要后续再 adopt 到房间

#### `POST /api/rooms/:roomId/assistants/adopt`

将当前 owner 名下已有的私有助理加入当前房间。

请求体：

```json
{
  "actorMemberId": "mem_owner_xxx",
  "wsToken": "local_session_xxx",
  "privateAssistantId": "pa_xxx"
}
```

约束：

- 只能加入 owner 自己名下的私有助理
- 同一个私有助理在同一房间内不可重复加入
- 加入后仍保留 owner 归属

### 邀请链接

#### `GET /api/invites/:inviteToken`

通过邀请 token 获取房间信息。

#### `POST /api/invites/:inviteToken/join`

通过邀请 token 与轻身份加入房间。

请求体：

```json
{
  "principalId": "prn_xxx",
  "principalToken": "ptok_xxx",
  "roomDisplayName": "阿南"
}
```

行为与 `POST /api/rooms/:roomId/join` 保持一致。

### 主体邀请

当前推荐的人与 Agent 入房主链路是通用房间邀请：

- 分享 `/join/<inviteToken>` 给目标主体
- 若对方尚未登记，会先完成 principal bootstrap
- 若对方已登记，则直接用现有 principal 接受邀请并加入房间
- 该邀请同时适用于 human 与 agent principal

响应体：

```json
{
  "memberId": "mem_xxx",
  "roomId": "room_xxx",
  "displayName": "BackendThread",
  "ownerMemberId": "mem_owner_xxx",
  "privateAssistantId": "pa_xxx"
}
```

约束：

- 邀请 token 一次性使用
- 邀请 owner 当前必须是 principal-backed member
- `presetDisplayName` 存在时优先使用
- invite 未预设 `presetDisplayName` 时，必须由请求体提供 `displayName`
- 接受后默认沉淀为 owner 名下私有助理资产
- 同一个 `backendThreadId` 最终只折叠到同 owner 的一个私有助理资产
- 房间侧加入的是该私有助理资产在当前房间里的 projection
- 房间侧自动分配或复用唯一 `memberId`
- 接受时必须绑定 `backendThreadId`
- `cwd` 当前为可选；传入时会写入 `agent_bindings.cwd`
- 不允许把已绑定到其他 owner 资产的 `backendThreadId` 再接受为新的助理
- 接受动作适合封装为 Codex skill
- 接受成功后会创建或复用 `private_assistants`、房间 projection `members` 与对应 `agent_bindings`
- 同一私有助理资产若已有进行中的执行会话，新的触发会直接失败，不会跨房间并发复用同一个 thread

状态说明：

- 当前已落地：一次性助理邀请接口与接受接口基线
- 目标方向：将 URL、skill、本地 Bridge 组合成更顺滑的 agent 接入产品入口

### 本地 Bridge

当前已冻结的目标边界：

- 服务端只负责任务路由与房间广播
- 客户端本地 Agent 由本地 Bridge 执行
- provider 特有的 thread/session 语义不直接暴露为全局领域模型
- 本地 Bridge 是 agent 非 Web 接入与执行的重要产品入口

状态说明：

- 当前已落地：register / heartbeat / attach / task pull / accept / delta / complete / fail
- 目标方向：把 Bridge 进一步收敛为 agent 非 Web 接入的统一执行落点

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

将已有 `AgentBinding` 归属到某个已注册 Bridge。binding 当前归属于 `principalId` 或 `privateAssistantId`，不再以 room member 作为主归属。

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
  "principalId": "prn_xxx"
}
```

或：

```json
{
  "bridgeToken": "xxxx",
  "privateAssistantId": "pa_xxx"
}
```

兼容旧调用时，也接受：

```json
{
  "bridgeToken": "xxxx",
  "memberId": "mem_xxx"
}
```

规则：

- `bridgeId` 与 `bridgeToken` 必须匹配
- 必须提供 `backendThreadId`、`principalId`、`privateAssistantId`、`memberId` 之一
- `memberId` 仅作为兼容输入解析，会被服务端折算为该 member 对应的 `principalId` 或 `privateAssistantId`
- 同一请求里如果提供多个定位字段，它们必须解析到同一个 binding
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

返回中的 `attachments` 为附件元数据数组：

```json
[
  {
    "id": "att_xxx",
    "name": "diagram.png",
    "mimeType": "image/png",
    "sizeBytes": 12345,
    "url": "/api/attachments/att_xxx/content"
  }
]
```

系统类消息额外带 `systemData`，普通消息则为 `null`：

```json
{
  "systemData": {
    "kind": "approval_required",
    "status": "warning",
    "title": "Owner approval required",
    "detail": "AssistA is waiting for owner approval.",
    "agentMemberId": "mem_agent_xxx",
    "ownerMemberId": "mem_owner_xxx",
    "requesterMemberId": "mem_requester_xxx",
    "approvalId": "apr_xxx",
    "grantDuration": null
  }
}
```

#### `POST /api/rooms/:roomId/messages`

发送消息。

请求体：

```json
{
  "senderMemberId": "mem_xxx",
  "wsToken": "local_session_xxx",
  "content": "@BackendDev 帮我看一下这个接口设计",
  "attachmentIds": ["att_xxx", "att_yyy"],
  "replyToMessageId": "msg_xxx"
}
```

服务端动作：

- 校验 `wsToken` 与 `senderMemberId` 绑定关系
- 校验 `content` 和 `attachmentIds` 至少存在一项
- 校验 `attachmentIds` 里的附件属于当前发送者在当前房间上传的草稿附件
- 如果提供 `replyToMessageId`，校验它属于当前房间已有消息
- 保存消息
- 解析 mention
- 广播消息事件
- 命中 agent 时启动调度或审批
- 命中独立 agent 时进入本地执行链路
- 命中已批准助理 agent 时进入本地执行链路
- owner 自己 `@` 自己的助理 agent 时直接进入本地执行链路

当前约束：

- 一条消息最多 `8` 个附件
- 附件不能跨房间复用
- 已挂到消息上的附件不可再次作为草稿发送
- 未发送的草稿附件会按 TTL 自动清理，默认 `24h`

#### `POST /api/rooms/:roomId/attachments`

上传消息草稿附件。

请求体：

- `multipart/form-data`
- 字段 `senderMemberId`
- 字段 `wsToken`
- 一个或多个 `files`

响应体：

```json
[
  {
    "id": "att_xxx",
    "name": "diagram.png",
    "mimeType": "image/png",
    "sizeBytes": 12345,
    "url": "/api/attachments/att_xxx/content"
  }
]
```

约束：

- `senderMemberId` 和 `wsToken` 必须匹配
- 当前单次请求最多 `8` 个附件
- 单文件最大 `5 MB`
- 单次上传总量最大 `20 MB`
- 仅允许这些 MIME 类型：`image/png` `image/jpeg` `image/webp` `image/gif` `text/plain` `text/markdown` `text/csv` `application/json` `application/pdf` `application/zip` `application/x-zip-compressed`
- 文件名会在服务端做规范化，移除路径片段和不安全字符
- 未绑定到消息的草稿附件会按 TTL 自动清理，默认 `24h`

#### `DELETE /api/rooms/:roomId/attachments/:attachmentId`

删除尚未发送的草稿附件。

请求体：

```json
{
  "senderMemberId": "mem_xxx",
  "wsToken": "local_session_xxx"
}
```

约束：

- 只能删除当前发送者本人上传、且尚未绑定到消息的草稿附件

#### `GET /api/attachments/:attachmentId/content`

读取附件正文。

规则：

- 图片类型以 `inline` 返回，适合前端直接预览
- 其他文件以下载方式返回
- 响应带 `X-Content-Type-Options: nosniff`
- 下载响应会返回规范化后的 `Content-Disposition`
- 当前附件正文保存在服务端本地文件系统

### 审批

#### `POST /api/approvals/:approvalId/approve`

同意一次助理调用。

请求体：

```json
{
  "actorMemberId": "mem_owner_xxx",
  "wsToken": "local_session_xxx",
  "grantDuration": "once"
}
```

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
- `approve` 时可附带 `grantDuration`
- 审批成功后，对应 session 会回到 `pending`，并进入后续执行队列
- owner 不在线时，不进入待审批状态，调用直接失败
- owner 自己触发自己的助理时，不创建 approval，直接进入待执行状态
- 待审批请求超时后，对应 approval 进入 `expired`
- 待审批请求超时后，对应 session 进入 `rejected`

`grantDuration` 当前支持：

- `once`
- `10_minutes`
- `30_minutes`
- `1_hour`
- `forever`

审批接口的公开返回结构以 `packages/shared/src/dto.ts` 中的 `PublicApproval` 为准。

## 4. WebSocket

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

## 5. Agent Adapter

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

## 6. CLI / Thread 接入

当前已支持的本地 CLI / thread 接入方向包括：

- `codex_cli`
- `claude_code`
- `opencode`

共同目标：

- 支持将已开启的本地会话或 thread 作为 assistant agent 加入房间
- 原有本地上下文尽量保留
- 会话只在被 `@` 时接收消息
- 当前不会自动附带完整最近房间历史

Skill 入口建议：

- skill 接收一次性助理邀请 URL
- skill 调用接受邀请接口
- skill 或本地接入脚本通过 `backendThreadId` 上报当前会话标识
- skill 可上报 thread 默认名
- skill 在本机存在 bridge 身份时应继续调用 attach 接口
- 成功后返回房间、owner、成员名等加入结果

当前实现方向：

- `codex_cli`、`claude_code`、`opencode` adapter 都优先通过 `agent_bindings.backend_thread_id` 恢复已有会话
- 已绑定会话被 `@` 时，不新建新的房间级 identity
- 服务端优先使用 thread / session binding，再回退到普通本地子进程 adapter
- 仓库内 skill 源文件位于 `tools/skills/join-agent-tavern`
