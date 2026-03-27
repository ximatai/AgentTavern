import { useEffect, useRef } from "react";

import { createPrincipalSocket, isRealtimeEvent } from "../api/ws";
import { usePrincipalStore } from "../stores/principal";

/**
 * Manages the principal WebSocket connection for cross-room events.
 *
 * Connects when `principal` is set, disconnects on cleanup or logout.
 * Handles `private_assistants.changed` events by signaling the principal
 * store so consumers (e.g. AssistantManagementModal) can re-fetch.
 */
export function usePrincipalWebSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const principal = usePrincipalStore((s) => s.principal);

  useEffect(() => {
    if (!principal) {
      socketRef.current?.close();
      socketRef.current = null;
      return;
    }

    const socket = createPrincipalSocket(
      principal.principalId,
      principal.principalToken,
    );
    socketRef.current = socket;

    socket.addEventListener("message", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isRealtimeEvent(raw)) return;

      if (raw.type === "private_assistants.changed") {
        usePrincipalStore.getState().markPrivateAssetsChanged();
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [principal]);

  return socketRef;
}
