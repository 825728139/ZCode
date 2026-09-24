import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import type { CreateUserInput, IdentityStore, StoredUser } from "../app/ports.js";
import type { UserRole, WorkspaceSummary } from "../contract.js";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  encrypted_openai_key: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  created_at: Date;
}

function toStoredUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    encryptedOpenAiKey: row.encrypted_openai_key,
    hasOpenAiKey: row.encrypted_openai_key !== null,
  };
}

function toWorkspace(row: WorkspaceRow): WorkspaceSummary {
  return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() };
}

export class PostgresIdentityStore implements IdentityStore {
  readonly #sql: Sql;

  constructor(databaseUrl: string) {
    this.#sql = postgres(databaseUrl, { max: 10, idle_timeout: 20 });
  }

  async migrate(): Promise<void> {
    await this.#sql`
      create table if not exists codex_remote_users (
        id text primary key,
        email text not null unique,
        display_name text not null,
        password_hash text not null,
        role text not null check (role in ('admin', 'member')),
        encrypted_openai_key text,
        created_at timestamptz not null default now()
      )
    `;
    await this.#sql`
      create table if not exists codex_remote_sessions (
        token_digest text primary key,
        user_id text not null references codex_remote_users(id) on delete cascade,
        expires_at timestamptz not null,
        created_at timestamptz not null default now()
      )
    `;
    await this.#sql`
      create index if not exists codex_remote_sessions_user_id_idx
      on codex_remote_sessions(user_id)
    `;
    await this.#sql`
      create table if not exists codex_remote_workspaces (
        id text primary key,
        user_id text not null references codex_remote_users(id) on delete cascade,
        name text not null,
        created_at timestamptz not null default now(),
        unique (user_id, name)
      )
    `;
  }

  async countUsers(): Promise<number> {
    const [row] = await this.#sql<{ count: string }[]>`
      select count(*)::text as count from codex_remote_users
    `;
    return Number(row?.count ?? 0);
  }

  async createUser(input: CreateUserInput): Promise<StoredUser> {
    const [row] = await this.#sql<UserRow[]>`
      insert into codex_remote_users (
        id, email, display_name, password_hash, role
      ) values (
        ${randomUUID()}, ${input.email}, ${input.displayName}, ${input.passwordHash}, ${input.role}
      )
      returning id, email, display_name, password_hash, role, encrypted_openai_key
    `;
    if (!row) throw new Error("Failed to create user");
    return toStoredUser(row);
  }

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const [row] = await this.#sql<UserRow[]>`
      select id, email, display_name, password_hash, role, encrypted_openai_key
      from codex_remote_users where email = ${email}
    `;
    return row ? toStoredUser(row) : null;
  }

  async findUserById(id: string): Promise<StoredUser | null> {
    const [row] = await this.#sql<UserRow[]>`
      select id, email, display_name, password_hash, role, encrypted_openai_key
      from codex_remote_users where id = ${id}
    `;
    return row ? toStoredUser(row) : null;
  }

  async createSession(userId: string, digest: string, expiresAt: Date): Promise<void> {
    await this.#sql`
      insert into codex_remote_sessions (token_digest, user_id, expires_at)
      values (${digest}, ${userId}, ${expiresAt})
    `;
  }

  async findUserBySession(digest: string): Promise<StoredUser | null> {
    const [row] = await this.#sql<UserRow[]>`
      select u.id, u.email, u.display_name, u.password_hash, u.role, u.encrypted_openai_key
      from codex_remote_sessions s
      join codex_remote_users u on u.id = s.user_id
      where s.token_digest = ${digest} and s.expires_at > now()
    `;
    return row ? toStoredUser(row) : null;
  }

  async deleteSession(digest: string): Promise<void> {
    await this.#sql`delete from codex_remote_sessions where token_digest = ${digest}`;
  }

  async setOpenAiKey(userId: string, encryptedKey: string | null): Promise<void> {
    await this.#sql`
      update codex_remote_users set encrypted_openai_key = ${encryptedKey} where id = ${userId}
    `;
  }

  async listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.#sql<WorkspaceRow[]>`
      select id, name, created_at from codex_remote_workspaces
      where user_id = ${userId} order by created_at asc
    `;
    return rows.map(toWorkspace);
  }

  async createWorkspace(userId: string, name: string): Promise<WorkspaceSummary> {
    const [row] = await this.#sql<WorkspaceRow[]>`
      insert into codex_remote_workspaces (id, user_id, name)
      values (${randomUUID()}, ${userId}, ${name})
      returning id, name, created_at
    `;
    if (!row) throw new Error("Failed to create workspace");
    return toWorkspace(row);
  }

  async findWorkspace(userId: string, workspaceId: string): Promise<WorkspaceSummary | null> {
    const [row] = await this.#sql<WorkspaceRow[]>`
      select id, name, created_at from codex_remote_workspaces
      where id = ${workspaceId} and user_id = ${userId}
    `;
    return row ? toWorkspace(row) : null;
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }
}
