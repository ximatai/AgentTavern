import { useEffect, useRef } from "react";

import type { RealtimeEvent } from "@agent-tavern/shared";

import { createRoomSocket, isRealtimeEvent } from "../api/ws";
import { useApprovalStore } from "../stores/approval";
import { useConnectionStore } from "../stores/connection";
import { useMessageStore } from "../stores/message";
import { useCitizenStore } from "../stores/citizen";
import { useRoomStore } from "../stores/room";
import { useSessionStore } from "../stores/session";

/**
 * Manages the room WebSocket connection and dispatches incoming
 * RealtimeEvents to the appropriate Zustand stores.
 *
 * Connection lifecycle:
 *   - Socket is created when `self` and `room` are both set
 *   - Socket is closed on cleanup or when self/room become null
 *   - Connection status is reflected in the connection store
 *
 * Event dispatch:
 *   agent.session.started   → sessionStore.startSession
 *   agent.stream.delta      → sessionStore.updateStream
 *   agent.message.committed → sessionStore.commitMessage (removes stream)
 *   agent.session.completed → sessionStore.updateSession
 *   agent.session.failed    → sessionStore.updateSession (with error)
 *   message.created/updated → messageStore.addMessage + removeStream
 *   approval.requested      → approvalStore.addApproval
 *   approval.resolved       → approvalStore.removeApproval
 *   member.joined/updated   → roomStore.addOrUpdateMember
 *   member.left             → roomStore.removeMember
 */
export function useRoomWebSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const recoveringRoomRef = useRef(false);

  const self = useRoomStore((s) => s.self);
  const room = useRoomStore((s) => s.room);

  useEffect(() => {
    if (!self || !room) {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      reconnectAttemptRef.current = 0;
      socketRef.current?.close();
      socketRef.current = null;
      useConnectionStore.getState().setStatus("none");
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

      const socket = createRoomSocket(room.id, self.memberId, self.wsToken);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        if (disposed) {
          socket.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        recoveringRoomRef.current = false;
        useConnectionStore.getState().setStatus("connected");
      });

      socket.addEventListener("close", (event) => {
        if (disposed) {
          return;
        }
        if (socketRef.current === socket) {
          socketRef.current = null;
        }

        if (event.code === 1008 && !recoveringRoomRef.current) {
          recoveringRoomRef.current = true;
          useConnectionStore.getState().setStatus("disconnected");
          void (async () => {
            try {
              await useCitizenStore.getState().restoreFromStorage();
              const refreshedPrincipal = useCitizenStore.getState().principal;
              if (refreshedPrincipal) {
                await useRoomStore.getState().joinExistingRoom(room.id);
              } else {
                scheduleReconnect();
              }
            } catch {
              scheduleReconnect();
            }
          })();
          return;
        }

        useConnectionStore.getState().setStatus("disconnected");
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

        handleEvent(raw);
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
      useConnectionStore.getState().setStatus("none");
      if (socketRef.current) {
        const socket = socketRef.current;
        socketRef.current = null;
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }
    };
  }, [self, room]);

  return socketRef;
}

function handleEvent(event: RealtimeEvent): void {
  switch (event.type) {
    // ── Agent streaming events ──
    case "agent.session.started": {
      useSessionStore.getState().startSession(event.payload.session);
      break;
    }
    case "agent.stream.delta": {
      const { sessionId, messageId, delta } = event.payload;
      useSessionStore.getState().updateStream({ sessionId, messageId, delta });
      break;
    }
    case "agent.message.committed": {
      const { sessionId, message } = event.payload;
      useSessionStore.getState().commitMessage(sessionId, message);
      void useRoomStore.getState().refreshRoomSummary();
      break;
    }
    case "agent.session.completed": {
      useSessionStore.getState().updateSession(event.payload.session, null);
      void useRoomStore.getState().refreshRoomSummary();
      break;
    }
    case "agent.session.failed": {
      useSessionStore.getState().updateSession(event.payload.session, event.payload.error);
      break;
    }

    // ── Message events ──
    case "message.created":
    case "message.updated": {
      useMessageStore.getState().addMessage(event.payload.message);
      useMessageStore.getState().removeStream(event.payload.message.id);
      break;
    }

    // ── Approval events ──
    case "approval.requested": {
      useApprovalStore.getState().addApproval(event.payload.approval);
      break;
    }
    case "approval.resolved": {
      useApprovalStore.getState().removeApproval(event.payload.approval.id);
      break;
    }

    // ── Room member events ──
    case "member.joined":
    case "member.updated": {
      useRoomStore.getState().addOrUpdateMember(event.payload.member);
      break;
    }
    case "room.updated": {
      useRoomStore.getState().setRoom(event.payload.room);
      break;
    }
    case "member.left": {
      const self = useRoomStore.getState().self;
      if (self?.memberId === event.payload.memberId) {
        useRoomStore.getState().clearCurrentRoom(event.roomId);
        useConnectionStore.getState().setStatus("none");
        break;
      }
      useRoomStore.getState().removeMember(event.payload.memberId);
      break;
    }
  }
}
