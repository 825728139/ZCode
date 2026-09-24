import { isAbsolute, resolve } from "node:path";

export type RuntimeDriver = "local" | "podman" | "shared-host";

export interface RemoteConfig {
  host: string;
  port: number;
  databaseUrl: string;
  sessionPepper: string;
  credentialEncryptionKey: Buffer;
  sessionTtlHours: number;
  allowSignup: boolean;
  secureCookies: boolean;
  workspaceRoot: string;
  runtimeHomeRoot: string;
  runtimeDriver: RuntimeDriver;
  runtimeImage: string;
  codexCommand: string;
  webRoot: string;
  sharedOwnerEmail?: string;
  sharedUserHome?: string;
  sharedWorkspacePath?: string;
  sharedAppServerSocket?: string;
  bootstrapAdminEmail?: string;
  bootstrapAdminPassword?: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "3040");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CODEX_REMOTE_PORT must be between 1 and 65535");
  }
  return port;
}

function parseRuntimeDriver(value: string | undefined, production: boolean): RuntimeDriver {
  const configured = value?.trim();
  if (configured === "local" || configured === "podman" || configured === "shared-host") {
    return configured;
  }
  if (configured) throw new Error("RUNTIME_DRIVER must be local, podman, or shared-host");
  return production ? "podman" : "local";
}

function requiredAbsolute(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const encryptionKey = Buffer.from(required(environment, "CREDENTIAL_ENCRYPTION_KEY"), "base64");
  if (encryptionKey.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  const production = environment.NODE_ENV === "production";
  const runtimeDriver = parseRuntimeDriver(environment.RUNTIME_DRIVER, production);
  const databaseUrl = required(environment, "DATABASE_URL");
  if (production && databaseUrl === "memory://") {
    throw new Error("DATABASE_URL=memory:// is only available in development");
  }
  const sessionTtlHours = Number(environment.SESSION_TTL_HOURS ?? "168");
  if (!Number.isFinite(sessionTtlHours) || sessionTtlHours <= 0) {
    throw new Error("SESSION_TTL_HOURS must be a positive number");
  }
  const sharedConfig =
    runtimeDriver === "shared-host"
      ? {
          sharedOwnerEmail: required(environment, "SHARED_OWNER_EMAIL").toLowerCase(),
          sharedUserHome: requiredAbsolute(environment, "SHARED_USER_HOME"),
          sharedWorkspacePath: requiredAbsolute(environment, "SHARED_WORKSPACE_PATH"),
          sharedAppServerSocket: requiredAbsolute(environment, "SHARED_APP_SERVER_SOCKET"),
        }
      : {};
  return {
    host: environment.CODEX_REMOTE_HOST?.trim() || "0.0.0.0",
    port: parsePort(environment.CODEX_REMOTE_PORT),
    databaseUrl,
    sessionPepper: required(environment, "SESSION_PEPPER"),
    credentialEncryptionKey: encryptionKey,
    sessionTtlHours,
    allowSignup: environment.ALLOW_SIGNUP === "1",
    secureCookies:
      environment.SECURE_COOKIES === "1" || (production && environment.SECURE_COOKIES !== "0"),
    workspaceRoot: resolve(environment.WORKSPACE_ROOT?.trim() || "./data/workspaces"),
    runtimeHomeRoot: resolve(environment.RUNTIME_HOME_ROOT?.trim() || "./data/runtime-homes"),
    runtimeDriver,
    runtimeImage: environment.RUNTIME_IMAGE?.trim() || "zcode/codex-runtime:0.138.0",
    codexCommand: environment.CODEX_COMMAND?.trim() || "codex",
    webRoot: resolve(environment.WEB_ROOT?.trim() || "./dist/web"),
    ...sharedConfig,
    ...(environment.BOOTSTRAP_ADMIN_EMAIL?.trim()
      ? { bootstrapAdminEmail: environment.BOOTSTRAP_ADMIN_EMAIL.trim() }
      : {}),
    ...(environment.BOOTSTRAP_ADMIN_PASSWORD
      ? { bootstrapAdminPassword: environment.BOOTSTRAP_ADMIN_PASSWORD }
      : {}),
  };
}
