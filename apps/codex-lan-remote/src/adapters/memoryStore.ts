import { randomUUID } from "node:crypto";
import type { CreateUserInput, IdentityStore, StoredUser } from "../app/ports.js";
import type { WorkspaceSummary } from "../contract.js";

export class MemoryIdentityStore implements IdentityStore {
  readonly #users = new Map<string, StoredUser>();
  readonly #sessions = new Map<string, { userId: string; expiresAt: Date }>();
  readonly #workspaces = new Map<string, WorkspaceSummary[]>();

  async migrate(): Promise<void> {}
  async countUsers(): Promise<number> {
    return this.#users.size;
  }

  async createUser(input: CreateUserInput): Promise<StoredUser> {
    if ([...this.#users.values()].some((user) => user.email === input.email)) {
      throw new Error("邮箱已存在");
    }
    const user: StoredUser = {
      ...input,
      id: randomUUID(),
      encryptedOpenAiKey: null,
      hasOpenAiKey: false,
    };
    this.#users.set(user.id, user);
    return user;
  }

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    return [...this.#users.values()].find((user) => user.email === email) ?? null;
  }
  async findUserById(id: string): Promise<StoredUser | null> {
    return this.#users.get(id) ?? null;
  }
  async createSession(userId: string, digest: string, expiresAt: Date): Promise<void> {
    this.#sessions.set(digest, { userId, expiresAt });
  }
  async findUserBySession(digest: string): Promise<StoredUser | null> {
    const session = this.#sessions.get(digest);
    if (!session || session.expiresAt <= new Date()) return null;
    return this.#users.get(session.userId) ?? null;
  }
  async deleteSession(digest: string): Promise<void> {
    this.#sessions.delete(digest);
  }
  async setOpenAiKey(userId: string, encryptedKey: string | null): Promise<void> {
    const user = this.#users.get(userId);
    if (!user) return;
    user.encryptedOpenAiKey = encryptedKey;
    user.hasOpenAiKey = encryptedKey !== null;
  }
  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    return [...(this.#workspaces.get(userId) ?? [])];
  }
  async createWorkspace(userId: string, name: string): Promise<WorkspaceSummary> {
    const existing = this.#workspaces.get(userId) ?? [];
    if (existing.some((workspace) => workspace.name === name)) throw new Error("工作区名称已存在");
    const workspace = { id: randomUUID(), name, createdAt: new Date().toISOString() };
    existing.push(workspace);
    this.#workspaces.set(userId, existing);
    return workspace;
  }
  async findWorkspace(userId: string, workspaceId: string): Promise<WorkspaceSummary | null> {
    return this.#workspaces.get(userId)?.find((workspace) => workspace.id === workspaceId) ?? null;
  }
  async close(): Promise<void> {}
}
