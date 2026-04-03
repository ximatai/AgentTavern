import { create } from "zustand";
import type { AgentSession, MessageType, PublicMessage } from "@agent-tavern/shared";

import type { SessionActor, SessionSnapshot } from "../types";
import { useMessageStore } from "./message";

interface SessionState {
  sessionSnapshots: Record<string, SessionSnapshot>;
  sessionActors: Record<string, SessionActor>;
}

interface SessionActions {
  startSession: (session: AgentSession) => void;
  updateSession: (session: AgentSession, lastError?: string | null) => void;
  updateStream: (payload: {
    sessionId: string;
    messageId: string;
    delta: string;
  }) => void;
  updateReasoning: (payload: {
    sessionId: string;
    messageId: string;
    delta: string;
  }) => void;
  removeStream: (messageId: string) => void;
  commitMessage: (sessionId: string, message: PublicMessage) => void;
  reset: () => void;
}

export type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>()((set, get) => ({
  sessionSnapshots: {},
  sessionActors: {},

  startSession: (session: AgentSession) => {
    set((state) => ({
      sessionSnapshots: {
        ...state.sessionSnapshots,
          [session.id]: {
            ...session,
            kindIsProvisional: false,
            lastError: null,
            outputMessageId: state.sessionSnapshots[session.id]?.outputMessageId ?? null,
            reasoningText: state.sessionSnapshots[session.id]?.reasoningText ?? "",
          },
      },
      sessionActors: {
        ...state.sessionActors,
        [session.id]: {
          agentMemberId: session.agentMemberId,
        },
      },
    }));
  },

  updateSession: (session: AgentSession, lastError?: string | null) => {
    const existingOutputMessageId = get().sessionSnapshots[session.id]?.outputMessageId ?? null;
    if (session.status !== "running" && existingOutputMessageId) {
      useMessageStore.getState().removeStream(existingOutputMessageId);
    }

    set((state) => ({
      sessionSnapshots: {
        ...state.sessionSnapshots,
          [session.id]: {
            ...session,
            kindIsProvisional: false,
            lastError: lastError ?? null,
            outputMessageId: state.sessionSnapshots[session.id]?.outputMessageId ?? null,
            reasoningText: state.sessionSnapshots[session.id]?.reasoningText ?? "",
          },
      },
    }));
  },

  updateStream: (payload: { sessionId: string; messageId: string; delta: string }) => {
    const { sessionId, messageId, delta } = payload;
    const actor = get().sessionActors[sessionId];
    const existing = get().sessionSnapshots[sessionId];
    const existingStream = useMessageStore.getState().streams[messageId];

    // Ensure session snapshot exists
    if (!existing) {
      set((state) => ({
        sessionSnapshots: {
          ...state.sessionSnapshots,
          [sessionId]: {
            id: sessionId,
            roomId: "",
            agentMemberId: actor?.agentMemberId ?? "",
            kind: "unknown",
            kindIsProvisional: true,
            triggerMessageId: "",
            requesterMemberId: "",
            approvalId: null,
            approvalRequired: false,
            status: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            lastError: null,
            outputMessageId: messageId,
          } satisfies SessionSnapshot,
        },
      }));
    }

    // Update the stream content in the message store
    useMessageStore.getState().upsertStream({
      id: messageId,
      roomId: existing?.roomId ?? "",
      senderMemberId: existingStream?.senderMemberId ?? actor?.agentMemberId ?? "",
      senderDisplayName: existingStream?.senderDisplayName ?? "",
      senderType: existingStream?.senderType ?? "agent",
      senderRoleKind: existingStream?.senderRoleKind ?? "independent",
      senderPresenceStatus: existingStream?.senderPresenceStatus ?? "online",
      messageType: "agent_text" as MessageType,
      content: `${existingStream?.content ?? ""}${delta}`,
      attachments: existingStream?.attachments ?? [],
      systemData: null,
      replyToMessageId: null,
      createdAt: existingStream?.createdAt ?? new Date().toISOString(),
      sessionId,
      agentMemberId: existingStream?.agentMemberId ?? actor?.agentMemberId ?? "",
      reasoningContent: existingStream?.reasoningContent ?? "",
    });

    set((state) => ({
      sessionSnapshots: {
        ...state.sessionSnapshots,
        [sessionId]: {
          ...state.sessionSnapshots[sessionId],
          outputMessageId: messageId,
        },
      },
    }));
  },

  updateReasoning: (payload: { sessionId: string; messageId: string; delta: string }) => {
    const { sessionId, messageId, delta } = payload;
    const actor = get().sessionActors[sessionId];
    const existing = get().sessionSnapshots[sessionId];
    const existingStream = useMessageStore.getState().streams[messageId];

    if (!existing) {
      set((state) => ({
        sessionSnapshots: {
          ...state.sessionSnapshots,
          [sessionId]: {
            id: sessionId,
            roomId: "",
            agentMemberId: actor?.agentMemberId ?? "",
            kind: "unknown",
            kindIsProvisional: true,
            triggerMessageId: "",
            requesterMemberId: "",
            approvalId: null,
            approvalRequired: false,
            status: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            lastError: null,
            outputMessageId: messageId,
            reasoningText: delta,
          } satisfies SessionSnapshot,
        },
      }));
    } else {
      set((state) => ({
        sessionSnapshots: {
          ...state.sessionSnapshots,
          [sessionId]: {
            ...state.sessionSnapshots[sessionId],
            reasoningText: `${state.sessionSnapshots[sessionId]?.reasoningText ?? ""}${delta}`,
          },
        },
      }));
    }

    useMessageStore.getState().upsertStream({
      id: messageId,
      roomId: existing?.roomId ?? existingStream?.roomId ?? "",
      senderMemberId: existingStream?.senderMemberId ?? actor?.agentMemberId ?? "",
      senderDisplayName: existingStream?.senderDisplayName ?? "",
      senderType: existingStream?.senderType ?? "agent",
      senderRoleKind: existingStream?.senderRoleKind ?? "independent",
      senderPresenceStatus: existingStream?.senderPresenceStatus ?? "online",
      messageType: "agent_text" as MessageType,
      content: existingStream?.content ?? "",
      attachments: existingStream?.attachments ?? [],
      systemData: null,
      replyToMessageId: null,
      createdAt: existingStream?.createdAt ?? new Date().toISOString(),
      sessionId,
      agentMemberId: existingStream?.agentMemberId ?? actor?.agentMemberId ?? "",
      reasoningContent: `${existingStream?.reasoningContent ?? ""}${delta}`,
    });

    set((state) => ({
      sessionSnapshots: {
        ...state.sessionSnapshots,
        [sessionId]: {
          ...state.sessionSnapshots[sessionId],
          outputMessageId: messageId,
        },
      },
    }));
  },

  removeStream: (messageId: string) => {
    useMessageStore.getState().removeStream(messageId);
  },

  commitMessage: (sessionId: string, message: PublicMessage) => {
    set((state) => {
      const existing = state.sessionSnapshots[sessionId];
      const snapshot: SessionSnapshot = existing
        ? {
            ...existing,
            outputMessageId: message.id,
          }
        : {
            id: sessionId,
            roomId: message.roomId,
            agentMemberId: message.senderMemberId,
            kind: "unknown",
            kindIsProvisional: true,
            triggerMessageId: message.replyToMessageId ?? message.id,
            requesterMemberId: "",
            approvalId: null,
            approvalRequired: false,
            status: "completed",
            startedAt: message.createdAt,
            endedAt: message.createdAt,
            lastError: null,
            outputMessageId: message.id,
          };

      return {
        sessionSnapshots: {
          ...state.sessionSnapshots,
          [sessionId]: snapshot,
        },
      };
    });

    // Remove the stream since the message is now committed
    useMessageStore.getState().removeStream(message.id);
  },

  reset: () => {
    set({ sessionSnapshots: {}, sessionActors: {} });
  },
}));
