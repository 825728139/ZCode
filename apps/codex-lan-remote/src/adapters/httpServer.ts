import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer as createNodeServer, type IncomingMessage } from "node:http";
import { serveStatic } from "@hono/node-server/serve-static";
import { getRequestListener } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { WebSocketServer, WebSocket } from "ws";
import type { IdentityStore, StoredUser } from "../app/ports.js";
import { RuntimeSupervisor, type RuntimeDescriptor } from "../app/runtimeSupervisor.js";
import type { CurrentUser, RemoteEvent } from "../contract.js";
import { normalizeEmail, validateWorkspaceName } from "../domain/identity.js";
import type { RemoteConfig } from "./config.js";
import {
  createSessionToken,
  decryptCredential,
  digestSessionToken,
  encryptCredential,
  hashPassword,
  verifyPassword,
} from "./security.js";
import {
  browserCommandSchema,
  createUserSchema,
  loginSchema,
  openAiKeySchema,
  workspaceSchema,
} from "./httpSchemas.js";
import { log } from "./logger.js";

const SESSION_COOKIE = "codex_remote_session";
const MAX_WS_MESSAGE_BYTES = 128 * 1024;

interface Variables {
  user: StoredUser;
  sessionDigest: string;
}

interface RateEntry {
  count: number;
  resetsAt: number;
}

function publicUser(user: StoredUser, config: RemoteConfig): CurrentUser {
  const usesSharedCodexAuth =
    config.runtimeDriver === "shared-host" &&
    normalizeEmail(user.email) === config.sharedOwnerEmail;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    hasOpenAiKey: user.hasOpenAiKey,
    usesSharedCodexAuth,
  };
}

function parseCookieHeader(header: string | undefined, name: string): string | null {
  for (const item of header?.split(";") ?? []) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.host === host;
  } catch {
    return false;
  }
}

function securityHeaders(c: Context): void {
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'",
  );
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
}

async function readJson<T>(context: Context, schema: { parse(value: unknown): T }): Promise<T> {
  const contentLength = Number(context.req.header("content-length") ?? 0);
  if (contentLength > MAX_WS_MESSAGE_BYTES) throw new Error("Request body is too large");
  return schema.parse(await context.req.json());
}

export async function createRemoteServer(
  config: RemoteConfig,
  store: IdentityStore,
  supervisor: RuntimeSupervisor,
): Promise<{ listen(): Promise<void>; close(): Promise<void> }> {
  const app = new Hono<{ Variables: Variables }>();
  const rates = new Map<string, RateEntry>();

  app.use("*", async (context, next) => {
    securityHeaders(context);
    await next();
  });

  const rateLimit = (limit: number, windowMs: number) => async (context: Context, next: Next) => {
    const key = `${context.req.header("x-forwarded-for") ?? "local"}:${context.req.path}`;
    const now = Date.now();
    const current = rates.get(key);
    const entry =
      !current || current.resetsAt <= now ? { count: 0, resetsAt: now + windowMs } : current;
    entry.count += 1;
    rates.set(key, entry);
    if (entry.count > limit) return context.json({ error: "请求过于频繁" }, 429);
    await next();
  };

  const requireUser = async (context: Context<{ Variables: Variables }>, next: Next) => {
    const token = getCookie(context, SESSION_COOKIE);
    if (!token) return context.json({ error: "Unauthorized" }, 401);
    const digest = digestSessionToken(token, config.sessionPepper);
    const user = await store.findUserBySession(digest);
    if (!user) return context.json({ error: "Unauthorized" }, 401);
    context.set("user", user);
    context.set("sessionDigest", digest);
    await next();
  };

  const resolveRuntime = async (
    user: StoredUser,
    workspaceId: string,
  ): Promise<RuntimeDescriptor | null> => {
    const workspace = await store.findWorkspace(user.id, workspaceId);
    if (!workspace) return null;
    if (config.runtimeDriver === "shared-host") {
      if (normalizeEmail(user.email) !== config.sharedOwnerEmail) return null;
      return {
        userId: user.id,
        workspaceId: workspace.id,
        workspacePath: config.sharedWorkspacePath!,
        homePath: config.sharedUserHome!,
        runtimeCwd: config.sharedWorkspacePath!,
        sharedHost: true,
      };
    }
    if (!user.encryptedOpenAiKey) throw new Error("请先配置 OpenAI API Key");
    const workspacePath = resolve(config.workspaceRoot, user.id, workspace.id);
    const homePath = resolve(config.runtimeHomeRoot, user.id, workspace.id);
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(homePath, { recursive: true }),
    ]);
    return {
      userId: user.id,
      workspaceId: workspace.id,
      workspacePath,
      homePath,
      runtimeCwd: config.runtimeDriver === "podman" ? "/workspace" : workspacePath,
      openAiApiKey: decryptCredential(user.encryptedOpenAiKey, config.credentialEncryptionKey),
      sharedHost: false,
    };
  };

  app.get("/api/config", (context) =>
    context.json({ allowSignup: config.allowSignup, runtimeDriver: config.runtimeDriver }),
  );
  app.get("/api/health", (context) => context.json({ ok: true }));

  app.post("/api/auth/register", rateLimit(5, 60_000), async (context) => {
    if (!config.allowSignup) return context.json({ error: "Registration is disabled" }, 403);
    const input = await readJson(context, createUserSchema);
    const user = await store.createUser({
      email: normalizeEmail(input.email),
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: "member",
    });
    return context.json({ user: publicUser(user, config) }, 201);
  });

  app.post("/api/auth/login", rateLimit(10, 60_000), async (context) => {
    const input = await readJson(context, loginSchema);
    const user = await store.findUserByEmail(normalizeEmail(input.email));
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      return context.json({ error: "邮箱或密码不正确" }, 401);
    }
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60_000);
    await store.createSession(user.id, digestSessionToken(token, config.sessionPepper), expiresAt);
    setCookie(context, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: config.secureCookies,
      path: "/",
      expires: expiresAt,
    });
    return context.json({ user: publicUser(user, config) });
  });

  app.use("/api/me", requireUser);
  app.use("/api/me/*", requireUser);
  app.use("/api/workspaces", requireUser);
  app.use("/api/workspaces/*", requireUser);
  app.use("/api/admin/*", requireUser);
  app.post("/api/auth/logout", requireUser, async (context) => {
    await store.deleteSession(context.get("sessionDigest"));
    deleteCookie(context, SESSION_COOKIE, { path: "/" });
    return context.json({ ok: true });
  });

  app.get("/api/me", (context) => context.json({ user: publicUser(context.get("user"), config) }));
  app.put("/api/me/openai-key", rateLimit(5, 60_000), async (context) => {
    if (config.runtimeDriver === "shared-host") {
      return context.json({ error: "共享主机模式使用 Codex 现有登录状态" }, 409);
    }
    const input = await readJson(context, openAiKeySchema);
    const user = context.get("user");
    await store.setOpenAiKey(
      user.id,
      encryptCredential(input.apiKey, config.credentialEncryptionKey),
    );
    await supervisor.restartUser(user.id);
    return context.json({ ok: true });
  });

  app.get("/api/workspaces", async (context) =>
    context.json({ workspaces: await store.listWorkspaces(context.get("user").id) }),
  );
  app.post("/api/workspaces", async (context) => {
    const input = await readJson(context, workspaceSchema);
    const workspace = await store.createWorkspace(
      context.get("user").id,
      validateWorkspaceName(input.name),
    );
    return context.json({ workspace }, 201);
  });
  app.get("/api/workspaces/:id/threads", async (context) => {
    const descriptor = await resolveRuntime(context.get("user"), context.req.param("id"));
    if (!descriptor) return context.json({ error: "Not found" }, 404);
    return context.json(await supervisor.listThreads(descriptor));
  });
  app.get("/api/workspaces/:id/threads/:threadId", async (context) => {
    const descriptor = await resolveRuntime(context.get("user"), context.req.param("id"));
    if (!descriptor) return context.json({ error: "Not found" }, 404);
    return context.json(await supervisor.readThread(descriptor, context.req.param("threadId")));
  });
  app.get("/api/workspaces/:id/runtime-connection", async (context) => {
    if (config.runtimeDriver !== "shared-host") return context.json({ error: "Not found" }, 404);
    const descriptor = await resolveRuntime(context.get("user"), context.req.param("id"));
    if (!descriptor) return context.json({ error: "Not found" }, 404);
    return context.json({
      remoteAddress: `unix://${config.sharedAppServerSocket}`,
      cliArgs: [
        config.codexCommand,
        "--remote",
        `unix://${config.sharedAppServerSocket}`,
        "-C",
        descriptor.workspacePath,
      ],
    });
  });

  app.post("/api/admin/users", async (context) => {
    const current = context.get("user");
    if (current.role !== "admin") return context.json({ error: "Forbidden" }, 403);
    const input = await readJson(context, createUserSchema);
    const user = await store.createUser({
      email: normalizeEmail(input.email),
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      role: "member",
    });
    return context.json({ user: publicUser(user, config) }, 201);
  });

  app.use("/*", serveStatic({ root: config.webRoot, rewriteRequestPath: (path) => path }));
  app.get("*", serveStatic({ root: config.webRoot, path: "index.html" }));

  app.onError((error, context) => {
    log.warn("request_failed", { path: context.req.path, error: error.name });
    return context.json({ error: error.message || "Request failed" }, 400);
  });

  const nodeServer = createNodeServer(getRequestListener(app.fetch));
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
  const upgradeDescriptors = new WeakMap<IncomingMessage, RuntimeDescriptor>();

  nodeServer.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const rateKey = `${request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "local"}:ws`;
      const now = Date.now();
      const current = rates.get(rateKey);
      const entry =
        !current || current.resetsAt <= now ? { count: 0, resetsAt: now + 60_000 } : current;
      entry.count += 1;
      rates.set(rateKey, entry);
      if (entry.count > 30) throw new Error("Rate limited");
      const token = parseCookieHeader(request.headers.cookie, SESSION_COOKIE);
      if (url.pathname !== "/ws" || !token || !isSameOrigin(request))
        throw new Error("Unauthorized");
      const user = await store.findUserBySession(digestSessionToken(token, config.sessionPepper));
      if (!user) throw new Error("Unauthorized");
      const descriptor = await resolveRuntime(user, url.searchParams.get("workspaceId") ?? "");
      if (!descriptor) throw new Error("Not found");
      upgradeDescriptors.set(request, descriptor);
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    })().catch(() => {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  });

  webSocketServer.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const descriptor = upgradeDescriptors.get(request);
    upgradeDescriptors.delete(request);
    if (!descriptor) {
      socket.close(1011, "Missing runtime descriptor");
      return;
    }
    let detach = () => {};
    void supervisor
      .attach(descriptor, (event: RemoteEvent) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      })
      .then((attachment) => {
        detach = attachment.detach;
        socket.on("message", (data) => {
          void (async () => {
            const command = browserCommandSchema.parse(JSON.parse(data.toString()));
            await attachment.execute(command);
          })().catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Command failed";
            socket.send(JSON.stringify({ type: "command.error", message, sequence: 0 }));
          });
        });
      })
      .catch(() => socket.close(1013, "Runtime unavailable"));
    socket.once("close", () => detach());
  });

  return {
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        nodeServer.once("error", rejectListen);
        nodeServer.listen(config.port, config.host, () => {
          nodeServer.off("error", rejectListen);
          resolveListen();
        });
      }),
    async close() {
      for (const client of webSocketServer.clients) client.close(1001, "Server shutting down");
      await supervisor.close();
      await store.close();
      await new Promise<void>((resolveClose) => nodeServer.close(() => resolveClose()));
    },
  };
}
