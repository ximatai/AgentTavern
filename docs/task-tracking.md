# 开发计划与任务跟踪

## 1. 文档约定

本文件用于指导短期和中期开发，不只是记录想法。

维护规则：

- 开发开始前，先把任务写入本文件
- 开发完成后，及时更新本文件中的状态
- 范围变化时，及时调整优先级和任务拆分
- 已完成工作必须保留记录，不直接删除
- 已完成工作按树结构标记，便于追踪父任务和子任务的完成情况
- 若某项工作不能直接提升“本地 Agent 可接入性”“真实可用性”“UI 可替换性”，默认不得长期占用当前阶段主线
- 对基础设施类任务，若连续两轮仍未转化为用户可感知收益，应降级优先级或先冻结为设计项

状态约定：

- `[ ]` 未开始
- `[-]` 进行中
- `[x]` 已完成

优先级约定：

- `P0` 当前阻塞项，优先处理
- `P1` 当前阶段关键项
- `P2` 可顺延项

## 2. 当前阶段

项目状态：第一阶段主链路已跑通，进入稳定性与补齐验证阶段

当前目标：

- 先保证本地 Agent 接入闭环稳定可用
- 先保证真实联调和日常使用可持续
- 在不偏离主线的前提下，为后续 UI 演进打稳基线

## 3. Now

当前 1 到 2 周内优先处理的事项。

当前短期路线：

- 先做真实可用性回归
- 再收前端体验
- `accepted` 任务恢复维持设计先行，暂不深挖实现

- [x] `P1` 服务端关键链路自动化验证
  - [x] 覆盖重复加入返回 `409`
  - [x] 覆盖 owner 不在线时助理调用收口
  - [x] 覆盖审批通过链路
  - [x] 覆盖审批拒绝链路
  - [x] 覆盖服务重启时待审批请求收口
  - [x] 覆盖独立 Agent 触发执行
  - [x] 完成独立 review

- [x] `P1` 客户端本地 Agent Bridge 设计
  - [x] 明确“服务端只调度，不直接执行客户端本地 Agent”
  - [x] 明确本地 Bridge / 服务端 / provider driver 三层边界
  - [x] 明确 Codex 方向优先使用本地 Bridge + SDK thread/resume
  - [x] 补充设计文档
  - [x] 完成独立 review

- [x] `P1` 客户端本地 Agent Bridge 协议基线
  - [x] 定义 Bridge 注册协议
  - [x] 定义 Bridge 心跳协议
  - [x] 落地服务端表结构
  - [x] 落地服务端接口
  - [x] 补充自动化验证
  - [x] 完成独立 review

- [x] `P1` AgentBinding Bridge 归属基线
  - [x] 为 `AgentBinding` 增加 `bridgeId`
  - [x] 增加 Bridge attach 协议
  - [x] 补充自动化验证
  - [x] 完成独立 review

- [x] `P1` 客户端本地 Agent Bridge 任务协议
  - [x] 定义任务拉取协议
  - [x] 定义任务 accept / delta / complete / fail 协议
  - [x] 将已 attach 的 Codex binding 切到桥接任务流
  - [x] 增加本地 Bridge 进程骨架
  - [x] 补充自动化验证
  - [x] 完成独立 review

- [x] `P1` Bridge 归属与任务领取边界收紧
  - [x] 收紧 attach 的单归属语义
  - [x] 将 task pull 改为带租约的 claim
  - [x] 修正 Bridge skeleton 为先 accept 再回报失败
  - [x] 补充自动化验证
  - [x] 完成独立 review

- [-] `P1` Bridge 重连与 accept 边界收紧
  - [x] 增加 Bridge 身份本地持久化
  - [x] 收紧 register 重连时的 metadata 保留语义
  - [x] 将 task accept 改为条件更新
  - [x] 补充自动化验证
  - [ ] 完成独立 review

- [-] `P1` Bridge 运行时协议基线
  - [x] 为 `register / heartbeat / pull / accept / delta / complete / fail` 落地 `bridgeInstanceId`
  - [x] 补充自动化验证
  - [x] 完成独立 review

- [x] `P1` 助理 owner 自调用直通
  - [x] owner 自己 `@` 自己的助理时跳过审批
  - [x] 补充自动化验证

## 4. Next

紧接着进入的开发任务。

- [ ] `P1` 客户端本地 Agent Bridge 开发
  - [x] 实现第一版可执行 Bridge driver
  - [x] 实现第一版 Codex driver 过渡实现
  - [x] 拆分 Bridge 状态与任务处理模块
  - [x] 将接受邀请后的 Codex 助理 attach 到本地 Bridge
  - [-] 将 Codex thread 助理链路切到本地 Bridge 执行
  - [-] 做真实可用性回归
    - [x] 复测房间创建、bridge 启动、invite、attach、执行闭环
    - [x] 复测 owner 自调用 assistant
    - [x] 复测普通成员触发 assistant 审批
  - [-] 补齐本地 Bridge 执行链路自动化验证
    - [x] 增加 Bridge 侧状态与任务处理测试
    - [x] 补一条端到端本地 Bridge 执行验证
  - [ ] 完成独立 review

- [x] `P1` Codex 助理 skill 版本化基线
  - [x] 将 `join-agent-tavern` skill 源文件收回仓库
  - [x] 提供通用安装入口
  - [x] 对齐文档
  - [x] 收口 skill 的结构化失败结果
  - [x] 在 accept 阶段持久化 `cwd`
  - [x] 完成独立 review

- [-] `P1` Bridge 任务恢复设计
  - [x] 对齐 skill 版本化的独立 review 结果
  - [x] 明确 `accepted` 任务的 fenced recovery 语义
  - [x] 明确恢复过程中的 session 状态收口
  - [x] 补充设计文档
  - [x] 统一 `bridgeInstanceId` 的接口口径
  - [x] 统一协议命名
  - [x] 补充设计级验证
  - [x] 明确当前只停留在设计层，未完成 `bridgeInstanceId` 基线和真实回归前不进入实现
  - [ ] 完成独立 review

- [x] `P1` 前端可用性补强
  - [x] 自动滚动到底部
  - [x] 更清晰的流式状态展示
  - [x] 邀请与审批交互增加即时反馈
  - [x] 回车发送消息，`Shift + Enter` 换行
  - [x] `@成员` 输入自动补全

## 5. Later

中期任务，按开发进展推进。

- [ ] `P2` 更强的运行时恢复策略
  - [ ] 评估重启后的会话恢复边界
  - [ ] 评估更稳定的 presence / token 模型
  - [ ] 仅在成为真实阻塞项后再进入实现

- [ ] `P2` 面向酒馆式像素 UI 的表现层预留
  - [ ] 整理事件消费边界
  - [ ] 避免 Web UI 反向绑定后端模型
  - [ ] 为未来替换 UI 保持协议稳定


## 6. 已完成

- [x] `P0` 文档与工程基线初始化
  - [x] 建立基础文档目录
  - [x] 完成 README
  - [x] 完成业务设计文档
  - [x] 完成技术基线文档
  - [x] 完成接口文档
  - [x] 补充开发计划维护约定
  - [x] 补充关键业务与连接规则
  - [x] 定义第一版领域模型
  - [x] 定义第一版实时事件协议
  - [x] 定义第一版 SQLite 表结构
  - [x] 打通本地开发启动链路
  - [x] 完成房间聊天 MVP
  - [x] 完成 Agent 作为成员链路
  - [x] 完成助理审批链路
  - [x] 完成本地 Agent 接入基线
  - [x] 完成前端演示壳
  - [x] 将前端演示壳收为第一版可测试聊天页
  - [x] 完成第一轮服务端路由结构收敛
  - [x] 收敛第一批接口冲突与 mention 状态一致性
  - [x] 完成重启语义第一刀
  - [x] 完成服务端关键链路第一轮自动化验证
  - [x] 完成客户端本地 Agent Bridge 第一版设计
  - [x] 完成客户端本地 Agent Bridge 协议基线
  - [x] 完成 AgentBinding Bridge 归属基线
  - [x] 完成客户端本地 Agent Bridge 任务协议基线
  - [x] 收紧 Bridge 归属与任务领取边界
  - [x] 收紧 Bridge 重连与 accept 边界
  - [x] 收紧 Agent 执行与管理边界
  - [x] 拆分公开 DTO 与内部模型
  - [x] 扩展公开 DTO 覆盖范围
  - [x] 明确 Codex thread 助理接入规则
  - [x] 设计 Codex thread 助理数据模型
  - [x] 完成一次性助理邀请接口基线
  - [x] 完成 `codex_cli` thread 绑定 adapter
  - [x] 完成加入聊天室的 Codex skill
  - [x] 初始化 pnpm workspace 工程骨架
  - [x] 初始化 server 应用骨架
  - [x] 初始化 web 应用骨架
  - [x] 初始化 shared 包
  - [x] 初始化 agent-sdk 包
  - [x] 补充 `.gitignore`
  - [x] 完成基础 typecheck
