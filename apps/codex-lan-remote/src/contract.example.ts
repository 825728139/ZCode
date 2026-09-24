import type { BrowserCommand, RemoteEvent } from "./contract.js";

export function sendRemoteCommand(
  send: (command: BrowserCommand) => void,
  onEvent: (event: RemoteEvent) => void,
): void {
  onEvent({ type: "connection.ready", connectionId: "browser-1", sequence: 1 });
  send({ type: "control.acquire", takeover: false });
}
