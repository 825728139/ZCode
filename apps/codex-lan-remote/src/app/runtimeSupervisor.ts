import { randomUUID } from "node:crypto";
import type { BrowserCommand, RemoteEvent } from "../contract.js";
import { runtimeKey } from "../domain/identity.js";
import type { CodexRuntimePort, CodexServerMessage, RuntimeFactoryPort } from "./ports.js";

export interface RuntimeDescriptor {
  userId: string;
  workspaceId: string;
  workspacePath: string;
  runtimeCwd: string;
  homePath: string;
  openAiApiKey?: string;
  sharedHost: boolean;
}

interface BrowserClient {
  id: string;
  threadId: string | null;
  send(event: RemoteEvent): void;
}

interface PendingApproval {
  rpcId: string | number;
  method: string;
  threadId: string | null;
}

const CONTROL_LEASE_MS = 45_000;
const RUNTIME_IDLE_MS = 30 * 60_000;

function messageThreadId(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = params as Record<string, unknown>;
  if (typeof value.threadId === "string") return value.threadId;
  for (const key of ["thread", "turn", "item"]) {
    const nested = value[key];
    if (!nested || typeof nested !== "object") continue;
    const record = nested as Record<string, unknown>;
    if (typeof record.threadId === "string") return record.threadId;
    if (key === "thread" && typeof record.id === "string") return record.id;
  }
  return null;
}

class ManagedRuntime {
  readonly #clients = new Map<string, BrowserClient>();
  readonly #processedCommands = new Map<string, Promise<unknown>>();
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  #sequence = 0;
  #controllerId: string | null = null;
  #leaseExpiresAt = 0;
  lastUsedAt = Date.now();

  constructor(
    readonly descriptor: RuntimeDescriptor,
    readonly port: CodexRuntimePort,
  ) {
    port.subscribe((message) => this.#handleCodexMessage(message));
  }

  #nextSequence(): number {
    this.lastUsedAt = Date.now();
    return ++this.#sequence;
  }

  #broadcast(
    factory: (sequence: number, client: BrowserClient) => RemoteEvent,
    accepts: (client: BrowserClient) => boolean = () => true,
  ): void {
    const sequence = this.#nextSequence();
    for (const client of this.#clients.values()) {
      if (accepts(client)) client.send(factory(sequence, client));
    }
  }

  #handleCodexMessage(message: CodexServerMessage): void {
    if (message.method && message.id !== undefined) {
      const requestId = String(message.id);
      const threadId = messageThreadId(message.params);
      this.#pendingApprovals.set(requestId, {
        rpcId: message.id,
        method: message.method,
        threadId,
      });
      this.#broadcast(
        (sequence) => ({
          type: "approval.requested",
          requestId,
          method: message.method!,
          params: message.params,
          sequence,
        }),
        (client) => !threadId || client.threadId === threadId,
      );
      return;
    }
    if (message.method) {
      const threadId = messageThreadId(message.params);
      this.#broadcast(
        (sequence) => ({
          type: "codex.event",
          method: message.method!,
          params: message.params,
          sequence,
        }),
        (client) => !threadId || client.threadId === threadId,
      );
    }
  }

  #isController(connectionId: string): boolean {
    if (this.#leaseExpiresAt <= Date.now()) {
      this.#controllerId = null;
      this.#leaseExpiresAt = 0;
    }
    return this.#controllerId === connectionId;
  }

  #broadcastControl(): void {
    this.#broadcast((sequence, client) => ({
      type: "control.changed",
      writable: this.#isController(client.id),
      leaseExpiresAt: this.#leaseExpiresAt,
      sequence,
    }));
  }

  attach(send: (event: RemoteEvent) => void): { connectionId: string; detach: () => void } {
    const connectionId = randomUUID();
    this.#clients.set(connectionId, { id: connectionId, threadId: null, send });
    send({ type: "connection.ready", connectionId, sequence: this.#nextSequence() });
    this.#broadcastControl();
    return {
      connectionId,
      detach: () => {
        this.#clients.delete(connectionId);
        if (this.#controllerId === connectionId) {
          this.#controllerId = null;
          this.#leaseExpiresAt = 0;
          this.#broadcastControl();
        }
        this.lastUsedAt = Date.now();
      },
    };
  }

  async listThreads(): Promise<unknown> {
    this.lastUsedAt = Date.now();
    return this.port.request("thread/list", {
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "appServer"],
      ...(this.descriptor.sharedHost ? {} : { cwd: this.descriptor.runtimeCwd }),
    });
  }

  async readThread(threadId: string): Promise<unknown> {
    this.lastUsedAt = Date.now();
    return this.port.request("thread/read", { threadId, includeTurns: true });
  }

  #requireControl(connectionId: string): void {
    if (!this.#isController(connectionId)) throw new Error("当前连接是只读状态，请先接管控制权");
    this.#leaseExpiresAt = Date.now() + CONTROL_LEASE_MS;
  }

  #idempotent(clientCommandId: string, action: () => Promise<unknown>): Promise<unknown> {
    const existing = this.#processedCommands.get(clientCommandId);
    if (existing) return existing;
    const result = action();
    this.#processedCommands.set(clientCommandId, result);
    if (this.#processedCommands.size > 500) {
      const oldest = this.#processedCommands.keys().next().value as string | undefined;
      if (oldest) this.#processedCommands.delete(oldest);
    }
    return result;
  }

  async execute(connectionId: string, command: BrowserCommand): Promise<void> {
    const client = this.#clients.get(connectionId);
    if (!client) throw new Error("Browser connection is closed");
    if (command.type === "control.acquire") {
      const occupied = this.#controllerId && this.#leaseExpiresAt > Date.now();
      if (occupied && !command.takeover && this.#controllerId !== connectionId) {
        throw new Error("另一个浏览器正在控制此工作区");
      }
      this.#controllerId = connectionId;
      this.#leaseExpiresAt = Date.now() + CONTROL_LEASE_MS;
      this.#broadcastControl();
      return;
    }
    if (command.type === "thread.subscribe") {
      client.threadId = command.threadId;
      await this.port.request("thread/resume", { threadId: command.threadId });
      const thread = await this.readThread(command.threadId);
      client.send({ type: "thread.snapshot", thread, sequence: this.#nextSequence() });
      return;
    }

    this.#requireControl(connectionId);
    const result = await this.#idempotent(command.clientCommandId, async () => {
      switch (command.type) {
        case "thread.start":
          return this.port.request("thread/start", {
            cwd: this.descriptor.runtimeCwd,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            serviceName: "zcode-codex-lan-remote",
          });
        case "turn.start":
          return this.port.request("turn/start", {
            threadId: command.threadId,
            input: [{ type: "text", text: command.text }],
            ...(this.descriptor.sharedHost
              ? {}
              : {
                  cwd: this.descriptor.runtimeCwd,
                  approvalPolicy: "on-request",
                  sandboxPolicy: {
                    type: "workspaceWrite",
                    writableRoots: [this.descriptor.runtimeCwd],
                    networkAccess: false,
                  },
                }),
          });
        case "turn.steer":
          return this.port.request("turn/steer", {
            threadId: command.threadId,
            expectedTurnId: command.turnId,
            input: [{ type: "text", text: command.text }],
          });
        case "turn.interrupt":
          return this.port.request("turn/interrupt", {
            threadId: command.threadId,
            turnId: command.turnId,
          });
        case "approval.resolve": {
          const pending = this.#pendingApprovals.get(command.requestId);
          if (!pending) throw new Error("审批请求已失效");
          if (pending.threadId && pending.threadId !== client.threadId) {
            throw new Error("审批请求不属于当前会话");
          }
          this.#pendingApprovals.delete(command.requestId);
          if (
            pending.method === "item/commandExecution/requestApproval" ||
            pending.method === "item/fileChange/requestApproval"
          ) {
            this.port.respond(pending.rpcId, { decision: command.decision });
          } else if (pending.method === "mcpServer/elicitation/request") {
            this.port.respond(pending.rpcId, {
              action: command.decision.startsWith("accept") ? "accept" : "decline",
              content: null,
            });
          } else {
            this.port.respond(pending.rpcId, { decision: "decline" });
          }
          return {};
        }
      }
    });
    client.send({
      type: "command.result",
      clientCommandId: command.clientCommandId,
      result,
      sequence: this.#nextSequence(),
    });
    this.#broadcastControl();
  }

  async close(): Promise<void> {
    await this.port.close();
  }

  get hasClients(): boolean {
    return this.#clients.size > 0;
  }
}

export class RuntimeSupervisor {
  readonly #runtimes = new Map<string, Promise<ManagedRuntime>>();
  readonly #sweepTimer: NodeJS.Timeout;

  constructor(private readonly factory: RuntimeFactoryPort) {
    this.#sweepTimer = setInterval(() => void this.#sweepIdle(), 60_000);
    this.#sweepTimer.unref();
  }

  async #get(descriptor: RuntimeDescriptor): Promise<ManagedRuntime> {
    const key = descriptor.sharedHost
      ? `shared-host:${descriptor.userId}`
      : runtimeKey(descriptor.userId, descriptor.workspaceId);
    const existing = this.#runtimes.get(key);
    if (existing) return existing;
    const creating = this.factory
      .create({
        runtimeId: `codex-remote-${descriptor.userId.slice(0, 8)}-${descriptor.workspaceId.slice(0, 8)}`,
        workspacePath: descriptor.workspacePath,
        homePath: descriptor.homePath,
        openAiApiKey: descriptor.openAiApiKey,
      })
      .then((port) => new ManagedRuntime(descriptor, port))
      .catch((error: unknown) => {
        this.#runtimes.delete(key);
        throw error;
      });
    this.#runtimes.set(key, creating);
    return creating;
  }

  async attach(
    descriptor: RuntimeDescriptor,
    send: (event: RemoteEvent) => void,
  ): Promise<{
    connectionId: string;
    detach: () => void;
    execute: (command: BrowserCommand) => Promise<void>;
  }> {
    const runtime = await this.#get(descriptor);
    const attachment = runtime.attach(send);
    return {
      ...attachment,
      execute: (command) => runtime.execute(attachment.connectionId, command),
    };
  }

  async listThreads(descriptor: RuntimeDescriptor): Promise<unknown> {
    return (await this.#get(descriptor)).listThreads();
  }

  async readThread(descriptor: RuntimeDescriptor, threadId: string): Promise<unknown> {
    return (await this.#get(descriptor)).readThread(threadId);
  }

  async #sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [key, runtimePromise] of this.#runtimes) {
      const runtime = await runtimePromise.catch(() => null);
      if (runtime && !runtime.hasClients && now - runtime.lastUsedAt >= RUNTIME_IDLE_MS) {
        this.#runtimes.delete(key);
        await runtime.close();
      }
    }
  }

  async restartUser(userId: string): Promise<void> {
    for (const [key, runtimePromise] of this.#runtimes) {
      if (!key.startsWith(`${userId}:`) && key !== `shared-host:${userId}`) continue;
      this.#runtimes.delete(key);
      const runtime = await runtimePromise.catch(() => null);
      if (runtime) await runtime.close();
    }
  }

  async close(): Promise<void> {
    clearInterval(this.#sweepTimer);
    const runtimes = [...this.#runtimes.values()];
    this.#runtimes.clear();
    await Promise.all(runtimes.map(async (runtime) => (await runtime).close()));
  }
}
