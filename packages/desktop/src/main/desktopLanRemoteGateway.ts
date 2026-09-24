import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, relative, resolve, sep } from "node:path";
import {
  SERVER_REMOTE_PROTOCOL_VERSION,
  ZCODE_VERSION,
  type ServerRemoteInfo,
} from "@zcode/shared";
import { Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { WebSocketServer, WebSocket, type RawData } from "ws";

const AUTH_COOKIE_NAME = "zcode_lan_remote_session";
const MAX_LOGIN_BODY_BYTES = 4 * 1024;
const MAX_RPC_FRAME_BYTES = 16 * 1024 * 1024;

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface DesktopLanRemoteMessagePort {
  on(event: "message", listener: (event: { data: unknown }) => void): this;
  on(event: "close", listener: () => void): this;
  off(event: "message", listener: (event: { data: unknown }) => void): this;
  off(event: "close", listener: () => void): this;
  postMessage(data: Uint8Array): void;
  start(): void;
  close(): void;
}

export interface DesktopLanRemoteTarget {
  label: string;
  workspaces: readonly string[];
}

export interface DesktopLanRemoteGatewayOptions {
  host: string;
  port: number;
  password: string;
  staticRoot: string;
  serverId: string;
  serverName?: string;
  resolveTarget: () => DesktopLanRemoteTarget | null;
  attach: () => DesktopLanRemoteMessagePort;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface DesktopLanRemoteGateway {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function constantTimeEqual(left: string, rightDigest: Buffer): boolean {
  return timingSafeEqual(digest(left), rightDigest);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (name) result.set(name, decodeURIComponent(value));
  }
  return result;
}

function writeSecurityHeaders(response: ServerResponse, scriptNonce?: string): void {
  const nonceSource = scriptNonce ? ` 'nonce-${scriptNonce}'` : "";
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${nonceSource}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: https:; worker-src 'self' blob:; connect-src 'self' https: ws: wss:`,
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function injectInlineScriptNonce(html: string, nonce: string): string {
  return html.replaceAll("<script>", `<script nonce="${nonce}">`);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  writeSecurityHeaders(response);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function sendLoginPage(response: ServerResponse, failed = false): void {
  writeSecurityHeaders(response);
  response.writeHead(failed ? 401 : 200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ZCode 局域网接管</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#111;color:#f4f4f5}*{box-sizing:border-box}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:20px;background:#111}.panel{width:min(100%,360px);border:1px solid #3f3f46;background:#18181b;padding:24px;border-radius:8px}
h1{font-size:18px;margin:0 0 8px}p{font-size:13px;line-height:1.5;color:#a1a1aa;margin:0 0 20px}label{display:block;font-size:13px;margin-bottom:7px}
input,button{width:100%;height:42px;border-radius:6px;font:inherit}input{border:1px solid #52525b;background:#09090b;color:#fafafa;padding:0 12px}button{margin-top:12px;border:0;background:#fafafa;color:#18181b;font-weight:600;cursor:pointer}.error{color:#fca5a5;margin-bottom:12px}
</style></head><body><main class="panel"><h1>ZCode Desktop</h1><p>连接这台电脑中已经打开的会话。</p>
${failed ? '<p class="error">访问密码不正确。</p>' : ""}
<form method="post" action="/api/lan-auth"><label for="password">访问密码</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus/><button type="submit">连接</button></form>
</main></body></html>`);
}

async function readLoginPassword(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_LOGIN_BODY_BYTES) throw new Error("LOGIN_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("password") ?? "";
}

function isInside(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

async function resolveStaticFile(staticRoot: string, pathname: string): Promise<string | null> {
  const root = resolve(staticRoot);
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  const candidates =
    !relativePath || relativePath === "remote"
      ? [resolve(root, "lan-remote.html"), resolve(root, "index.html")]
      : [resolve(root, relativePath)];
  for (const candidate of candidates) {
    if (!isInside(root, candidate)) continue;
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // 入口允许从 Desktop renderer 回退到独立 Web build。
    }
  }
  return null;
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function wrapLanRemoteWebSocket(socket: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      socket.close(1003, "Binary RPC frames required");
      return;
    }
    onData.fire(VSBuffer.wrap(toUint8Array(data)));
  });
  socket.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  socket.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer) {
      if (socket.readyState === WebSocket.OPEN) socket.send(buffer.buffer, { binary: true });
    },
    end() {
      socket.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      socket.close();
      onData.dispose();
      onClose.dispose();
      onEnd.dispose();
    },
  };
}

export function bridgeLanRemoteSocket(
  socket: WebSocket,
  port: DesktopLanRemoteMessagePort,
): () => void {
  const transport = wrapLanRemoteWebSocket(socket);
  const protocol = new SocketProtocol(transport);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    socket.off("close", dispose);
    socket.off("error", dispose);
    port.off("message", onPortMessage);
    port.off("close", dispose);
    protocolMessageDisposable.dispose();
    protocol.dispose();
    try {
      port.close();
    } catch {
      // 双方可能同时关闭；attachment 清理必须幂等。
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, "Attachment closed");
    }
  };
  const onPortMessage = (event: { data: unknown }) => {
    // MessagePort flow-control 控制对象只属于 Host attachment，不能进入 SocketProtocol。
    if (!(event.data instanceof Uint8Array)) return;
    if (socket.bufferedAmount > MAX_RPC_FRAME_BYTES) {
      socket.close(1013, "Client is too slow");
      return;
    }
    // Bug 原因：MessagePort 承载原始 RPC 消息，浏览器 WebSocket 客户端需要
    // SocketProtocol 帧头；直接透传会让客户端永远无法识别 Initialize。
    protocol.send(VSBuffer.wrap(event.data));
  };
  const protocolMessageDisposable = protocol.onMessage((message) => {
    port.postMessage(message.buffer);
  });
  socket.on("close", dispose);
  socket.on("error", dispose);
  port.on("message", onPortMessage);
  port.on("close", dispose);
  port.start();
  return dispose;
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}

export async function startDesktopLanRemoteGateway(
  options: DesktopLanRemoteGatewayOptions,
): Promise<DesktopLanRemoteGateway> {
  const expectedPasswordDigest = digest(options.password);
  const sessionToken = randomBytes(32).toString("base64url");
  const expectedSessionDigest = digest(sessionToken);
  const isAuthenticated = (request: IncomingMessage) => {
    const cookie = parseCookies(request.headers.cookie).get(AUTH_COOKIE_NAME);
    return cookie ? constantTimeEqual(cookie, expectedSessionDigest) : false;
  };

  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "POST" && url.pathname === "/api/lan-auth") {
        const password = await readLoginPassword(request);
        if (!constantTimeEqual(password, expectedPasswordDigest)) {
          sendLoginPage(response, true);
          return;
        }
        response.setHeader(
          "Set-Cookie",
          `${AUTH_COOKIE_NAME}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict`,
        );
        response.writeHead(303, { Location: "/" });
        response.end();
        return;
      }
      if (!isAuthenticated(request)) {
        if (url.pathname.startsWith("/api/")) sendJson(response, 401, { error: "Unauthorized" });
        else sendLoginPage(response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/server-info") {
        const target = options.resolveTarget();
        if (!target) {
          sendJson(response, 503, { error: "Desktop Window Host is not ready" });
          return;
        }
        const info: ServerRemoteInfo = {
          serverId: options.serverId,
          ...(options.serverName ? { name: options.serverName } : {}),
          version: ZCODE_VERSION,
          protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
          authRequired: true,
          workspaces: target.workspaces.map((path) => ({ path, label: basename(path) || path })),
          capabilities: {
            desktopContinuous: true,
            websocketRpc: true,
            processResourceTelemetry: true,
            desktopLanAttachment: true,
          },
        };
        sendJson(response, 200, info);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      const filePath = await resolveStaticFile(options.staticRoot, url.pathname);
      if (!filePath) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      const isHtml = filePath.endsWith(".html");
      const scriptNonce = isHtml ? randomBytes(18).toString("base64url") : undefined;
      const body =
        request.method === "HEAD"
          ? undefined
          : isHtml && scriptNonce
            ? injectInlineScriptNonce(await readFile(filePath, "utf8"), scriptNonce)
            : await readFile(filePath);
      writeSecurityHeaders(response, scriptNonce);
      response.writeHead(200, {
        "Cache-Control": isHtml ? "no-cache" : "public, max-age=31536000, immutable",
        "Content-Type": contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      });
      response.end(body);
    } catch (error) {
      options.logger.warn("[lan-remote] request failed", error);
      if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" });
      else response.end();
    }
  });

  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_RPC_FRAME_BYTES });
  const disposers = new Set<() => void>();
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws" || !isAuthenticated(request) || !isSameOrigin(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  webSocketServer.on("connection", (socket) => {
    try {
      const port = options.attach();
      const dispose = bridgeLanRemoteSocket(socket, port);
      disposers.add(dispose);
      socket.once("close", () => disposers.delete(dispose));
    } catch (error) {
      options.logger.warn("[lan-remote] failed to attach Window Host", error);
      socket.close(1013, "Desktop Window Host is not ready");
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });

  const address = server.address();
  const listenPort = typeof address === "object" && address ? address.port : options.port;
  options.logger.info(`[lan-remote] listening on http://${options.host}:${listenPort}`);

  return {
    host: options.host,
    port: listenPort,
    async close() {
      for (const dispose of disposers) dispose();
      disposers.clear();
      for (const client of webSocketServer.clients) client.close(1001, "Desktop is shutting down");
      webSocketServer.close();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
