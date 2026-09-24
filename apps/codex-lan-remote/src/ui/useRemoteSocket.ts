import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserCommand, RemoteEvent } from "../contract.js";

export function useRemoteSocket(workspaceId: string | null) {
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [writable, setWritable] = useState(false);
  const [events, setEvents] = useState<RemoteEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!workspaceId) return;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}/ws?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    socketRef.current = socket;
    socket.onopen = () => {
      setConnected(true);
      setError("");
    };
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as RemoteEvent;
      if (event.type === "control.changed") {
        clearTimeout(leaseTimer);
        setWritable(event.writable);
        if (event.writable) {
          leaseTimer = setTimeout(
            () => setWritable(false),
            Math.max(0, event.leaseExpiresAt - Date.now()),
          );
        }
      }
      if (event.type === "command.error") setError(event.message);
      setEvents((current) => [...current.slice(-499), event]);
    };
    socket.onerror = () => setError("实时连接失败");
    socket.onclose = () => {
      setConnected(false);
      setWritable(false);
    };
    return () => {
      clearTimeout(leaseTimer);
      socket.close();
      socketRef.current = null;
      setEvents([]);
    };
  }, [workspaceId]);

  const send = useCallback((command: BrowserCommand) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("实时连接尚未就绪");
    socket.send(JSON.stringify(command));
  }, []);

  return { connected, writable, events, error, setError, send };
}
