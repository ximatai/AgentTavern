# 业务详述与业务设计

## 1. 目标

AgentTavern 是一个面向局域网的多人房间聊天系统。

项目目标：

- 人和 Agent 都作为房间成员存在
- 房间内消息实时同步
- 通过 `@成员名` 触发协作
- Agent 以消息形式发言，并支持流式输出
- 本地 Agent 可统一接入
- 聊天核心与 UI 解耦
- 后续可扩展为酒馆式像素 UI

## 2. 核心对象

第一版领域模型以 `packages/shared` 中的共享类型为准。
对外公开返回的数据结构优先以 `dto` 定义为准。
当前公开 DTO 包括 `PublicMember`、`PublicMessage`、`PublicApproval`。

### Room

关键字段：

- `id`
- `name`
- `invite_token`
- `status`
- `created_at`

### Member

关键字段：

- `id`
- `room_id`
- `type`：`human | agent`
- `role_kind`：`none | independent | assistant`
- `display_name`
- `owner_member_id`
- `adapter_type`
- `adapter_config`
- `presence_status`
- `created_at`

规则：

- `human` 的 `role_kind` 固定为 `none`
- `agent` 的 `role_kind` 为 `independent` 或 `assistant`
- `assistant` 必须有 `owner_member_id`
- `agent` 必须具备可执行的 adapter 配置
- 同一房间内 `display_name` 必须唯一
- `display_name` 不允许包含空格和 `@`
- adapter 配置只在服务端保存，不作为公开成员信息返回

### Message

关键字段：

- `id`
- `room_id`
- `sender_member_id`
- `message_type`
- `content`
- `reply_to_message_id`
- `created_at`

建议类型：

- `user_text`
- `agent_text`
- `system_notice`
- `approval_request`
- `approval_result`

### Mention

关键字段：

- `id`
- `message_id`
- `target_member_id`
- `trigger_text`
- `status`
- `created_at`

建议状态：

- `detected`
- `pending_approval`
- `approved`
- `rejected`
- `expired`
- `triggered`

### AgentSession

关键字段：

- `id`
- `room_id`
- `agent_member_id`
- `trigger_message_id`
- `requester_member_id`
- `approval_required`
- `approval_id`
- `status`
- `started_at`
- `ended_at`

建议状态：

- `pending`
- `waiting_approval`
- `running`
- `completed`
- `rejected`
- `failed`
- `cancelled`

### StreamEvent

建议事件：

- `session_started`
- `delta`
- `message_committed`
- `session_completed`
- `session_failed`

### Approval

关键字段：

- `id`
- `room_id`
- `requester_member_id`
- `owner_member_id`
- `agent_member_id`
- `trigger_message_id`
- `status`
- `created_at`
- `resolved_at`

### AssistantInvite

关键字段：

- `id`
- `room_id`
- `owner_member_id`
- `preset_display_name`
- `backend_type`
- `invite_token`
- `status`
- `accepted_member_id`
- `created_at`
- `expires_at`
- `accepted_at`

规则：

- 用于一次性助理邀请 URL
- 创建者自动成为直属 owner
- `invite_token` 全局唯一
- 一次接受成功后不可复用

### AgentBinding

关键字段：

- `id`
- `member_id`
- `backend_type`
- `backend_thread_id`
- `cwd`
- `status`
- `attached_at`
- `detached_at`

规则：

- 用于将房间里的 agent member 绑定到真实后端实体
- 对 Codex thread 来说，`backend_thread_id` 指向已有 thread
- 第一版 `backend_thread_id` 全局唯一
- 第一版一个 member 只允许一个活跃 binding

## 3. 成员规则

### 独立 Agent

- 与人平级
- 可直接加入房间
- 可被直接 `@`
- 被触发后直接执行

### 助理 Agent

- 必须归属于某个直属 owner
- owner 可以是 human，也可以是 agent
- 一个成员可以有多个助理
- 助理可以继续拥有自己的助理
- 已开启的 Codex thread 也可以作为助理加入房间

显示规则：

- 成员列表中需要体现 `owner_member_id`
- 消息展示中需要能识别该 Agent 为助理成员
- 助理的显示名仍然作为独立成员名使用，不与 owner 名自动拼接

MVP 规则：

- 只检查直属 owner
- 不做逐级审批
- 不做跨层授权继承

### Codex Thread 助理加入

- 已进入房间的成员可以生成一次性助理邀请 URL
- 助理邀请 URL 与普通房间邀请链接分离
- 助理邀请 URL 默认绑定邀请发起者为直属 owner
- 助理邀请 URL 可预设 `display_name`
- 预设名优先于 thread 自报默认名
- thread 加入时，房间侧自动分配唯一 `member_id`
- thread 加入时需要绑定自身的 `backend_thread_id`
- `backend_thread_id` 指向 Codex 自己已有的 thread
- thread 保留自己的原始上下文，不切换到聊天室上下文
- thread 只接收 `@` 到它的消息
- 第一版不自动注入房间最近聊天历史
- 第一版同一个 `backend_thread_id` 只允许加入一个房间
- 第一版一个房间内不允许重复绑定同一 `backend_thread_id`
- 推荐通过 Codex skill 完成加入动作

## 4. 触发与审批

### 触发规则

- 消息中出现 `@成员显示名` 时触发解析
- `@` 匹配直接使用房间内唯一的 `display_name`
- 当前 `display_name` 以无空格形式约束，保证 mention 可直接匹配
- 命中独立 Agent 时直接创建 `AgentSession`
- 命中助理 Agent 时进入审批流程

### 审批规则

- 每次触发单独审批
- 仅直属 owner 可审批
- owner 在线时才可审批
- owner 不在线时，本次调用失败
- 审批结果写入房间系统消息

## 5. 执行规则

- Agent 统一通过 adapter 接入
- 第一版 adapter 类型为 `local_process`
- 第一阶段优先接入本地 CLI Agent
- 真实 Codex CLI 接入优先以已有 thread 绑定方式推进
- 本地子进程需要可超时回收
- Agent 输出以流式事件广播到房间
- 最终输出固化为消息
- 同一房间内，同一 Agent 默认串行执行

## 6. 第一版事件协议

第一版实时事件分为四类：

- 房间事件：`member.joined` `member.left` `member.updated`
- 消息事件：`message.created` `message.updated`
- 审批事件：`approval.requested` `approval.resolved`
- Agent 事件：`agent.session.started` `agent.stream.delta` `agent.message.committed` `agent.session.completed` `agent.session.failed`

## 7. UI 边界

- 后端输出标准事件，不绑定具体 UI
- 前端只负责渲染事件
- 标准 Web UI 与未来酒馆式像素 UI 共用同一套聊天核心

## 8. 非目标

第一阶段不包含：

- 账号体系
- 多租户
- 分布式部署
- 复杂工作流编排
- Prompt DSL
- 长期记忆系统
- 向量库 / RAG
- 复杂权限系统
