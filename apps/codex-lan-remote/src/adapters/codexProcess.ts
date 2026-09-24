import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import type {
  CodexRuntimePort,
  CodexServerMessage,
  RuntimeFactoryInput,
  RuntimeFactoryPort,
} from "../app/ports.js";
import type { RemoteConfig } from "./config.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

class CodexProcessRuntime implements CodexRuntimePort {
  readonly #send: (message: string) => void;
  readonly #closeTransport: () => void;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Set<(message: CodexServerMessage) => void>();
  #nextId = 1;
  #closed = false;

  private constructor(send: (message: string) => void, closeTransport: () => void) {
    this.#send = send;
    this.#closeTransport = closeTransport;
  }

  static async start(processHandle: ChildProcessWithoutNullStreams): Promise<CodexProcessRuntime> {
    const runtime = new CodexProcessRuntime(
      (message) => {
        if (!processHandle.stdin.writable) throw new Error("Codex runtime input is closed");
        processHandle.stdin.write(`${message}\n`);
      },
      () => processHandle.kill("SIGTERM"),
    );
    processHandle.stderr.resume();
    const lines = createInterface({ input: processHandle.stdout });
    lines.on("line", (line) => runtime.#handleLine(line));
    // spawn 失败会先触发 error 而不是 exit；必须收敛到目标 runtime，不能让 Gateway 崩溃。
    processHandle.once("error", (error) => {
      runtime.#fail(new Error(`Codex app-server failed to start: ${error.message}`, { cause: error }));
    });
    // 子进程提前退出时 stdin 会异步触发 EPIPE；必须收敛到 runtime，不能带崩 Gateway。
    processHandle.stdin.on("error", (error) => {
      runtime.#fail(new Error(`Codex app-server input failed: ${error.message}`, { cause: error }));
    });
    processHandle.once("exit", (code, signal) => {
      runtime.#fail(
        new Error(`Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      );
    });
    await runtime.#initialize();
    return runtime;
  }

  static async connectUnixSocket(socketPath: string): Promise<CodexProcessRuntime> {
    const socket = new WebSocket(`ws+unix://${socketPath}:/rpc`, { maxPayload: 128 << 20 });
    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => reject(error);
      socket.once("error", handleError);
      socket.once("open", () => {
        socket.off("error", handleError);
        resolve();
      });
    });
    const runtime = new CodexProcessRuntime(
      (message) => socket.send(message),
      () => socket.close(),
    );
    socket.on("message", (data, isBinary) => {
      if (!isBinary) runtime.#handleLine(data.toString());
    });
    socket.on("error", (error) => {
      runtime.#fail(new Error(`Codex remote socket failed: ${error.message}`, { cause: error }));
    });
    socket.on("close", (code, reason) => {
      runtime.#fail(
        new Error(`Codex remote socket closed (code=${code}, reason=${reason.toString()})`),
      );
    });
    await runtime.#initialize();
    return runtime;
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "zcode_codex_lan_remote",
        title: "ZCode Codex LAN Remote",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    });
    this.#write({ method: "initialized" });
  }

  #handleLine(line: string): void {
    let message: CodexServerMessage;
    try {
      message = JSON.parse(line) as CodexServerMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const numericId = typeof message.id === "number" ? message.id : Number(message.id);
      const pending = this.#pending.get(numericId);
      if (pending) {
        this.#pending.delete(numericId);
        clearTimeout(pending.timeout);
        if (message.error)
          pending.reject(new Error(message.error.message || "Codex request failed"));
        else pending.resolve(message.result);
        return;
      }
    }
    for (const listener of this.#listeners) listener(message);
  }

  #write(message: unknown): void {
    if (this.#closed) throw new Error("Codex runtime is closed");
    this.#send(JSON.stringify(message));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 60_000);
      this.#pending.set(id, { resolve, reject, timeout });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: string | number, result: unknown): void {
    this.#write({ id, result });
  }

  subscribe(listener: (message: CodexServerMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeTransport();
  }
}

export class CodexProcessRuntimeFactory implements RuntimeFactoryPort {
  constructor(private readonly config: RemoteConfig) {}

  async create(input: RuntimeFactoryInput): Promise<CodexRuntimePort> {
    if (this.config.runtimeDriver === "shared-host") {
      return CodexProcessRuntime.connectUnixSocket(this.config.sharedAppServerSocket!);
    }
    const commonArgs = ["app-server", "--stdio", "-c", "shell_environment_policy.inherit=none"];
    const localEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: input.homePath,
      USERPROFILE: input.homePath,
    };
    if (input.openAiApiKey) localEnvironment.OPENAI_API_KEY = input.openAiApiKey;
    else delete localEnvironment.OPENAI_API_KEY;
    const processHandle =
      this.config.runtimeDriver === "podman"
        ? spawn(
            "podman",
            [
              "run",
              "--rm",
              "--interactive",
              "--name",
              input.runtimeId,
              "--cpus",
              "2",
              "--memory",
              "4g",
              "--pids-limit",
              "512",
              "--network",
              "slirp4netns",
              "--env",
              "OPENAI_API_KEY",
              "--env",
              "HOME=/runtime-home",
              "--volume",
              `${input.workspacePath}:/workspace:Z`,
              "--volume",
              `${input.homePath}:/runtime-home:Z`,
              "--workdir",
              "/workspace",
              this.config.runtimeImage,
              "codex",
              ...commonArgs,
            ],
            {
              env: { ...process.env, OPENAI_API_KEY: input.openAiApiKey },
              stdio: ["pipe", "pipe", "pipe"],
            },
          )
        : spawn(this.config.codexCommand, commonArgs, {
            cwd: input.workspacePath,
            env: localEnvironment,
            shell: process.platform === "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });
    return CodexProcessRuntime.start(processHandle);
  }
}
