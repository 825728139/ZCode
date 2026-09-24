import type { CurrentUser, UserRole, WorkspaceSummary } from "../contract.js";

export interface StoredUser extends Omit<CurrentUser, "usesSharedCodexAuth"> {
  passwordHash: string;
  encryptedOpenAiKey: string | null;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
}

export interface IdentityStore {
  migrate(): Promise<void>;
  countUsers(): Promise<number>;
  createUser(input: CreateUserInput): Promise<StoredUser>;
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(id: string): Promise<StoredUser | null>;
  createSession(userId: string, digest: string, expiresAt: Date): Promise<void>;
  findUserBySession(digest: string): Promise<StoredUser | null>;
  deleteSession(digest: string): Promise<void>;
  setOpenAiKey(userId: string, encryptedKey: string | null): Promise<void>;
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>;
  createWorkspace(userId: string, name: string): Promise<WorkspaceSummary>;
  findWorkspace(userId: string, workspaceId: string): Promise<WorkspaceSummary | null>;
  close(): Promise<void>;
}

export interface CodexServerMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface CodexRuntimePort {
  request(method: string, params: unknown): Promise<unknown>;
  respond(id: string | number, result: unknown): void;
  subscribe(listener: (message: CodexServerMessage) => void): () => void;
  close(): Promise<void>;
}

export interface RuntimeFactoryInput {
  runtimeId: string;
  workspacePath: string;
  homePath: string;
  openAiApiKey?: string;
}

export interface RuntimeFactoryPort {
  create(input: RuntimeFactoryInput): Promise<CodexRuntimePort>;
}
