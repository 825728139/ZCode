import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import {
  startDesktopLanRemoteGateway,
  type DesktopLanRemoteMessagePort,
} from "../src/main/desktopLanRemoteGateway.js";

class FakeMessagePort extends EventEmitter implements DesktopLanRemoteMessagePort {
  readonly posted: Uint8Array[] = [];

  postMessage(data: Uint8Array): void {
    this.posted.push(data);
    this.emit("posted");
  }

  start(): void {}

  close(): void {
    this.emit("close");
  }
}

const logger = {
  info() {},
  warn() {},
  error() {},
};

function wrapTestWebSocket(socket: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  socket.on("message", (data) => onData.fire(VSBuffer.wrap(new Uint8Array(Buffer.from(data)))));
  socket.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer) {
      socket.send(buffer.buffer);
    },
    end() {
      socket.close();
    },
    drain: () => Promise.resolve(),
    dispose() {
      socket.close();
    },
  };
}

test("LAN gateway authenticates a fixed URL and bridges the existing Host attachment", async () => {
  const staticRoot = await mkdtemp(join(tmpdir(), "zcode-lan-remote-"));
  await writeFile(
    join(staticRoot, "index.html"),
    "<!doctype html><title>remote</title><script>globalThis.booted = true;</script>",
  );
  const port = new FakeMessagePort();
  const gateway = await startDesktopLanRemoteGateway({
    host: "127.0.0.1",
    port: 0,
    password: "test-password",
    staticRoot,
    serverId: "desktop-test",
    resolveTarget: () => ({ label: "Desktop", workspaces: ["D:\\workspace"] }),
    attach: () => port,
    logger,
  });
  const origin = `http://127.0.0.1:${gateway.port}`;

  try {
    const anonymous = await fetch(`${origin}/`);
    assert.equal(anonymous.status, 200);
    assert.match(await anonymous.text(), /访问密码/u);

    const rejected = await fetch(`${origin}/api/lan-auth`, {
      method: "POST",
      body: new URLSearchParams({ password: "wrong" }),
      redirect: "manual",
    });
    assert.equal(rejected.status, 401);

    const login = await fetch(`${origin}/api/lan-auth`, {
      method: "POST",
      body: new URLSearchParams({ password: "test-password" }),
      redirect: "manual",
    });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);

    const infoResponse = await fetch(`${origin}/api/server-info`, {
      headers: { Cookie: cookie },
    });
    assert.equal(infoResponse.status, 200);
    const info = (await infoResponse.json()) as {
      workspaces: Array<{ path: string }>;
      capabilities: { desktopLanAttachment?: boolean };
    };
    assert.equal(info.workspaces[0]?.path, "D:\\workspace");
    assert.equal(info.capabilities.desktopLanAttachment, true);

    const appResponse = await fetch(`${origin}/`, { headers: { Cookie: cookie } });
    const appHtml = await appResponse.text();
    const nonce = appHtml.match(/<script nonce="([^"]+)">/u)?.[1];
    assert.ok(nonce);
    assert.match(
      appResponse.headers.get("content-security-policy") ?? "",
      new RegExp(`script-src[^;]+'nonce-${nonce}'`, "u"),
    );
    assert.match(appResponse.headers.get("content-security-policy") ?? "", /connect-src[^;]+https:/u);
    assert.match(appResponse.headers.get("content-security-policy") ?? "", /img-src[^;]+https:/u);
    assert.doesNotMatch(
      appResponse.headers.get("content-security-policy") ?? "",
      /script-src[^;]+'unsafe-inline'/u,
    );

    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, {
      headers: { Cookie: cookie, Origin: origin },
    });
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.once("open", resolveOpen);
      socket.once("error", rejectOpen);
    });
    const protocol = new SocketProtocol(wrapTestWebSocket(socket));
    protocol.send(VSBuffer.wrap(Uint8Array.from([1, 2, 3])));
    await new Promise<void>((resolvePosted) => port.once("posted", resolvePosted));
    assert.deepEqual([...port.posted[0]!], [1, 2, 3]);

    const received = new Promise<Buffer>((resolveMessage) => {
      protocol.onMessage((data) => resolveMessage(Buffer.from(data.buffer)));
    });
    port.emit("message", { data: Uint8Array.from([4, 5, 6]) });
    assert.deepEqual([...(await received)], [4, 5, 6]);
    protocol.dispose();
    socket.close();
  } finally {
    await gateway.close();
    await rm(staticRoot, { recursive: true, force: true });
  }
});
