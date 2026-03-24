# 业务详述与业务设计

## 1. 项目目标

AgentTavern 面向局域网协作场景，提供一个以房间为核心的人机混合协作系统。

与传统聊天系统不同，本项目要求：

- 人和 Agent 都能作为房间成员存在
- Agent 可以像人一样发消息
- Agent 的触发方式足够自然，主要依赖 `@成员名`
- Agent 执行过程可流式展示给房间内所有人
- 本地运行的 Agent 能以统一方式接入
- UI 可替换，聊天逻辑不能与某种前端绑定

## 2. 核心业务对象

### 2.1 Room

房间是协作的基本单元，负责承载：

- 成员列表
- 消息流
- Agent 调用上下文
- 房间级广播事件

建议关键属性：

- `id`
- `name`
- `invite_token`
- `status`
- `created_at`

### 2.2 Member

成员是房间中的统一参与者抽象。

建议关键属性：

- `id`
- `room_id`
- `type`：`human | agent`
- `role_kind`：`independent | assistant | none`
- `display_name`
- `owner_member_id`：仅 assistant 存在
- `presence_status`
- `created_at`

说明：

- `human` 的 `role_kind` 可固定为 `none`
- `agent` 的 `role_kind` 为 `independent` 或 `assistant`
- `assistant` 必须具备 `owner_member_id`

### 2.3 Message

消息是房间内的可见表达载体。

建议关键属性：

- `id`
- `room_id`
- `sender_member_id`
- `message_type`
- `content`
- `reply_to_message_id`
- `created_at`

建议 `message_type` 包括：

- `user_text`
- `agent_text`
- `system_notice`
- `approval_request`
- `approval_result`

### 2.4 Mention

Mention 用于记录一次显式触发行为，避免把触发逻辑只藏在文本解析里。

建议关键属性：

- `id`
- `message_id`
- `target_member_id`
- `trigger_text`
- `status`
- `created_at`

建议 `status` 包括：

- `detected`
- `pending_approval`
- `approved`
- `rejected`
- `expired`
- `triggered`

### 2.5 AgentSession

每次 Agent 执行都对应一个独立会话。

建议关键属性：

- `id`
- `room_id`
- `agent_member_id`
- `trigger_message_id`
- `requester_member_id`
- `approval_required`
- `status`
- `started_at`
- `ended_at`

建议 `status` 包括：

- `pending`
- `waiting_approval`
- `running`
- `completed`
- `rejected`
- `failed`
- `cancelled`

### 2.6 StreamEvent

流式输出过程不应直接等价于最终消息，应该作为独立事件序列处理。

建议事件类型：

- `session_started`
- `delta`
- `message_committed`
- `session_completed`
- `session_failed`

## 3. 成员关系模型

## 3.1 独立成员

独立 Agent 与人平级，特点如下：

- 可直接加入房间
- 可被房间成员直接 `@`
- 被触发后无需审批
- 可像普通成员一样发送消息

## 3.2 助理成员

助理型 Agent 是某个成员的直属从属。

特点如下：

- 必须存在直属 owner
- owner 可以是 human，也可以是 agent
- 一个成员可以有多个助理
- 助理也可以继续拥有自己的助理

该设计形成一个成员归属树，但不是权限树。

MVP 阶段的权限规则保持简单：

- 只检查直属 owner
- 不做逐级审批
- 不做跨层授权继承

## 4. 消息与触发规则

### 4.1 普通消息

普通消息直接广播到房间内所有在线连接。

### 4.2 Mention 触发

当消息中出现 `@成员显示名` 时，服务端执行以下流程：

1. 解析消息中的 mention
2. 匹配房间内可见成员
3. 判断目标是否为 agent
4. 若是独立 Agent，直接创建 `AgentSession`
5. 若是助理 Agent，进入审批流程

### 4.3 助理审批

MVP 审批规则如下：

- 每次触发都需要单独审批
- 仅直属 owner 有审批权
- owner 在线时才可审批
- owner 不在线时，请求直接失败或超时
- 审批结果通过系统消息广播给全房间

建议审批结果示例：

- `张三 同意了 @BackendDev 的本次调用`
- `张三 拒绝了 @BackendDev 的本次调用`
- `@BackendDev 调用失败：owner 不在线`

## 5. Agent 调用与执行模型

## 5.1 统一接入原则

无论本地 Agent 还是未来远端 Agent，都通过统一 adapter 接入。

建议 adapter 抽象职责：

- 接收标准化上下文
- 启动一次执行会话
- 产生流式输出
- 返回结束状态

这样可兼容：

- 本地 CLI 子进程
- 本地长期驻留服务
- 未来第三方模型服务

## 5.2 本地 Agent 优先

本项目重点支持本地 Agent 接入，第一阶段优先考虑：

- 由后端拉起本地 CLI 子进程
- 将 stdout/stderr 转换为流式事件
- 将最终输出固化为消息

## 5.3 并发策略

为降低复杂度，MVP 建议：

- 同一房间内同一 Agent 串行执行
- 新请求进入队列，或直接返回忙碌状态

后续如有需要，再扩展为：

- 房间级并发限制
- Agent 级队列
- 优先级任务调度

## 6. 实时性与 UI 解耦

本项目不应把 UI 状态写死在后端逻辑里。

后端只输出标准事件，例如：

- 成员加入/离开
- 新消息创建
- 审批请求创建
- 审批状态变化
- Agent 流式增量
- Agent 会话结束

前端仅根据事件渲染。

这样未来从 Web 聊天界面替换到像素风界面时，只需要替换展示层，不需要重写聊天核心与 Agent 调度逻辑。

## 7. 非目标

MVP 阶段暂不覆盖以下内容：

- 注册、登录、账号体系
- 多租户
- 分布式部署
- 复杂工作流编排
- Prompt DSL
- 长期记忆系统
- 向量库 / RAG
- 复杂 ACL 权限系统

## 8. MVP 结论

当前确认后的 MVP 可以概括为：

- 一个局域网可用的房间式实时聊天系统
- 房间成员包括人和 Agent
- Agent 可以独立存在，也可以作为从属助理存在
- 通过 `@` 直接触发协作
- 助理调用走直属 owner 审批
- Agent 输出以流式形式广播给全房间
- 本地 Agent 接入优先，且接入协议统一
