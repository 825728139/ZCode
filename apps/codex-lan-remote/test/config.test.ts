import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { loadConfig } from "../src/adapters/config.js";

const baseEnvironment = {
  DATABASE_URL: "memory://",
  SESSION_PEPPER: "test-pepper",
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
};

test("shared host requires an owner and absolute host paths", () => {
  assert.throws(
    () => loadConfig({ ...baseEnvironment, RUNTIME_DRIVER: "shared-host" }),
    /SHARED_OWNER_EMAIL is required/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...baseEnvironment,
        RUNTIME_DRIVER: "shared-host",
        SHARED_OWNER_EMAIL: "owner@example.com",
        SHARED_USER_HOME: "relative/home",
        SHARED_WORKSPACE_PATH: "/workspace",
        SHARED_APP_SERVER_SOCKET: "/run/codex.sock",
      }),
    /SHARED_USER_HOME must be an absolute path/,
  );
});

test("shared host exposes explicit owner and socket configuration", () => {
  const config = loadConfig({
    ...baseEnvironment,
    RUNTIME_DRIVER: "shared-host",
    SHARED_OWNER_EMAIL: "Owner@Example.COM",
    SHARED_USER_HOME: "/home/owner",
    SHARED_WORKSPACE_PATH: "/srv/project",
    SHARED_APP_SERVER_SOCKET: "/run/user/1000/codex.sock",
  });
  assert.equal(config.runtimeDriver, "shared-host");
  assert.equal(config.sharedOwnerEmail, "owner@example.com");
  assert.equal(config.sharedAppServerSocket, resolve("/run/user/1000/codex.sock"));
});
