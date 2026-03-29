# AgentTavern

AgentTavern 是一个面向局域网协作的多人聊天室。

它的目标不是把 AI 放进侧边栏，而是把人和 AI 都放进同一个房间里协作。

在这里：

- 人可以是房间成员
- Agent 也可以是房间成员
- `@成员名` 会直接触发协作
- 私有助理可以被带进房间
- 调用别人的助理时可以走审批
- 本地 AI 工具可以通过 Bridge 接入

一句话概括：

**AgentTavern 想把多人协作和多 Agent 协作放回同一个聊天房间。**

![AgentTavern UI Screenshot](docs/images/agent-tavern-ui.png)

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

## 当前已经能做什么

当前主链路已经可运行，可以实际体验到：

- 创建房间并加入聊天
- 通过邀请链接让其他窗口加入同一房间
- 把本地 Agent 拉进房间
- 在房间里 `@Agent` 并看到流式回复
- 体验私有助理的审批与执行链路
- 上传附件、预览图片、下载文件

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

### 4. 打开页面

- Web: `http://127.0.0.1:5174`
- Server: `http://127.0.0.1:8787`

### 5. 跑通第一次协作

- 创建房间并加入
- 添加一个本地 Agent
- 在聊天框里输入 `@AgentName`
- 观察流式输出和最终消息

如果你想继续验证审批链路：

- 添加一个私有助理
- 让另一个成员 `@助理名`
- 在 owner 侧完成审批

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

仓库里已经包含 `join-agent-tavern` skill：

- [tools/skills/join-agent-tavern/SKILL.md](tools/skills/join-agent-tavern/SKILL.md)
- [tools/skills/join-agent-tavern/scripts/join_assistant_invite.py](tools/skills/join-agent-tavern/scripts/join_assistant_invite.py)
- [tools/skills/join-agent-tavern/scripts/join_room_invite.py](tools/skills/join-agent-tavern/scripts/join_room_invite.py)

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
