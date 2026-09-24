import { PostgresIdentityStore } from "./postgresStore.js";
import { loadConfig } from "./config.js";
import { CodexProcessRuntimeFactory } from "./codexProcess.js";
import { RuntimeSupervisor } from "../app/runtimeSupervisor.js";
import { createRemoteServer } from "./httpServer.js";
import { hashPassword } from "./security.js";
import { normalizeEmail } from "../domain/identity.js";
import { log } from "./logger.js";
import { MemoryIdentityStore } from "./memoryStore.js";
import type { IdentityStore } from "../app/ports.js";

const config = loadConfig();
const store: IdentityStore =
  config.databaseUrl === "memory://"
    ? new MemoryIdentityStore()
    : new PostgresIdentityStore(config.databaseUrl);
await store.migrate();

if ((await store.countUsers()) === 0) {
  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
    throw new Error(
      "No users exist; set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD for first start",
    );
  }
  await store.createUser({
    email: normalizeEmail(config.bootstrapAdminEmail),
    displayName: "Administrator",
    passwordHash: await hashPassword(config.bootstrapAdminPassword),
    role: "admin",
  });
  log.info("bootstrap_admin_created");
}

const supervisor = new RuntimeSupervisor(new CodexProcessRuntimeFactory(config));
const server = await createRemoteServer(config, store, supervisor);
await server.listen();
log.info("server_listening", {
  host: config.host,
  port: config.port,
  runtimeDriver: config.runtimeDriver,
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("server_shutdown", { signal });
  await server.close();
  process.exitCode = 0;
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
