import { useEffect, useRef } from "react";

import { createPrincipalSocket, isRealtimeEvent } from "../api/ws";
import { usePrincipalStore } from "../stores/principal";
import { useRoomStore } from "../stores/room";

/**
 * Manages the principal WebSocket connection for cross-room events.
 *
 * Connects when `principal` is set, disconnects on cleanup or logout.
 * Handles `private_assistants.changed` events by signaling the principal
 * store so consumers (e.g. AssistantManagementModal) can re-fetch.
 */
export function usePrincipalWebSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const recoveringTokenRef = useRef(false);
  const principal = usePrincipalStore((s) => s.principal);

  useEffect(() => {
    if (!principal) {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      socketRef.current?.close();
      socketRef.current = null;
      return;
    }

    let disposed = false;
    const scheduleReconnect = () => {
      if (disposed || reconnectTimerRef.current !== null) {
        return;
      }
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(1_000 * 2 ** attempt, 10_000);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        reconnectAttemptRef.current += 1;
        connect();
      }, delay);
    };

    const connect = () => {
      if (disposed) return;

      const socket = createPrincipalSocket(
        principal.principalId,
        principal.principalToken,
      );
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed) {
          socket.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        recoveringTokenRef.current = false;
        void useRoomStore.getState().refreshLobbyPresence();
      });

      socket.addEventListener("close", (event) => {
        if (disposed) {
          return;
        }
        if (socketRef.current === socket) {
          socketRef.current = null;
        }

        if (event.code === 1008 && !recoveringTokenRef.current) {
          recoveringTokenRef.current = true;
          void usePrincipalStore.getState().restoreFromStorage();
          return;
        }

        scheduleReconnect();
      });

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
          return;
        }

        if (raw.type === "rooms.changed") {
          void useRoomStore.getState().refreshJoinedRooms();
          return;
        }

        if (raw.type === "lobby.presence.changed") {
          void useRoomStore.getState().refreshLobbyPresence();
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      if (socketRef.current) {
        const socket = socketRef.current;
        socketRef.current = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }
    };
  }, [principal]);

  return socketRef;
}
