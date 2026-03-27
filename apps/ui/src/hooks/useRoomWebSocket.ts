import { useEffect, useRef } from "react";

import type { RealtimeEvent } from "@agent-tavern/shared";

import { createRoomSocket, isRealtimeEvent } from "../api/ws";
import { useApprovalStore } from "../stores/approval";
import { useConnectionStore } from "../stores/connection";
import { useMessageStore } from "../stores/message";
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

  const self = useRoomStore((s) => s.self);
  const room = useRoomStore((s) => s.room);

  useEffect(() => {
    if (!self || !room) {
      socketRef.current?.close();
      socketRef.current = null;
      useConnectionStore.getState().setStatus("none");
      return;
    }

    const socket = createRoomSocket(room.id, self.memberId, self.wsToken);
    let disposed = false;
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (disposed) {
        socket.close();
        return;
      }
      useConnectionStore.getState().setStatus("connected");
    });

    socket.addEventListener("close", () => {
      if (disposed) {
        return;
      }
      useConnectionStore.getState().setStatus("disconnected");
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

    return () => {
      disposed = true;
      useConnectionStore.getState().setStatus("none");
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
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
      break;
    }
    case "agent.session.completed": {
      useSessionStore.getState().updateSession(event.payload.session, null);
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
    case "member.left": {
      useRoomStore.getState().removeMember(event.payload.memberId);
      break;
    }
  }
}
