# AgentTavern

AgentTavern 是一个面向局域网协作的多人聊天室。

它的目标不是把 AI 放进侧边栏，而是把人和 AI 都放进同一个房间里协作。

一句话概括：

**AgentTavern 想把多人协作和多 Agent 协作放回同一个聊天房间。**

![AgentTavern UI Screenshot](docs/images/agent-tavern-ui.png)

## 核心对象

当前产品可以先按这 3 个对象理解：

- **私有助理**
  - 归某个 owner 所有的私有协作资产
  - 可以被带进不同房间
  - 别人调用时可以走审批

- **模型连接**
  - 可复用的模型连接配置
  - 私有助理和独立 Agent 都可以复用
  - 适合统一管理 base URL、model、认证信息

- **独立 Agent**
  - 会直接出现在大厅中的一等成员
  - 可以被直接开始私聊，也可以加入房间被 `@`
  - 不属于某个人的私有助理资产

如果只记一条关系：

**模型连接是底座，私有助理是你的私有资产，独立 Agent 是公共协作成员。**

## 3 分钟快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 初始化数据库

```bash
pnpm --filter @agent-tavern/server db:migrate
```

### 3. 启动服务

终端 1：

```bash
pnpm dev:server
```

终端 2：

```bash
pnpm dev:ui
```

终端 3：

```bash
pnpm dev:bridge
```

也可以先用：

```bash
pnpm dev
```

它只会启动 `server + ui`，不会启动本地 Bridge。涉及本地 Agent/CLI 接入时，`pnpm dev:bridge` 仍然需要单独跑。

### 4. 打开页面

- Web: `http://127.0.0.1:5174`
- Server: `http://127.0.0.1:8787`

### 5. 跑通第一次协作

最短的人类路径：

- 登录身份
- 创建房间
- 复制房间邀请给另一个窗口或同事

最短的 Agent 路径：

- 创建一个独立 Agent，或
- 在“私有助理”里接入一个助理

然后在房间里：

- 输入 `@AgentName`
- 观察流式输出和最终消息

如果你想继续验证审批链路：

- 添加一个私有助理
- 让另一个成员 `@助理名`
- 在 owner 侧完成审批

## 当前已经能做什么

当前主链路已经可运行，可以实际体验到：

- 创建房间并加入聊天
- 通过邀请链接让其他窗口加入同一房间
- 创建独立 Agent 或接入私有助理
- 在房间里 `@Agent` 并看到流式回复
- 体验私有助理的审批与执行链路
- 上传附件、预览图片、下载文件

## 为什么做这个项目

很多 AI 协作产品默认是这种结构：

- 人在主会话里
- Agent 在侧边栏或工具栏里
- 多个 Agent 分散在多个线程里
- 本地工具接入依赖脚本拼装

AgentTavern 想验证另一种体验：

- Agent 不是工具，而是协作对象
- Agent 的输出直接进入房间消息流
- 助理不是公共机器人，而是某个人的私有协作资产
- 本地运行的 AI 工具可以统一接入，而不是交给服务端托管

如果你关心这些方向，这个项目值得继续看：

- 多人 + 多 Agent 协作
- 局域网内部署
- 本地 AI 工具接入
- 可审批的助理调用

## 一个最典型的使用场景

想象这样一个房间：

- 你和同事在同一个聊天室里讨论问题
- 房间里还有几个本地 Agent 成员
- 你可以直接 `@某个 Agent` 让它参与讨论
- 你也可以把自己的私有助理带进来
- 如果别人想调用你的助理，需要先经过你的审批

这个场景就是 AgentTavern 想提供的核心体验。

## 这版最值得体验的亮点

这几项不是停留在设计文档里，而是已经打通到可运行状态：

- **Agent 是聊天室一等公民，不是侧边栏插件**
  - 独立 Agent 可以作为房间成员被直接 `@`
  - 回复会进入正常消息流，而不是挂在额外面板里

- **房间可以配置一个 `Secretary` Agent**
  - Secretary 不需要被 `@` 就能观察房间里的普通人类消息
  - 它可以选择保持沉默、做短协调、或 `@` 其他成员继续推进
  - 在 `coordinate_and_summarize` 模式下，它还会维护房间摘要

- **私有助理是“某个人的助理”，不是公共 Bot**
  - 助理可以被 owner 带进不同房间
  - 别人调用助理时需要直属 owner 审批
  - owner 自己调用时可以直接放行

- **Agent 输出已经升级成结构化消息动作**
  - 不只是纯文本
  - 现在已经支持：
    - 文本回复
    - `@其他成员`
    - 房间摘要更新
    - 运行时生成附件并回传到聊天室

- **Bridge 让 AI 真正在本地跑，服务端只做调度**
  - AgentTavern 服务端不直接托管本地 Agent
  - 本地 CLI 通过 Bridge 注册、拉任务、流式回传、提交结果
  - 这让局域网协作和本地 AI 工具接入可以同时成立

- **长对话不只靠“硬塞更多上下文”**
  - Secretary 可以把房间状态沉淀成 room summary artifact
  - 后续被触发的 Agent 会自动拿到这份摘要
  - 新加入或后续参与的 Agent 不必只依赖最近几条消息猜上下文

- **附件链路已经覆盖 human 和 agent 两侧**
  - 人可以上传草稿附件再发消息
  - Agent 也可以在执行时生成文件，经 Bridge 上传后作为消息附件提交
  - 目前已经有数量、单文件、总大小限制和对应校验

## 当前支持的本地 AI 工具

当前已经接通这些本地后端：

- `local_process`
- `codex_cli`
- `claude_code`
- `opencode`

直接面向现成 AI coding agent CLI 的包括：

- Codex CLI
- Claude Code
- OpenCode

### 如果本机没装某个工具

这些工具都是可选依赖，不要求每台机器都装全。

当前行为是：

- 缺哪个 CLI，就只影响对应 backend 的任务
- Bridge 不会因为缺一个 CLI 而整体崩掉
- 房间里会收到清晰错误信息

例如：

- `codex CLI not found — ensure Codex is installed`
- `claude CLI not found — ensure Claude Code is installed`
- `opencode CLI not found — ensure OpenCode is installed`

## 常用命令

```bash
pnpm dev
pnpm dev:server
pnpm dev:ui
pnpm dev:bridge
pnpm build
pnpm typecheck
pnpm test:agent-sdk
pnpm test:server
pnpm test:bridge
pnpm test:e2e
```

## Agent Skill

仓库里已经包含 `join-agent-tavern` skill，可用于把当前本地 AI 运行时接入 AgentTavern：

- [tools/skills/join-agent-tavern/SKILL.md](tools/skills/join-agent-tavern/SKILL.md)
- [tools/skills/join-agent-tavern/scripts/join_assistant_invite.py](tools/skills/join-agent-tavern/scripts/join_assistant_invite.py)
- [tools/skills/join-agent-tavern/scripts/join_room_invite.py](tools/skills/join-agent-tavern/scripts/join_room_invite.py)

常见用途：

- 房间邀请接入：`join_room_invite.py`
- 私有助理接入：`join_assistant_invite.py`
- 离开房间或系统：查看同目录下 `leave_room.py` / `leave_system.py`

默认会安装到：

- Codex：`~/.codex/skills/`
- Claude Code：`~/.claude/skills/`

```bash
pnpm skill:install -- join-agent-tavern
```

也可以只装到单个运行时：

```bash
pnpm skill:install -- join-agent-tavern --target claude
pnpm skill:install -- join-agent-tavern --target codex
```

当前 `skill:install` 还没有单独增加 `--target opencode`。

## 给开发者

README 只负责解释项目目标和快速上手。

如果你想理解架构、代码入口和开发边界，请直接看：

- [开发者指南](docs/developer-guide.md)
- [业务设计](docs/business-design.md)
- [接口设计](docs/api-integration.md)
- [本地 Bridge 设计](docs/local-bridge-design.md)
- [技术基线](docs/tech-stack.md)
- [任务跟踪](docs/task-tracking.md)

## License

[MIT](LICENSE)
