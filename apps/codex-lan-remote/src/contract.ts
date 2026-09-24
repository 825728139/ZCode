export type UserRole = "admin" | "member";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  hasOpenAiKey: boolean;
  usesSharedCodexAuth: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: string;
}

export interface ThreadSummary {
  id: string;
  name: string | null;
  preview: string;
  createdAt: number;
  updatedAt: number;
  status: unknown;
}

export interface RuntimeConnectionInfo {
  remoteAddress: string;
  cliArgs: string[];
}

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type BrowserCommand =
  | { type: "control.acquire"; takeover: boolean }
  | { type: "thread.subscribe"; threadId: string }
  | { type: "thread.start"; clientCommandId: string }
  | { type: "turn.start"; clientCommandId: string; threadId: string; text: string }
  | {
      type: "turn.steer";
      clientCommandId: string;
      threadId: string;
      turnId: string;
      text: string;
    }
  | { type: "turn.interrupt"; clientCommandId: string; threadId: string; turnId: string }
  | {
      type: "approval.resolve";
      clientCommandId: string;
      requestId: string;
      decision: ApprovalDecision;
    };

export type RemoteEvent =
  | { type: "connection.ready"; connectionId: string; sequence: number }
  | { type: "control.changed"; writable: boolean; leaseExpiresAt: number; sequence: number }
  | { type: "thread.snapshot"; thread: unknown; sequence: number }
  | { type: "codex.event"; method: string; params: unknown; sequence: number }
  | {
      type: "approval.requested";
      requestId: string;
      method: string;
      params: unknown;
      sequence: number;
    }
  | { type: "command.result"; clientCommandId: string; result: unknown; sequence: number }
  | { type: "command.error"; clientCommandId?: string; message: string; sequence: number };
