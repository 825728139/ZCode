# Desktop 局域网会话接管

## 目标

允许同一可信局域网内的手机浏览器通过固定 HTTP 地址连接 Desktop 已存在的
Window Host，并继续该窗口中已经打开的 Agent 会话。连接手机不得创建新的 Local
Host、Agent runtime、任务队列或远程 workspace session。

## MVP 配置

- 功能默认关闭。
- `ZCODE_LAN_REMOTE_ENABLED=1` 显式启用。
- `ZCODE_LAN_REMOTE_PORT` 配置监听端口，默认 `3031`。
- `ZCODE_LAN_REMOTE_PASSWORD` 是必填的长期访问密码；缺失时拒绝启动网关。
- `ZCODE_LAN_REMOTE_HOST` 默认 `0.0.0.0`，允许部署者收窄到指定网卡。
- `ZCODE_LAN_REMOTE_STATIC_ROOT` 仅用于开发或定制构建覆盖 Web 静态资源目录。
- 固定入口为 `http://<desktop-host>:<port>/`。入口不携带密码。

## 状态所有者

- Desktop Main 中唯一的 LAN gateway 拥有监听 socket、认证 session 和 WebSocket
  attachment 生命周期。
- 每个窗口的 Window Host 继续拥有服务集合、Agent runtime 和远程 workspace
  attachment；网关不缓存业务状态。
- CLI/runtime `CommandInbox` 继续拥有 running/busy 输入 admission；手机端不增加第二条
  accepted queue。
- 手机 Web 只持有 replayable projection、未提交草稿和 pending optimistic overlay。

```text
mobile HTTP login -> Desktop Main LAN gateway -> authenticated session cookie
mobile WebSocket  -> active Window Host attachment (web-remote-replayable)
                                      |
desktop renderer -> same Window Host -+-> same Agent runtime / CommandInbox
```

## 接口与事件顺序

1. Main 在 Electron ready 后读取环境配置；未启用时不监听任何 LAN 端口。
2. 手机访问 `/`。未认证时只返回密码表单，不返回 workspace 或会话信息。
3. `POST /api/lan-auth` 以常量时间比较密码，成功后签发进程内随机 session cookie。
4. `GET /api/server-info` 选择当前聚焦的主窗口；没有聚焦窗口时选择第一个具有
   Local Host 的主窗口，并返回该窗口已经发布的 workspace path。
5. `/ws` upgrade 必须同时通过 session cookie 与同源 `Origin` 校验。Main 为选中的
   Window Host 创建 `MessageChannelMain`，发送 `AttachServicePort`：
   `clientMode=web-remote-replayable`、`scope={kind:"local"}`。
6. WebSocket 一侧使用共享 `SocketProtocol` framing，MessagePort 一侧使用原始 RPC
   消息。网关只负责两者之间的帧转换，不解析或保存业务消息。禁止把 MessagePort
   原始消息直接写入 WebSocket，否则 Web 客户端会一直等待缺失的帧头。MessagePort
   flow-control 控制对象不得进入 WebSocket RPC 反序列化。
7. 任一侧关闭时关闭另一侧并释放 attachment。重复关闭必须幂等。
8. 手机重连创建新的 connection scope，由 `web-remote-replayable` snapshot/gap repair
   恢复投影；Desktop renderer 的 `desktop-continuous` 语义不变。

## 身份与窗口规则

- MVP 自动绑定请求时的活动主窗口，不持久化 `windowId`。
- 只公布 `windowWorkspaceMap` 中已打开的路径；不能通过 LAN API 请求任意本机目录。
- workspace 业务身份仍使用 Host 内现有规则
  `workspaceIdentity?.trim() || workspacePath`；网关不重建或按路径猜测 identity。
- Host 尚未就绪或窗口已经关闭时，WebSocket 以可重试错误关闭，不回退到新建 Host。

## 安全与失败语义

- 密码不得进入 URL、日志、server-info 或 renderer 设置。
- 认证 cookie 使用 `HttpOnly`、`SameSite=Strict`；生产 HTTPS 部署时追加 `Secure`。
- 登录请求限制大小；失败返回统一 401，不区分密码长度或内容。
- HTTP 明文仅适用于用户明确可信的 WPA2/WPA3 局域网；跨不可信网络应使用 TLS/VPN。
- 静态文件解析必须阻止目录穿越，HTML 不缓存，指纹资源可长期缓存。
- CSP 必须允许仓库构建产物实际使用的同源脚本、worker、WASM 编译、内嵌字体和
  HTTPS API 请求，不能因网关响应头破坏 Web 构建。HTML 内联启动脚本使用每次响应
  随机 nonce，不以 `unsafe-inline` 或第三方脚本源放宽权限。
- 端口占用、静态资源缺失或网关启动失败只记录错误，不阻止 Desktop 主窗口启动。
- App 退出时先停止接受新连接并关闭现有 attachment，再结束 Host 清理。

## 验收场景

1. 未设置 enable 时端口不监听。
2. enable 已设置但密码缺失时端口不监听，并产生不含秘密的告警。
3. 未认证客户端无法读取 server-info 或升级 WebSocket。
4. 正确密码登录后，刷新页面无需重新输入；错误密码保持在登录页。
5. 单窗口 Desktop 中，手机看到相同 workspace 和已有任务，手机发出的输入进入同一
   runtime；Desktop 与手机能观察到相同结果。
6. 手机断线不会终止 Desktop 会话；重连后恢复当前快照。
7. Host 未就绪、窗口关闭或 App 退出时连接有界失败，不悬挂 RPC。
8. 路径穿越请求返回 404，MessagePort 控制对象不会作为 WebSocket 二进制帧发送。
9. 认证后的浏览器能解析 Host 初始化帧，完成至少一个 setting/provider RPC，并渲染
   workspace shell；不得只留下空的 `div#root`。

## 后续产品化边界

- 设置页开关、端口编辑、密码轮换和在线设备管理通过 `IPlatformService` 接入，不能由
  UI 直接访问 `window.zcode`。
- 多窗口选择器使用进程内不透明 ID，并在每次 attachment 前重新校验窗口与 Host。
- mDNS 名称、TLS 和二维码属于发现/传输增强，不改变 Host/runtime 所有权。
