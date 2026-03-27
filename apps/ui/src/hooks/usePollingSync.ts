import { useEffect } from "react";

import { usePrincipalStore } from "../stores/principal";
import { useRoomStore } from "../stores/room";

/**
 * Polls the server periodically to catch state changes that are not
 * broadcast over WebSocket (e.g. bridge attachment updating
 * runtimeStatus from "pending_bridge" to "ready").
 *
 * Two independent intervals:
 *   1. Room members  -- every 10 s when a room is active
 *   2. Lobby presence -- every 10 s when principal is authenticated
 */
export function usePollingSync() {
  const room = useRoomStore((s) => s.room);
  const principal = usePrincipalStore((s) => s.principal);

  useEffect(() => {
    if (!room) return;

    const id = window.setInterval(() => {
      void useRoomStore.getState().refreshMembers();
    }, 10_000);

    return () => window.clearInterval(id);
  }, [room]);

  useEffect(() => {
    if (!principal) return;

    const id = window.setInterval(() => {
      void useRoomStore.getState().refreshLobbyPresence();
    }, 10_000);

    return () => window.clearInterval(id);
  }, [principal]);
}
