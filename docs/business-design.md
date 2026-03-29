# 业务详述与业务设计

## 1. 文档定位

本文档用于冻结当前阶段的业务模型、成员关系和执行边界，供产品、接口、实现与测试统一对齐。

本文档默认服务以下场景：

- 对齐“轻身份、一等公民大厅、房间、私有助理”的业务口径
- 为 `packages/shared` 中的领域类型与 DTO 提供业务语义基线
- 为接口设计、前端呈现和后续实现排除歧义

## 2. 目标

AgentTavern 是一个面向局域网的多人聊天室系统。

项目目标：

- 提供轻身份与一等公民大厅
- 人和 Agent 都是一等公民，并且都可以进入聊天室成为成员
- 聊天室内消息实时同步
- 通过 `@成员名` 触发协作
- Agent 以消息形式发言，并支持流式输出
- 本地 Agent 可统一接入
- 聊天核心与 UI 解耦
- 后续可扩展为酒馆式像素 UI

## 2.1 当前结论

如果只想快速把握当前业务边界，可以先记住下面这些结论：

- 人和 Agent 都是一等公民
- 聊天室里的实际协作单位是 `member`
- 助理是 owner 的私有协作资产，不是公共机器人
- 本地执行统一通过 Bridge 协议接入
- backend 只是一种执行后端，不应反向主导业务模型
- 当前业务规则应尽量保持 provider-neutral，尽量不要把某个特定工具的接入方式写成业务前提

## 3. 核心对象

第一版领域模型以 `packages/shared` 中的共享类型为准。
对外公开返回的数据结构优先以 `dto` 定义为准。
当前公开 DTO 包括 `PublicMember`、`PublicMessage`、`PublicApproval`。

如果先不看字段，可以先用一句自然语言理解这套关系：

- 房间外有一等公民
- 房间内有成员
- 一等公民可以拥有自己的助理
- 助理和独立 Agent 进入房间后，都会以 member 形式参与协作

当前业务模型分为三层：

1. 一等公民
2. 私有助理资产
3. 聊天室成员关系

第一阶段保持轻量，不引入强账号校验。

当前产品入口分工：

- Web UI 优先服务 human 主链路
- agent 更适合通过邀请 URL、CLI、skill 或本地 Bridge 接入
- agent 作为一等公民的模型与接口方向已对齐，产品化入口仍在持续收口

### Principal

关键字段：

- `id`
- `kind`：`human | agent`
- `login_key`
- `global_display_name`
- `status`
- `created_at`

规则：

- 一等公民统一抽象为 `principal`
- human 使用邮箱作为 `login_key`
- agent 使用稳定的外部键或系统分配键作为 `login_key`
- `login_key` 全局唯一
- 首次访问必须登记一等公民标识与全局昵称
- human 当前不做邮箱验证，属于轻身份
- `global_display_name` 可修改
- 一等公民统一分为 `human | agent`
- principal 是房间外的主体，不等于房间内 member 投影

### PresenceSession

关键字段：

- `id`
- `principal_id`
- `client_id`
- `status`
- `last_seen_at`

规则：

- 在线状态基于当前有效连接和心跳
- 同一 principal 允许多连接
- 大厅展示按 principal 去重后的在线状态

### PrivateAssistant

关键字段：

- `id`
- `owner_principal_id`
- `name`
- `backend_type`
- `backend_thread_id`
- `status`
- `created_at`

规则：

- 私有助理只对 owner 自己可见
- 私有助理不进入大厅
- 私有助理可在未加入任何聊天室前被预先配置和唤醒
- 同一个私有助理可加入多个聊天室

### Room

关键字段：

- `id`
- `name`
- `invite_token`
- `status`
- `created_at`

规则：

- 聊天室既可作为多人聊天室，也可作为两人聊天房
- 两人私聊不单独建模，本质上仍是聊天室
- 两人房后续可继续拉入更多成员，升级成多人房
- 聊天室允许通过邀请链接加入，也允许从大厅直接拉入在线的一等公民

### Member

关键字段：

- `id`
- `room_id`
- `principal_id`
- `type`：`human | agent`
- `role_kind`：`none | independent | assistant`
- `display_name`
- `owner_member_id`
- `source_private_assistant_id`
- `adapter_type`
- `adapter_config`
- `presence_status`
- `created_at`

规则：

- `human` 的 `role_kind` 固定为 `none`
- `agent` 的 `role_kind` 为 `independent` 或 `assistant`
- `assistant` 必须有 `owner_member_id`
- `human` member 必须绑定到一个 principal
- `independent agent` member 可以是 principal-backed agent，也可以是仅存在于房间内的本地 agent projection
- member 是 principal 或私有助理资产在具体房间中的投影
- principal-backed `independent agent` 的执行归属属于 principal，而不是具体房间 member
- 一次性助理邀请被接受后，房间里保留的是私有助理资产的 member projection，而不是长期独立实体
- `assistant` projection 的上下线只影响房间可见性，不负责创建或删除 binding
- 私有助理资产或 principal 对应的 binding 才是 `backendThreadId`、Bridge 归属和执行位置的真实拥有者
- 房间显示名为空时默认继承 principal 的 `global_display_name`
- 同一聊天室内最终生效的 `display_name` 必须唯一
- `display_name` 不允许包含空格和 `@`
- `agent` 必须具备可执行的 adapter 配置
- adapter 配置只在服务端保存，不作为公开成员信息返回
- `source_private_assistant_id` 用于标识该房间助理是否来自 owner 的私有助理资产
- 已经绑定到某个 owner 的 `backendThreadId` 不允许被其他 owner 复用
- 同一私有助理资产可有多个房间 projection，但运行时同一时刻只允许一个进行中的执行会话

### Message

关键字段：

- `id`
- `room_id`
- `sender_member_id`
- `message_type`
- `content`
- `reply_to_message_id`
- `created_at`

公开返回附带：

- `attachments[]`
- 每个附件包含 `id` `name` `mimeType` `sizeBytes` `url`

建议类型：

- `user_text`
- `agent_text`
- `system_notice`
- `approval_request`
- `approval_result`

规则：

- 消息允许纯文本、纯附件、文本加附件三种形态
- 消息本体不内联附件二进制内容
- 附件通过独立存储记录与消息关联

### MessageAttachment

关键字段：

- `id`
- `room_id`
- `uploader_member_id`
- `message_id`
- `storage_path`
- `original_name`
- `mime_type`
- `size_bytes`
- `created_at`

规则：

- 附件先以草稿状态上传，`message_id` 为空
- 发送消息时通过附件 id 绑定到具体消息
- 只有上传者本人才能把草稿附件挂到消息上或删除草稿
- 已绑定消息的附件不可再作为草稿复用
- 当前附件正文存储在服务端本地文件系统，消息只暴露内容访问 URL
- 当前约束为最多 `8` 个附件、单文件最多 `5 MB`、单次上传总量最多 `20 MB`
- 未发送的草稿附件按 TTL 自动清理，当前默认 `24h`

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
- `grant_duration`
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
- 可选择在接受后立即加入当前聊天室，也可先沉淀为 owner 的私有助理

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

- 用于将聊天室里的 agent member 绑定到真实后端实体
- `backend_thread_id` 指向某个已存在的本地会话、thread 或执行标识
- `bridge_id` 用于标识当前 binding 归属的本地 Bridge
- 第一版一个聊天室内不允许重复绑定同一 `backend_thread_id`
- 第一版一个 member 只允许一个活跃 binding
- 长期目标中，binding 还需要归属到某个客户端本地 Bridge

建议状态：

- `pending_bridge`
- `active`
- `detached`
- `failed`

## 4. 成员规则

不要混淆：

- 大厅里显示的是 principal
- 房间里显示的是 member
- assistant 是房间角色，不是一等公民大厅主体

### 一等公民大厅

- 聊天室外存在一等公民大厅
- 大厅主体就是一等公民本身
- 一等公民统一分为 `human | agent`
- `assistant` 不进入大厅
- 大厅中的在线身份可被直接拉入聊天室
- 聊天室内任何现有成员都可以直接把大厅中的一等公民拉入聊天室
- 大厅展示的是 principal，不是 room member

### 轻身份

- 首次访问首页时必须登记一等公民标识与全局昵称
- human 使用邮箱作为全局唯一键，但当前不做邮箱验证
- agent 使用稳定的外部键或系统分配键作为全局唯一键
- 当前默认 Web UI 仍以 human 入口为主，但 agent principal 入口已开始收口
- agent 的接入入口长期应以邀请 URL、CLI、skill、本地 Bridge 为主
- agent principal 的产品化入口当前仍在持续收口，不应误解为默认 Web 流程已完整覆盖
- 产品文案应使用“恢复已使用身份”，避免误导为强校验找回
- 房间内最终显示名必须唯一
- 如全局昵称在房间内冲突，需要为该房间单独设置显示名

### 独立 Agent

- 与人平级
- 可直接加入聊天室
- 可被直接 `@`
- 被触发后直接执行

### 助理 Agent

- 必须归属于某个直属 owner
- owner 可以是 human，也可以是 agent
- 一个成员可以有多个助理
- 助理可以继续拥有自己的助理
- 已存在的本地会话 / thread 也可以作为助理加入聊天室

显示规则：

- 成员列表中需要体现 `owner_member_id`
- 成员树应清晰展示 owner 与 assistant 的两级关系
- 消息展示中需要能识别该 Agent 为助理成员
- 助理的显示名仍然作为独立成员名使用，不与 owner 名自动拼接

MVP 规则：

- 只检查直属 owner
- 不做逐级审批
- 不做跨层授权继承
- 其他成员 `@` 助理时，需要经过直属 owner 同意
- owner 自己 `@` 自己的助理时可直接执行

### 私有助理资产

- 一等公民可以在聊天室外预先配置自己的私有助理
- 私有助理只对 owner 可见
- 进入聊天室后可直接把已有私有助理加入聊天室
- 也可在聊天室内新建并邀请一个助理
- 同一个私有助理在同一聊天室内只能有一个 member 投影
- 助理离开聊天室后，私有助理本体仍保留
- 一次性助理邀请 accept 的默认结果也是创建或复用同 owner 下的私有助理本体
- 房间里展示和执行的都是私有助理本体在房间中的 projection

### 服务重启语义

- 服务重启后，连接态重新开始计算
- 旧 `wsToken` 不继续有效
- 旧的在线状态不保留
- 待审批请求不做自动恢复执行
- 服务启动时统一将待审批请求收口为 `expired`
- 对应会话统一收口为 `rejected`
- 聊天室内补写系统消息说明审批因服务重启失效

### 本地会话 / Thread 助理加入

- 已进入聊天室的成员可以生成一次性助理邀请 URL
- 助理邀请 URL 与普通聊天室邀请链接分离
- 助理邀请 URL 默认绑定邀请发起者为直属 owner
- 助理邀请 URL 可预设 `display_name`
- 预设名优先于接入端自报默认名
- 接受时需要绑定自身的 `backend_thread_id`
- `backend_thread_id` 指向接入端本机已有的会话、thread 或其他稳定执行标识
- 原有本地上下文尽量保留，不切换到聊天室上下文
- 助理只接收 `@` 到它的消息
- 助理可先作为 owner 的私有助理存在，再被加入一个或多个聊天室
- 一次性助理邀请接受后，默认沉淀为 owner 名下私有助理资产
- 同一个 owner 下，同一个 `backend_thread_id` 最终只折叠为一个私有助理资产
- 不同 owner 之间不允许复用同一个已绑定的 `backend_thread_id`
- 第一版不自动注入聊天室最近聊天历史
- 第一版一个聊天室内不允许重复绑定同一 `backend_thread_id`
- 具体接入形式可以是 URL、CLI、skill 或其他本地接入脚本

### 客户端本地执行边界

- 本地 Agent 的长期执行位置应在用户自己的客户端设备上
- 服务端只负责聊天室、审批、任务路由与广播
- 服务端不应直接恢复用户本地会话或 thread
- 本地 Bridge 负责在客户端恢复或启动 Agent
- 具体 backend 的 session / thread 细节应收口在 adapter 或 driver 内
- CLI 直连方案可以作为过渡实现，但不应成为唯一长期边界
- Web UI 不负责承载所有 agent 入口，agent 可通过邀请 URL、CLI、skill、Bridge 等方式接入

## 5. 触发与审批

### 触发规则

- 消息中出现 `@成员显示名` 时触发解析
- `@` 匹配直接使用聊天室内最终唯一的 `display_name`
- 当前 `display_name` 以无空格形式约束，保证 mention 可直接匹配
- 命中独立 Agent 时直接创建 `AgentSession`
- 命中助理 Agent 时进入审批流程
- owner 自己命中自己的助理 Agent 时直接创建 `AgentSession`

### 审批规则

- 每次触发单独审批
- 仅直属 owner 可审批
- owner 在线时才可审批
- owner 不在线时，本次调用失败
- owner 自己 `@` 自己的助理时跳过审批
- 审批结果写入聊天室系统消息

## 6. 执行规则

- Agent 统一通过 adapter 接入
- 第一阶段优先接入本地 CLI Agent 与本地会话型 backend
- 当前已存在多种 backend，并共享统一 `AgentAdapter` 抽象
- 本地子进程需要可超时回收
- Agent 输出以流式事件广播到聊天室
- 最终输出固化为消息
- 同一聊天室内，同一 Agent 默认串行执行

## 7. 第一版事件协议

第一版实时事件分为四类：

- 房间事件：`member.joined` `member.left` `member.updated`
- 消息事件：`message.created` `message.updated`
- 审批事件：`approval.requested` `approval.resolved`
- Agent 事件：`agent.session.started` `agent.stream.delta` `agent.message.committed` `agent.session.completed` `agent.session.failed`

## 8. UI 边界

- 后端输出标准事件，不绑定具体 UI
- 前端只负责渲染事件
- 中文聊天室 UI、标准 Web UI 与未来酒馆式像素 UI 共用同一套聊天核心
- 成员区需要清晰区分 human、independent agent、assistant
- assistant 最好以 owner 下的两级树结构展示

## 9. 非目标

第一阶段不包含：

- 强账号校验体系
- 多租户
- 分布式部署
- 复杂工作流编排
- Prompt DSL
- 长期记忆系统
- 向量库 / RAG
- 复杂权限系统
