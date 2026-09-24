import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BrowserWindow, MessageChannelMain } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes } from "@zcode/shared";
import {
  startDesktopLanRemoteGateway,
  type DesktopLanRemoteGateway,
  type DesktopLanRemoteTarget,
} from "./desktopLanRemoteGateway.js";

interface DesktopLanRemoteBootstrapOptions {
  environment: NodeJS.ProcessEnv;
  appPath: string;
  isPackaged: boolean;
  serverId: string;
  serverName: string;
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  windowWorkspaceMap: Map<number, Set<string>>;
  listWindows: () => BrowserWindow[];
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

function parsePort(value: string | undefined): number {
  if (!value?.trim()) return 3031;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("ZCODE_LAN_REMOTE_PORT 必须是 1-65535 之间的整数");
  }
  return parsed;
}

function resolveStaticRoot(options: DesktopLanRemoteBootstrapOptions): string {
  const override = options.environment.ZCODE_LAN_REMOTE_STATIC_ROOT?.trim();
  if (override) return resolve(override);
  return options.isPackaged
    ? resolve(options.appPath, "out", "renderer")
    : resolve(options.appPath, "..", "web", "dist");
}

export async function startConfiguredDesktopLanRemoteGateway(
  options: DesktopLanRemoteBootstrapOptions,
): Promise<DesktopLanRemoteGateway | null> {
  if (options.environment.ZCODE_LAN_REMOTE_ENABLED?.trim() !== "1") return null;
  const password = options.environment.ZCODE_LAN_REMOTE_PASSWORD;
  if (!password) {
    options.logger.warn(
      "[lan-remote] ZCODE_LAN_REMOTE_ENABLED=1 but ZCODE_LAN_REMOTE_PASSWORD is missing; gateway disabled",
    );
    return null;
  }

  const resolveTargetWindow = (): BrowserWindow | null => {
    const windows = options
      .listWindows()
      .filter(
        (window) =>
          !window.isDestroyed() && options.windowHostProcessMap.has(window.webContents.id),
      );
    const focused = BrowserWindow.getFocusedWindow();
    return focused && windows.includes(focused) ? focused : (windows[0] ?? null);
  };

  const resolveTarget = (): DesktopLanRemoteTarget | null => {
    const window = resolveTargetWindow();
    if (!window) return null;
    return {
      label: window.getTitle() || options.serverName,
      workspaces: [...(options.windowWorkspaceMap.get(window.id) ?? [])],
    };
  };

  return startDesktopLanRemoteGateway({
    host: options.environment.ZCODE_LAN_REMOTE_HOST?.trim() || "0.0.0.0",
    port: parsePort(options.environment.ZCODE_LAN_REMOTE_PORT),
    password,
    staticRoot: resolveStaticRoot(options),
    serverId: options.serverId,
    serverName: options.serverName,
    resolveTarget,
    attach: () => {
      const window = resolveTargetWindow();
      const hostProcess = window
        ? options.windowHostProcessMap.get(window.webContents.id)
        : undefined;
      if (!window || !hostProcess) throw new Error("Desktop Window Host is not ready");
      const { port1, port2 } = new MessageChannelMain();
      hostProcess.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId: randomUUID(),
          clientMode: "web-remote-replayable",
          scope: { kind: "local" },
        },
        [port2],
      );
      return port1;
    },
    logger: options.logger,
  });
}
