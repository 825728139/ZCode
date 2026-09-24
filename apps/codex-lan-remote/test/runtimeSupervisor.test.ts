import assert from "node:assert/strict";
import test from "node:test";
import type { CodexRuntimePort, CodexServerMessage, RuntimeFactoryPort } from "../src/app/ports.js";
import { RuntimeSupervisor, type RuntimeDescriptor } from "../src/app/runtimeSupervisor.js";
import type { RemoteEvent } from "../src/contract.js";

class FakeRuntime implements CodexRuntimePort {
  readonly requests: { method: string; params: unknown }[] = [];
  readonly responses: { id: string | number; result: unknown }[] = [];
  listeners = new Set<(message: CodexServerMessage) => void>();
  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    return method === "thread/start" ? { thread: { id: "thread-1" } } : { data: [] };
  }
  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
  }
  subscribe(listener: (message: CodexServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {}
}

const descriptor: RuntimeDescriptor = {
  userId: "user-1",
  workspaceId: "workspace-1",
  workspacePath: "/host/workspace",
  runtimeCwd: "/workspace",
  homePath: "/host/home",
  openAiApiKey: "secret",
  sharedHost: false,
};

test("one runtime is shared while only the lease holder may write", async () => {
  const runtime = new FakeRuntime();
  let creates = 0;
  const factory: RuntimeFactoryPort = {
    create: async () => {
      creates += 1;
      return runtime;
    },
  };
  const supervisor = new RuntimeSupervisor(factory);
  const eventsA: RemoteEvent[] = [];
  const eventsB: RemoteEvent[] = [];
  const [a, b] = await Promise.all([
    supervisor.attach(descriptor, (event) => eventsA.push(event)),
    supervisor.attach(descriptor, (event) => eventsB.push(event)),
  ]);
  assert.equal(creates, 1);
  await a.execute({ type: "control.acquire", takeover: false });
  await assert.rejects(
    b.execute({ type: "thread.start", clientCommandId: "11111111-1111-4111-8111-111111111111" }),
    /只读/,
  );
  await b.execute({ type: "control.acquire", takeover: true });
  await b.execute({
    type: "thread.start",
    clientCommandId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(runtime.requests.at(-1)?.method, "thread/start");
  assert.equal(
    eventsA.some((event) => event.type === "control.changed" && !event.writable),
    true,
  );
  a.detach();
  b.detach();
  await supervisor.close();
});

test("approval responses are scoped to an active controller", async () => {
  const runtime = new FakeRuntime();
  const supervisor = new RuntimeSupervisor({ create: async () => runtime });
  const attachment = await supervisor.attach(descriptor, () => {});
  await attachment.execute({ type: "control.acquire", takeover: false });
  for (const listener of runtime.listeners)
    listener({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { command: "pwd" },
    });
  await attachment.execute({
    type: "approval.resolve",
    clientCommandId: "33333333-3333-4333-8333-333333333333",
    requestId: "9",
    decision: "accept",
  });
  assert.deepEqual(runtime.responses, [{ id: 9, result: { decision: "accept" } }]);
  await assert.rejects(
    attachment.execute({
      type: "approval.resolve",
      clientCommandId: "44444444-4444-4444-8444-444444444444",
      requestId: "9",
      decision: "accept",
    }),
    /失效/,
  );
  attachment.detach();
  await supervisor.close();
});

test("shared host reuses one remote runtime and resumes a thread before reading it", async () => {
  const runtime = new FakeRuntime();
  let creates = 0;
  const supervisor = new RuntimeSupervisor({
    create: async () => {
      creates += 1;
      return runtime;
    },
  });
  const shared = { ...descriptor, sharedHost: true, openAiApiKey: undefined };

  await supervisor.listThreads(shared);
  await supervisor.listThreads({ ...shared, workspaceId: "workspace-2" });
  assert.equal(creates, 1);
  assert.deepEqual(runtime.requests[0], {
    method: "thread/list",
    params: {
      limit: 50,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: ["cli", "vscode", "appServer"],
    },
  });

  const attachment = await supervisor.attach(shared, () => {});
  await attachment.execute({ type: "thread.subscribe", threadId: "thread-1" });
  assert.deepEqual(
    runtime.requests.slice(-2).map(({ method }) => method),
    ["thread/resume", "thread/read"],
  );

  await attachment.execute({ type: "control.acquire", takeover: false });
  await attachment.execute({
    type: "turn.start",
    clientCommandId: "55555555-5555-4555-8555-555555555555",
    threadId: "thread-1",
    text: "continue",
  });
  assert.deepEqual(runtime.requests.at(-1), {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      input: [{ type: "text", text: "continue" }],
    },
  });

  attachment.detach();
  await supervisor.close();
});
