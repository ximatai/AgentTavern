# AgentTavern

AgentTavern 是一个可本地部署的多人协作聊天室，重点不是“把很多 Agent 拉进来聊天”，而是让企业或团队在自己的网络和权限边界内协同使用 Agent。

它的核心价值有两点：

- 聊天室和执行链路都可以本地部署
- 私有助理的调用受到 owner 与审批约束

一句话概括：

**AgentTavern 是一个面向企业内协作的、可本地部署且带审批约束的 Agent 协作执行空间。**

![AgentTavern UI Screenshot](docs/images/agent-tavern-ui.png)

## 核心价值

很多 2026 年的 Agent 产品已经能把多个 Agent 放到同一个界面里，但这不是 AgentTavern 的根本特色。

它真正强调的是：

- **本地部署**
  - 适合局域网、内网、单机或私有环境
  - 不要求把协作过程托管到外部平台

- **本地执行**
  - 服务端不直接接管用户本机 Agent
  - 通过 Bridge 把执行留在本地 CLI、代码仓库和凭据环境里

- **审批约束**
  - 私有助理归 owner 所有
  - 别人调用时默认要经过 owner 审批
  - owner 自己调用时可直接使用

- **房间协作**
  - 人、Agent、私有助理在同一房间上下文里协作
  - 消息、审批、流式输出、附件、摘要都落在同一条协作记录中

## 典型场景

- 企业内部团队在局域网或内网协作
- 同一个项目里需要借用不同人的 Agent 能力
- 希望保留本地代码仓库、CLI、凭据和运行环境
- 需要清晰的 owner / approval / authorization 边界
- 希望把讨论、审批、执行结果和附件放在同一房间上下文里

## 当前支持

- 房间聊天、邀请加入、直接拉人入房
- `@成员名` 触发 Agent 协作
- 私有助理审批链路
- 流式输出、附件上传、Agent 生成附件回传
- room secretary 协调与摘要
- 本地 Bridge 执行链路
- `codex_cli`、`claude_code`、`opencode`、`local_process`
- `openai_compatible`

## Quick Start

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

也可以先运行：

```bash
pnpm dev
```

它只会启动 `server + ui`。如果要接本地 Agent，仍然需要单独启动 `pnpm dev:bridge`。

### 4. 打开页面

- Web: `http://127.0.0.1:5174`
- Server: `http://127.0.0.1:8787`

### 5. 跑通主链路

最短体验路径：

1. 登录一个 human 身份
2. 创建房间
3. 让另一个窗口或同事加入同一房间
4. 创建一个独立 Agent，或接入一个私有助理
5. 在房间里输入 `@AgentName`
6. 观察流式输出和最终消息

如果要验证审批链路：

1. 创建一个私有助理
2. 让其他成员在房间里 `@助理名`
3. 在 owner 侧完成审批

## 接入本地 Agent

如果你已经在本机使用 Codex、Claude Code、OpenCode 或自定义本地进程，最常见的路径只有两步：

1. 把 AgentTavern 跑起来
2. 把你当前机器上的 Agent 接进来

推荐做法是先安装仓库自带的 `join-agent-tavern` skill，再用邀请链接把当前会话接入系统。

### 1. 启动本地 Bridge

Bridge 负责在你的本机执行 Agent，服务端只负责调度。

本地开发环境：

```bash
pnpm dev:bridge
```

如果服务端不在本机：

```bash
AGENT_TAVERN_SERVER_URL=http://<server-host>:8787 pnpm dev:bridge
```

### 2. 安装 `join-agent-tavern` skill

```bash
pnpm skill:install -- join-agent-tavern
```

### 3. 接入当前会话

推荐优先使用已安装的 `join-agent-tavern` skill，通过房间邀请或私有助理邀请把当前会话接入系统。

如果你不通过 skill 菜单，也可以直接运行仓库脚本：

房间接入：

```bash
python3 tools/skills/join-agent-tavern/scripts/join_room_invite.py \
  --invite "http://127.0.0.1:8787/join/<token>" \
  --backend-type opencode \
  --cwd "/absolute/path/to/project" \
  --thread-id "opencode-main"
```

私有助理接入：

```bash
python3 tools/skills/join-agent-tavern/scripts/join_assistant_invite.py \
  --invite "http://127.0.0.1:8787/private-assistant-invites/<token>" \
  --cwd "/absolute/path/to/project" \
  --thread-id "opencode-main"
```

### 4. 如何确认接入成功

- Bridge 日志持续在线，没有 heartbeat 错误
- join / accept 脚本返回 `attached: true` 或明确 attach 结果
- UI 中对应 Agent 的运行态从 `pending_bridge` 变成 `ready`
- 在房间里 `@AgentName` 后能看到流式输出

## 文档

- `docs/developer-guide.md`：从哪里开始读代码
- `docs/business-design.md`：业务模型与权限边界
- `docs/api-integration.md`：HTTP / WebSocket 接口
- `docs/local-bridge-design.md`：Bridge 与本地执行设计
- `docs/task-tracking.md`：任务追踪
