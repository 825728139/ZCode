import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteEvent } from "../src/contract.js";
import { liveMessages } from "../src/ui/messageProjection.js";

function codexEvent(
  method: string,
  params: Record<string, unknown>,
  sequence: number,
): RemoteEvent {
  return { type: "codex.event", method, params, sequence };
}

test("assistant deltas from one item are projected as one continuous message", () => {
  const events: RemoteEvent[] = [
    codexEvent("turn/started", {}, 1),
    codexEvent("item/agentMessage/delta", { itemId: "item-1", delta: "你" }, 2),
    codexEvent("item/agentMessage/delta", { itemId: "item-1", delta: "好" }, 3),
    codexEvent("item/agentMessage/delta", { itemId: "item-1", delta: "。" }, 4),
    codexEvent("turn/completed", {}, 5),
  ];

  assert.deepEqual(liveMessages(events), [
    { role: "tool", text: "Codex 正在处理" },
    { role: "assistant", text: "你好。" },
    { role: "tool", text: "任务已完成" },
  ]);
});

test("a snapshot resets live projection and missing item ids only merge adjacent deltas", () => {
  const events: RemoteEvent[] = [
    codexEvent("item/agentMessage/delta", { itemId: "old", delta: "旧内容" }, 1),
    { type: "thread.snapshot", thread: { thread: { turns: [] } }, sequence: 2 },
    codexEvent("item/agentMessage/delta", { delta: "第一" }, 3),
    codexEvent("turn/completed", {}, 4),
    codexEvent("item/agentMessage/delta", { delta: "第二" }, 5),
  ];

  assert.deepEqual(liveMessages(events), [
    { role: "assistant", text: "第一" },
    { role: "tool", text: "任务已完成" },
    { role: "assistant", text: "第二" },
  ]);
});
