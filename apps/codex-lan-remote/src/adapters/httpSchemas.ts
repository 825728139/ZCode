import { z } from "zod";

const clientCommandId = z.string().uuid();
const threadId = z.string().trim().min(1).max(200);

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

export const createUserSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().trim().min(1).max(80),
  password: z.string().min(12).max(256),
});

export const openAiKeySchema = z.object({
  apiKey: z.string().trim().min(20).max(512),
});

export const workspaceSchema = z.object({
  name: z.string().trim().min(1).max(64),
});

export const browserCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("control.acquire"), takeover: z.boolean() }),
  z.object({ type: z.literal("thread.subscribe"), threadId }),
  z.object({ type: z.literal("thread.start"), clientCommandId }),
  z.object({
    type: z.literal("turn.start"),
    clientCommandId,
    threadId,
    text: z.string().trim().min(1).max(100_000),
  }),
  z.object({
    type: z.literal("turn.steer"),
    clientCommandId,
    threadId,
    turnId: z.string().trim().min(1).max(200),
    text: z.string().trim().min(1).max(100_000),
  }),
  z.object({
    type: z.literal("turn.interrupt"),
    clientCommandId,
    threadId,
    turnId: z.string().trim().min(1).max(200),
  }),
  z.object({
    type: z.literal("approval.resolve"),
    clientCommandId,
    requestId: z.string().trim().min(1).max(200),
    decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  }),
]);
