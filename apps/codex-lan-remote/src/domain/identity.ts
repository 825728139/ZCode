const workspaceNamePattern = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,63}$/u;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateWorkspaceName(value: string): string {
  const normalized = value.trim();
  if (!workspaceNamePattern.test(normalized)) {
    throw new Error("工作区名称需为 1-64 个字母、数字、空格、点、横线或下划线");
  }
  return normalized;
}

export function runtimeKey(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`;
}
