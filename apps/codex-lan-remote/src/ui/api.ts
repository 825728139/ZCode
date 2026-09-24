import type { CurrentUser, RuntimeConnectionInfo, WorkspaceSummary } from "../contract.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`);
  return body;
}

export const api = {
  config: () => request<{ allowSignup: boolean }>("/api/config"),
  me: () => request<{ user: CurrentUser }>("/api/me"),
  login: (email: string, password: string) =>
    request<{ user: CurrentUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  setKey: (apiKey: string) =>
    request<{ ok: true }>("/api/me/openai-key", {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    }),
  workspaces: () => request<{ workspaces: WorkspaceSummary[] }>("/api/workspaces"),
  createWorkspace: (name: string) =>
    request<{ workspace: WorkspaceSummary }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  threads: (workspaceId: string) =>
    request<{ data?: unknown[]; threads?: unknown[] }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/threads`,
    ),
  runtimeConnection: (workspaceId: string) =>
    request<RuntimeConnectionInfo>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/runtime-connection`,
    ),
};
