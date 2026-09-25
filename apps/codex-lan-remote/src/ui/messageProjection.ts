import type { RemoteEvent } from "../contract.js";

export type ThreadRecord = Record<string, unknown>;
export interface ProjectedMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}

export function toRecord(value: unknown): ThreadRecord {
  return value && typeof value === "object" ? (value as ThreadRecord) : {};
}
export function commandId(): string {
  return crypto.randomUUID();
}
export function threadRows(payload: unknown): ThreadRecord[] {
  const source = toRecord(payload);
  const rows = source.data ?? source.threads;
  return Array.isArray(rows) ? rows.map(toRecord) : [];
}
export function threadTitle(thread: ThreadRecord): string {
  return String(thread.name || thread.preview || thread.title || "未命名会话");
}
export function projectEvent(event: RemoteEvent): ProjectedMessage | null {
  if (event.type !== "codex.event") return null;
  const params = toRecord(event.params);
  if (event.method === "item/agentMessage/delta")
    return { role: "assistant", text: String(params.delta ?? "") };
  if (event.method === "turn/completed") return { role: "tool", text: "任务已完成" };
  if (event.method === "turn/started") return { role: "tool", text: "Codex 正在处理" };
  if (event.method === "item/started") {
    const item = toRecord(params.item);
    if (item.type === "commandExecution")
      return { role: "tool", text: `$ ${String(item.command ?? "")}` };
  }
  return null;
}

export function liveMessages(events: RemoteEvent[]): ProjectedMessage[] {
  const snapshotIndex = events.findLastIndex((event) => event.type === "thread.snapshot");
  const projected: ProjectedMessage[] = [];
  const assistantItems = new Map<string, number>();
  let anonymousAssistantIndex: number | null = null;

  for (const event of events.slice(snapshotIndex + 1)) {
    if (event.type === "codex.event" && event.method === "item/agentMessage/delta") {
      const params = toRecord(event.params);
      const delta = String(params.delta ?? "");
      if (!delta) continue;
      const itemId = typeof params.itemId === "string" ? params.itemId : null;
      const existingIndex = itemId ? assistantItems.get(itemId) : anonymousAssistantIndex;
      if (existingIndex !== undefined && existingIndex !== null) {
        const current = projected[existingIndex];
        if (current) projected[existingIndex] = { ...current, text: current.text + delta };
      } else {
        const index = projected.push({ role: "assistant", text: delta }) - 1;
        if (itemId) assistantItems.set(itemId, index);
        else anonymousAssistantIndex = index;
      }
      continue;
    }

    // 无 itemId 时只能合并真正相邻的 delta，避免把工具活动两侧的消息错误拼在一起。
    anonymousAssistantIndex = null;
    const message = projectEvent(event);
    if (message) projected.push(message);
  }

  return projected;
}

function projectItem(value: unknown): ProjectedMessage | null {
  const item = toRecord(value);
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content)
      ? item.content.map((part) => String(toRecord(part).text ?? "")).join("\n")
      : "";
    return content ? { role: "user", text: content } : null;
  }
  if (item.type === "agentMessage") return { role: "assistant", text: String(item.text ?? "") };
  if (item.type === "commandExecution")
    return {
      role: "tool",
      text: `$ ${String(item.command ?? "")}\n${String(item.aggregatedOutput ?? "")}`.trim(),
    };
  if (item.type === "fileChange") return { role: "tool", text: "文件已修改" };
  return null;
}
export function snapshotMessages(events: RemoteEvent[]): ProjectedMessage[] {
  const snapshot = [...events].reverse().find((event) => event.type === "thread.snapshot");
  if (!snapshot || snapshot.type !== "thread.snapshot") return [];
  const turns = toRecord(toRecord(snapshot.thread).thread).turns;
  if (!Array.isArray(turns)) return [];
  return turns.flatMap((turn) => {
    const items = toRecord(turn).items;
    return Array.isArray(items)
      ? items.map(projectItem).filter((value): value is ProjectedMessage => Boolean(value))
      : [];
  });
}
