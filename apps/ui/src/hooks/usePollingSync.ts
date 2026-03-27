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
  const principal = usePrincipalStore((s) => s.principal);

  useEffect(() => {
    if (!principal) return;

    const id = window.setInterval(() => {
      const roomStore = useRoomStore.getState();
      if (roomStore.room) {
        void roomStore.refreshMembers();
      }
      void roomStore.syncUnreadMarks();
    }, 10_000);

    return () => window.clearInterval(id);
  }, [principal, room]);
}
