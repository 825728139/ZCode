export const codexLanRemoteModule = {
  id: "codex-lan-remote",
  requires: [],
  provides: ["codex-remote-http", "codex-remote-web"],
  publicEntrypoints: ["contract.ts"],
} as const;
