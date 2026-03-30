# 房间秘书模式设计

## 1. 目标

在保持“平台本身不绑定 LLM，智能能力来自 member/agent”这一原则不变的前提下，为聊天室引入更像人的房间内自治能力。

本设计的核心做法不是让所有 agent 默认自主参与，而是引入一个房间级特殊角色：

- `room secretary`

由这个秘书作为房间内唯一具备“持续观察 + 自主协调”能力的一等公民 agent，其他普通 agent 继续保持被动模式。

## 2. 基本原则

### 2.1 平台不内置 LLM

- 聊天平台自身不直接调用模型
- 所有智能能力仍通过 member / agent 提供
- 因此摘要、协调、提醒、主动 `@` 等行为都由秘书 agent 产出，而不是平台内置能力

### 2.2 普通 agent 默认被动

- 普通 `independent agent` 默认不持续观察房间
- 只在被 `@`、被 reply、或被明确触发时执行

### 2.3 assistant 永远被动

- `assistant` 不具备自主参与能力
- 但在被动回复时，输出能力要增强：
  - 支持附件 / artifact 引用
  - 支持 `@任意 member`
  - 仍然直接发到聊天室

### 2.4 自治能力只收敛到秘书

- 房间中只有秘书 agent 具备“观察房间消息并主动发言”的能力
- 没有配置秘书的房间，所有 agent 都视为被动模式

## 3. 角色分层

### 3.1 普通 independent agent

- 角色定位：被动工具型一等公民
- 触发方式：
  - 被 `@`
  - 被 reply
  - 被显式调度
- 不持续观察房间，不主动发言

### 3.2 room secretary

- 角色定位：房间协调者 / 纪要维护者 / 节奏推进者
- 能力：
  - 观察房间内新消息
  - 判断是否需要参与
  - 主动发言
  - 主动 `@` human 或 agent
  - 可选维护房间 summary artifact

### 3.3 assistant

- 角色定位：owner 绑定的被动助理
- 能力边界：
  - 不自主参与
  - 被触发时可直接回复
  - 可带附件 / artifact
  - 可 `@任意 member`

## 4. 业务规则

### 4.1 没有秘书的房间

- 所有 agent 均为被动模式
- 房间行为与当前系统基本一致

### 4.2 有秘书的房间

- 只有秘书持续观察新消息
- 只有秘书能自主决定是否发言
- 其他 independent agent 仍保持被动
- assistant 仍然保持被动

### 4.3 秘书的职责

- 判断消息是否需要推进
- 判断是否需要提醒某个 human
- 判断是否需要 `@` 某个 agent
- 在必要时补一句协调型发言
- 在开启高级模式时维护房间摘要

### 4.4 第一阶段秘书不是隐式调度器

第一阶段秘书只做两件事：

- 自己说话
- 通过显式消息 `@` 其他 member

不做的事情：

- 不直接偷偷触发其他 agent 的后台执行
- 不做平台不可见的自动调度

这样能保证：

- 行为对房间成员完全可见
- 用户能理解为什么某个 agent 被叫出来
- 系统不会太快变成不可解释的自动化黑箱

## 5. 技术设计方向

### 5.1 房间配置

建议为房间增加可选配置：

- `secretaryMemberId: string | null`
- `secretaryMode: "off" | "coordinate" | "coordinate_and_summarize"`

建议语义：

- `off`
  - 无秘书
- `coordinate`
  - 秘书观察新消息，可主动发言和 `@`
- `coordinate_and_summarize`
  - 在协调能力基础上额外维护房间 summary artifact

### 5.2 新消息观察链路

当前系统的 agent session 只围绕 mention / reply 触发。

秘书模式需要新增一条专用链路：

1. 新消息落库
2. 判断房间是否配置秘书
3. 判断秘书是否在线且 binding 可用
4. 创建秘书专用 observe task
5. 下发给秘书 bridge / adapter
6. 秘书返回结构化决策

### 5.3 任务类型分层

当前 session / bridge task 基本都默认是“被动回复任务”。

建议未来显式区分任务类型：

- `message_reply`
- `room_observe`
- `summary_refresh`

这样可以避免把“观察房间”和“回复某条消息”混成同一种任务语义。

### 5.4 秘书输出结构

第一阶段建议支持以下结果：

- `ignore`
- `message`
- `message_with_mentions`

消息动作建议至少支持：

- `content`
- `replyToMessageId`
- `mentionedMemberIds[]`

后续再扩展：

- `attachments[]`
- `artifacts[]`
- 更复杂的 message action schema

### 5.5 assistant 输出升级

当前 agent 最终提交通常还是“纯文本 commit”。

为了支持 assistant 的被动增强能力，需要把 agent 输出升级为统一消息能力，至少支持：

- 纯文本回复
- `@member`
- 附件 / artifact 引用
- `replyToMessageId`

这样 assistant 才能真正做到：

- 被动回复
- 但表达完整

## 6. 上下文与摘要

### 6.1 平台不直接生成摘要

如果平台自己生成 summary，就意味着平台直接拥有 LLM 能力，这与当前原则冲突。

因此：

- summary 必须是 agent-generated artifact
- 最合适的产出者就是 room secretary

### 6.2 长上下文策略

第一阶段：

- 仍以 recent messages window 为主

后续增强：

- 由 secretary 维护 room summary artifact
- 当 agent 新加入房间或上下文过长时，注入：
  - 最近消息窗口
  - secretary 摘要

### 6.3 新加入房间的 agent

不建议灌全量历史原文。

建议使用：

- 最近消息窗口
- 房间摘要

这样可以同时控制：

- token 成本
- 执行延迟
- 上下文噪声

## 7. 实施顺序

### 7.1 第一阶段

- assistant 被动回复支持 `@任意 member`
- assistant 被动回复支持附件 / artifact 引用
- agent 提交消息逐步复用统一消息编排能力

### 7.2 第二阶段

- 房间秘书配置
- observe / decide 任务链路
- 秘书可 `ignore / speak / @member`
- 为秘书补充 cooldown / anti-spam

### 7.3 第三阶段

- secretary 维护房间 summary artifact
- 为新加入 agent 注入“最近消息 + 摘要”
- 长上下文房间的摘要增量刷新

## 8. 风险与约束

### 8.1 刷屏风险

秘书如果过度积极，容易造成频繁打断。

因此需要：

- cooldown
- 最短主动发言间隔
- 对“连续多条消息”的聚合观察

### 8.2 回环风险

秘书 `@` 某 agent，后者回复后又再次触发秘书，可能形成循环。

因此需要：

- 抑制窗口
- 最近触发因果链跟踪
- 对自触发链路做短期忽略

### 8.3 误判风险

秘书可能过早介入、误导对话节奏。

因此第一阶段应强调：

- 保守参与
- 少说
- 只在明显需要推进时发言

## 9. 当前已确认的业务结论

- 普通 independent agent 默认被动
- 房间可配置一个秘书 agent
- 秘书是唯一主动观察与主动发言的 agent
- assistant 永远被动
- assistant 被动回复时支持附件和 `@任意 member`
- independent 与 assistant 的消息都直接发到聊天室，不做 draft 中转
- 房间摘要不由平台内置 LLM 生成，而由秘书 agent 负责产出

## 10. 待后续进一步确认的实现细节

- 第一阶段是否严格限制一个房间只能有一个秘书
- 谁拥有配置 / 更换秘书的权限
- 秘书主动 `@human` 的默认产品提示形式
- assistant 附件能力第一阶段是否仅限 artifact 引用
- secretary summary artifact 的数据结构与刷新阈值
