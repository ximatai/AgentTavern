import { useEffect } from "react";

import { usePrincipalStore } from "../stores/principal";
import { useRoomStore } from "../stores/room";

/**
 * Polls the server periodically to catch state changes that are not
 * broadcast over WebSocket (e.g. bridge attachment updating
 * runtimeStatus from "pending_bridge" to "ready").
 *
 * Currently only room members are polled. Lobby presence is updated
 * via principal-scoped realtime events.
 */
export function usePollingSync() {
  const room = useRoomStore((s) => s.room);

  useEffect(() => {
    if (!room) return;

    const id = window.setInterval(() => {
      void useRoomStore.getState().refreshMembers();
    }, 10_000);

    return () => window.clearInterval(id);
  }, [room]);
}
