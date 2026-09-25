# Codex LAN Remote 多用户服务

## 目标

在单台 Linux 服务器上提供面向手机和桌面浏览器的 Codex Web 客户端。每个用户使用
自己的 OpenAI API Key，只能访问自己的工作区、Codex 线程、运行时和审批请求。服务
必须支持恢复已有线程、流式查看运行过程、继续输入、中断和审批。

首个版本面向单节点部署。数据模型和运行时接口必须保留迁移到多 Gateway、多 Worker
的边界，但不得为了未来扩容在 MVP 中引入第二套会话状态。

## 身份与凭据

- 用户使用服务自身的邮箱和密码登录；密码使用 `scrypt` 加盐保存。
- 默认禁止公开注册。管理员通过一次性 bootstrap 配置创建首个账号，后续账号由管理员
  创建；开发环境可显式启用注册。
- 每个用户提交自己的 OpenAI API Key。Key 使用服务端主密钥经 AES-256-GCM 加密后保存，
  浏览器之后只能看到“已配置”状态，不能读回明文。
- 解密后的 Key 只注入该用户的 Codex app-server 进程，不进入日志、WebSocket 事件、
  工作区文件或工具子进程环境。
- HTTP session 使用随机不透明 token；数据库只保存 token 摘要。Cookie 为 HttpOnly、
  SameSite=Strict，生产环境要求 Secure。

## 状态所有者

| 状态                                           | 唯一所有者                        |
| ---------------------------------------------- | --------------------------------- |
| Codex thread、turn、item、工具执行             | 对应用户工作区的 Codex app-server |
| 用户、凭据密文、workspace 注册信息             | PostgreSQL                        |
| app-server 进程、RPC pending request、事件序号 | Runtime Supervisor                |
| 浏览器连接、订阅游标、控制租约                 | Gateway                           |
| 未提交输入                                     | 浏览器本地                        |

Gateway 不保存 Codex 业务历史。浏览器重连时先通过 `thread/read` 获取 app-server 快照，
再订阅当前连接的增量事件。

## 共享 app-server 接管模式

`shared-host` 是面向单个 Linux 账号的显式部署模式，用于让服务器上的 Codex CLI 与
浏览器接入同一个长期运行的 app-server，而不是由每个浏览器连接再启动一个 Codex
进程。

- 通过 `codex app-server daemon bootstrap --remote-control` 启动的 Codex managed daemon
  是 thread、turn、审批和工具执行的唯一 owner；它的 control socket 仅允许该 Linux
  用户访问。普通 `codex app-server --listen unix://...` socket 不兼容 proxy/remote，
  不能作为共享入口。
- Codex control socket 是指向该用户 `/tmp/codex-daemon-*` 目录的符号链接。共享模式的
  Gateway systemd 单元必须使用宿主 `/tmp`（`PrivateTmp=false`）；否则代理只能看到断裂
  的链接。该例外仅用于 `shared-host`，隔离 runtime 模式继续保留 `PrivateTmp=true`。
- Gateway 按 Codex remote transport 连接 owner：先连接 control Unix socket，再对固定
  `ws://localhost/rpc` 执行 WebSocket handshake，每条 JSON-RPC 使用一个 Text frame。
  `codex app-server proxy` 只转发原始字节，不把 stdio JSONL 转换成 WebSocket，不能作为
  Gateway 的 JSONL 适配层。Gateway 重启或浏览器断线只关闭 WebSocket 客户端，不关闭
  app-server 和正在执行的 turn。
- Gateway 的 app-server 握手必须符合目标 Codex 协议：`initialize` 显式发送
  `capabilities`（无能力声明时为 `null`），随后发送不带 `params` 的 `initialized`
  notification。协议字段不匹配必须使目标 runtime 启动失败，不能以超时掩盖。
- CLI 使用 `codex --remote unix://<path>` 连接相同 owner。只有通过该地址启动的 CLI
  会话才能与浏览器实时共享运行中状态；此前由独立 CLI 进程启动的 thread 只能在原
  turn 结束后通过 `thread/resume` 恢复，不能无损附着其 TTY。
- 选择已有 thread 时，Gateway 必须先执行 `thread/resume`，成功后再以 `thread/read`
  生成浏览器快照。后续 `turn/start` 不覆盖该 thread 已持有的 cwd。
- `thread/list` 在此模式下不按 Gateway 的虚拟 workspace 路径过滤，因为 thread 的
  cwd 来自共享 owner；新 thread 使用配置的共享 workspace 路径。
- 该模式必须配置唯一的 `SHARED_OWNER_EMAIL`、`SHARED_USER_HOME`、
  `SHARED_WORKSPACE_PATH` 和 `SHARED_APP_SERVER_SOCKET`。非 owner 账号不能查询 socket、
  thread 或建立 WebSocket attachment。
- 共享 home 使用该 Linux 账号已有的 Codex 登录状态，不接收或保存 Web 用户提交的
  OpenAI API Key。UI 必须显示“共享主机认证”，并隐藏 Key 编辑入口。
- 单个 `shared-host` 实例不得服务多个 Linux 身份。多人各自接管时，每个 Linux 用户
  部署独立实例/端口；在引入受审计的特权 broker 前，禁止由一个 Gateway `sudo` 到
  其他用户或读取其他 home。

```text
Codex managed daemon (single owner, control socket)
        ^                         ^
        | WebSocket over Unix      | --remote unix://...
browser -> Gateway                Codex CLI
        \----------- same thread / turn -----------/
```

```text
browser command
  -> authenticated Gateway
  -> (userId, workspaceId) runtime lease
  -> one Codex app-server owner
  -> command admission
  -> thread/turn state transition
  -> sequenced browser projection
```

## 隔离边界

- 每个 `(userId, workspaceId)` 使用独立 runtime、`HOME`、`.codex` 和 workspace 根目录。
- 生产模式通过 rootless Podman 启动运行时；开发模式可显式使用本机进程适配器。
- app-server 只通过父进程 stdio 通信，不监听公网端口。
- 工作区由服务端生成不透明 ID 并解析到
  `<workspaceRoot>/<userId>/<workspaceId>`；任何 API 都不得接受任意绝对路径。
- Runtime 设置 CPU、内存、PID 和空闲回收边界。不同用户不得复用容器、HOME volume、
  Codex rollout 或 API Key。
- Codex 工具进程使用 `shell_environment_policy.inherit=none`，避免读取网关和 OpenAI 凭据。

## 控制租约与事件顺序

1. 浏览器登录后列出当前用户的 workspace，不返回服务器路径。
2. 打开 workspace 时，Gateway 获取 `(userId, workspaceId)` runtime；并发请求共享同一个
   启动 Promise，避免重复创建 app-server。
3. Runtime 启动后发送 `initialize`、`initialized`，然后执行 `thread/list`。
4. 打开线程先使用 `thread/resume` 连接 owner，再使用 `thread/read` 获取快照。
5. 每个 workspace 同时只有一个浏览器 connection 持有可续期控制租约。其他连接为只读；
   用户可显式接管，旧 lease token 立即失效。
6. 空闲线程输入使用 `turn/start`；运行中补充输入使用 `turn/steer`。每个写命令包含
   `clientCommandId`，Gateway 在租约周期内幂等去重。
7. app-server notification 由 Runtime 添加单调递增 `sequence` 后广播。浏览器发现 gap 时
   重新读取 thread，而不是猜测缺失状态。
8. 审批绑定 `userId + workspaceId + threadId + turnId + requestId`，只有当前控制租约可回答；
   重复、过期或旧租约响应必须拒绝。
9. Runtime 空闲超时后先拒绝新命令，等待 pending RPC 有界结束，再关闭 app-server。
   thread 与 rollout 由独立 `.codex` volume 保留，下次启动继续恢复。

### 浏览器消息投影

- `thread.snapshot` 是浏览器消息列表的完整基线；收到新快照后，只投影该快照之后的实时
  事件，不能再次显示快照之前已经包含的 delta。
- 同一个 assistant item 的 `item/agentMessage/delta` 必须按到达顺序拼接为一条消息。
  item id 缺失时，只合并相邻的 assistant delta，不能跨越工具或 turn 状态事件合并。
- `turn/started`、`turn/completed` 和工具活动保持独立状态行，不能拆散 assistant 正文。

```text
thread.snapshot -> turn/started -> delta(item A)* -> turn/completed
      基线             状态          合并为一条            状态
```

## HTTP 与 WebSocket 接口

- `POST /api/auth/login`：登录并签发 session cookie。
- `POST /api/auth/logout`：吊销当前 session。
- `GET /api/me`：当前用户和 API Key 配置状态。
- `PUT /api/me/openai-key`：覆盖当前用户的加密 Key，并重启该用户的空闲 runtime。
- `GET /api/workspaces`：列出当前用户的 workspace。
- `POST /api/workspaces`：创建当前用户的隔离 workspace。
- `GET /api/workspaces/:id/threads`：通过 app-server 查询 thread。
- `GET /api/workspaces/:id/threads/:threadId`：读取 thread 快照。
- `GET /api/workspaces/:id/runtime-connection`：仅在 `shared-host` 模式下返回不含凭据的
  Unix socket 地址和 CLI 参数；其他用户统一返回 404。
- `GET /ws?workspaceId=...`：认证后的实时命令和事件通道。

浏览器 WebSocket 命令使用本项目的小型 envelope，不向公网直接暴露任意 app-server
JSON-RPC method。服务端只允许列举的 thread、turn 和审批操作，并在每次调用前重新校验
用户、workspace 与控制租约。

## 安全与失败语义

- 生产环境默认只通过 HTTPS/WSS 暴露 443；用户显式选择可信局域网 HTTP 部署时，必须
  显示明文传输风险。app-server、数据库和 runtime 控制接口不公网监听。
- 仅使用局域网 IP 时由反向代理签发内部 CA 证书，客户端必须安装并信任该 CA；不得为绕过
  证书提示退回明文 HTTP。
- 登录、注册、Key 更新和 WebSocket upgrade 都有限流与请求大小限制。
- 错误响应不暴露 Key、数据库详情、本机路径、Codex stderr 原文或其他用户标识。
- Runtime 启动失败仅影响目标 workspace；不得导致整个 Gateway 退出。
- PostgreSQL 暂时不可用时拒绝需要身份或写入的请求，不使用内存身份回退。
- 本地开发可显式配置 `DATABASE_URL=memory://` 使用非持久内存适配器；生产环境拒绝该配置，
  且数据库错误时不得自动切换到内存。
- Gateway 重启后浏览器 lease 全部失效，用户重新连接并从 app-server 快照恢复。
- 第一版是单 Gateway。部署多个副本前必须引入共享 lease/idempotency store，不能依赖
  负载均衡粘性掩盖状态所有权问题。

## UI

- 登录页、workspace 列表、thread 列表和会话页均适配手机与桌面。
- 会话页使用密集的单列布局，展示用户消息、assistant 输出、工具活动、运行状态和审批。
- 输入框在手机上固定满足 16px 字号，发送、停止、刷新和接管使用明确图标与 tooltip。
- API Key 只提供替换和删除操作，不显示已保存值。
- 只读连接必须持续可见地标识，不能让输入失败后才告知租约状态。

## Linux 部署

- 提供 PostgreSQL、反向代理的 Compose 示例和 Gateway systemd 单元；Gateway 通过当前
  非 root 用户的 rootless Podman socket 创建隔离 runtime。
- Gateway 以非 root 用户运行；生产 runtime 默认使用 rootless Podman。
- 必填 secrets：数据库口令、session pepper、32 字节凭据加密主密钥、bootstrap 管理员密码。
- workspace、runtime HOME 和数据库均使用独立持久卷，并记录备份与密钥轮换步骤。

## MVP 验收

1. 两个用户分别登录并配置不同 Key，互相无法枚举 workspace、thread 或事件。
2. 两个用户并发运行任务时使用不同 runtime、HOME、workspace 和环境凭据。
3. 手机断线重连后可以读取原 thread，并继续新 turn。
4. 同一用户两个浏览器中只有租约持有者可发送、停止和审批；接管后旧客户端立即只读。
5. Key 不出现在 API 响应、日志、工具环境和前端持久化中。
6. 非法 workspace/thread 组合统一返回 404，不能据此探测其他用户资源。
7. app-server 崩溃后目标 runtime 标记失败；再次打开可有界重启并恢复持久 thread。
8. `pnpm typecheck`、`pnpm lint`、项目单测、架构检查和移动/桌面 E2E 通过。
9. `shared-host` 中 CLI 与浏览器连接同一 Unix socket；浏览器接管后续 turn，CLI 可重新
   附着并读取同一 thread，关闭任一客户端不会终止 owner。
10. `shared-host` 的非 owner Web 用户无法枚举 thread、读取 socket 地址或升级 WebSocket。
11. assistant 流式输出按 item 合并显示；连续中文 token 不逐字拆行，刷新快照后不重复正文。

## 后续边界

- 多 Gateway 使用 Redis 或数据库 advisory lock 承担分布式 runtime/控制租约。
- 多 Worker 通过显式调度接口管理 runtime，不允许 Gateway 直接访问远端容器引擎。
- OIDC、企业 workload identity、仓库导入、配额计费和管理员审计属于后续阶段，不改变
  app-server 是 thread 真相所有者的规则。
