# Codex LAN Remote

面向单台 Linux 服务器的多用户 Codex Web 客户端。每个账号保存自己的加密 OpenAI API
Key，每个工作区使用独立 Codex app-server、HOME 和文件目录。浏览器只访问 Gateway，
不会直接连接 app-server 或容器引擎。

也支持面向单个 Linux 账号的 `shared-host` 模式：CLI 与浏览器连接同一个长期运行的
app-server，用于接管和继续该账号已有的 Codex thread。该模式不跨 Linux 用户共享 home。

## 本地启动

从仓库根目录执行：

```powershell
Copy-Item apps/codex-lan-remote/.env.development.example apps/codex-lan-remote/.env
pnpm install
pnpm --filter @zcode/codex-lan-remote build
Get-Content apps/codex-lan-remote/.env | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { Set-Item "env:$($matches[1])" $matches[2] }
}
pnpm --filter @zcode/codex-lan-remote start
```

打开 `http://127.0.0.1:3040`，使用开发模板中的管理员账号登录，随后在设置中填写自己的
OpenAI API Key。`memory://` 仅用于本地调试，重启会清空账号和工作区。

## Linux 单节点部署

要求 Node 24、pnpm、rootless Podman 和可运行 Compose 的容器引擎。Gateway 作为普通系统
用户运行；PostgreSQL 与 Caddy 由 Compose 管理，Codex runtime 由该用户的 rootless
Podman 隔离启动。

```bash
podman build -t zcode/codex-runtime:0.138.0 -f apps/codex-lan-remote/Dockerfile.runtime .
pnpm install --frozen-lockfile
pnpm --filter @zcode/codex-lan-remote build
sudo useradd --system --create-home --shell /usr/sbin/nologin codex-remote
sudo install -d -o codex-remote -g codex-remote /var/lib/codex-lan-remote
docker compose --env-file /etc/codex-lan-remote-infra.env \
  -f apps/codex-lan-remote/deploy/compose.infrastructure.yaml up -d
sudo cp apps/codex-lan-remote/deploy/codex-lan-remote.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codex-lan-remote
```

将 runtime 镜像构建到 `codex-remote` 用户可见的 rootless Podman 存储；如果镜像由其他
用户构建，使用 `sudo -u codex-remote podman build ...` 重新构建一次。某些依赖 setuid
辅助程序的发行版与 `NoNewPrivileges=true` 不兼容，此时应把同一服务改为该账号的用户级
systemd 单元，不要让 Gateway 或 Podman 以 root 运行。

`/etc/codex-lan-remote.env` 至少配置 `DATABASE_URL`、`SESSION_PEPPER`、
`CREDENTIAL_ENCRYPTION_KEY`、首次启动用的 `BOOTSTRAP_ADMIN_EMAIL` 和
`BOOTSTRAP_ADMIN_PASSWORD`。生产环境设置 `NODE_ENV=production`、
`RUNTIME_DRIVER=podman`、`SECURE_COOKIES=1`，并将数据目录设为
`/var/lib/codex-lan-remote/{workspaces,runtime-homes}`。

密钥可这样生成：

```bash
openssl rand -base64 32   # CREDENTIAL_ENCRYPTION_KEY
openssl rand -hex 32      # SESSION_PEPPER
```

先备份 PostgreSQL、workspace 和 runtime HOME，再轮换主密钥。主密钥丢失后已保存的用户
API Key 无法恢复；当前版本轮换时需要用户重新提交 Key。

健康检查为 `GET /api/health`。Gateway 只应监听内网或 loopback，由 Caddy 提供 HTTPS；
不要公开 PostgreSQL、Podman socket 或 app-server stdio。

### 共享 app-server 模式

共享模式使用 Codex 自带的 managed daemon。先以共享 Linux 用户启动并确认 control socket：

```bash
codex app-server daemon bootstrap --remote-control
codex app-server daemon version
```

不要用普通的 `codex app-server --listen unix://...` 代替。Gateway 按 Codex remote
transport 在 control socket 上建立 `/rpc` WebSocket；`codex app-server proxy` 只是原始
字节转发，不是 JSONL 转换器。Codex control socket 会链接到用户的
`/tmp/codex-daemon-*`，因此还要给
Gateway 安装 shared-host systemd drop-in；普通 Podman 部署不需要这项设置：

```bash
sudo install -D -m 0644 \
  apps/codex-lan-remote/deploy/codex-lan-remote-shared-host.conf \
  /etc/systemd/system/codex-lan-remote.service.d/shared-host.conf
sudo systemctl daemon-reload
```

然后在 Gateway 环境文件中设置：

```dotenv
RUNTIME_DRIVER=shared-host
SHARED_OWNER_EMAIL=owner@example.com
SHARED_USER_HOME=/home/owner
SHARED_WORKSPACE_PATH=/home/owner/project
SHARED_APP_SERVER_SOCKET=/home/owner/.codex/app-server-control/app-server-control.sock
```

app-server 和 Gateway 必须以同一个 Linux 用户运行。CLI 使用设置页显示的命令连接，等价于：

```bash
codex --remote unix:///home/owner/.codex/app-server-control/app-server-control.sock -C /home/owner/project
```

浏览器选择已有 thread 时会先 `thread/resume`，再读取快照。独立 CLI 中正在执行的旧
turn 不能无损迁移；当前 turn 结束后可恢复，之后从上述共享地址启动即可实时接管。

仅有局域网 IP 时，在基础设施环境文件中设置 `SITE_ADDRESS=https://服务器IP` 和
`TLS_ISSUER=internal`。需要将 Caddy 容器 `/data/caddy/pki/authorities/local/root.crt`
导入手机和电脑并设为信任；公网域名部署则将 `TLS_ISSUER` 留空，让 Caddy 自动申请证书。
