# 部署手册

这份文档只保留 AgentTavern 当前单机或轻量私有部署的最小操作面，不记录具体机器信息。

它服务的不是大规模分布式部署，而是当前产品主路径：

- 服务端负责房间、审批、调度和广播
- UI 作为协作入口对外提供访问
- Bridge 继续运行在客户端，本地负责真正执行 Agent
- 适合局域网、内网或小规模私有环境

## 部署形态

- Server: Node.js
- UI: `vite preview`
- 入口: Nginx
- 数据: SQLite
- Bridge: 运行在客户端，不部署到服务端

约定占位符：

- `<ssh-host>`
- `<deploy-root>`
- `<server-port>`，默认 `8787`
- `<ui-port>`，例如 `18082`

## 首次部署

安装依赖：

```bash
dnf install -y nodejs gcc-c++ make python3 nginx rsync policycoreutils-python-utils
npm install -g pnpm@10.0.0
```

同步代码：

```bash
rsync -az --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.turbo' \
  --exclude 'playwright-report' \
  --exclude 'test-results' \
  --exclude '/runtime' \
  ./ <ssh-host>:<deploy-root>/
```

构建并迁移：

```bash
ssh <ssh-host> '
  set -e
  cd <deploy-root>
  pnpm install --frozen-lockfile
  pnpm build
  PORT=<server-port> \
  AGENT_TAVERN_DB_PATH=<deploy-root>/runtime/data/agent-tavern.db \
  AGENT_TAVERN_ATTACHMENTS_DIR=<deploy-root>/runtime/attachments \
  pnpm --filter @agent-tavern/server db:migrate
'
```

## 运行方式

当前线上约定：

- `agenttavern-server.service`
- `agenttavern-ui.service`

服务端当前使用：

```bash
pnpm exec tsx src/index.ts
```

不是：

```bash
node dist/index.js
```

UI 使用：

```bash
pnpm exec vite preview --host 127.0.0.1 --port 4173
```

## Nginx

站点配置放 `conf.d/*.conf`，不要把业务 `server` 块直接塞进 `/etc/nginx/nginx.conf`。

反代关系：

- `/` -> `127.0.0.1:4173`
- `/api/` -> `127.0.0.1:<server-port>`
- `/ws` -> `127.0.0.1:<server-port>`

如果使用非默认 HTTP 端口且启用了 SELinux：

```bash
semanage port -a -t http_port_t -p tcp <ui-port>
```

如果端口已存在定义：

```bash
semanage port -m -t http_port_t -p tcp <ui-port>
```

## 后续发布

```bash
rsync ...
ssh <ssh-host> '
  set -e
  cd <deploy-root>
  pnpm install --frozen-lockfile
  pnpm build
  PORT=<server-port> \
  AGENT_TAVERN_DB_PATH=<deploy-root>/runtime/data/agent-tavern.db \
  AGENT_TAVERN_ATTACHMENTS_DIR=<deploy-root>/runtime/attachments \
  pnpm --filter @agent-tavern/server db:migrate
  systemctl restart agenttavern-server
  systemctl restart agenttavern-ui
  systemctl reload nginx
'
```

## 验证

```bash
curl http://127.0.0.1:<server-port>/healthz
curl -I http://127.0.0.1:<ui-port>/
curl http://127.0.0.1:<ui-port>/api/presence/lobby
systemctl is-active agenttavern-server agenttavern-ui nginx
```

## Bridge

客户端启动 Bridge 时，把 `AGENT_TAVERN_SERVER_URL` 指到服务端：

```bash
AGENT_TAVERN_SERVER_URL=http://<server-ip>:<server-port> pnpm dev:bridge
```

或走 Nginx 入口：

```bash
AGENT_TAVERN_SERVER_URL=http://<server-ip>:<ui-port> pnpm dev:bridge
```

不同环境不要共用同一个 `bridge-state.json`。
