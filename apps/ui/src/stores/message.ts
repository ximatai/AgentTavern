import { create } from "zustand";
import type { MessageAttachment, PublicMessage } from "@agent-tavern/shared";

import { sendMessage as sendMessageAPI, uploadAttachments as uploadAttachmentsAPI, deletePendingAttachment as deletePendingAttachmentAPI } from "../api/messages";
import type { SessionStream } from "../types";

interface MessageState {
  messages: PublicMessage[];
  streams: Record<string, SessionStream>;
  pendingAttachments: MessageAttachment[];
  replyTargetId: string | null;
}

interface MessageActions {
  setMessages: (messages: PublicMessage[]) => void;
  sendMessage: (params: {
    roomId: string;
    memberId: string;
    wsToken: string;
    content: string;
  }) => Promise<void>;
  uploadAttachments: (params: {
    roomId: string;
    memberId: string;
    wsToken: string;
    files: File[];
  }) => Promise<void>;
  removeAttachment: (params: {
    roomId: string;
    memberId: string;
    wsToken: string;
    attachmentId: string;
  }) => Promise<void>;
  setReplyTarget: (messageId: string | null) => void;
  clearReplyTarget: () => void;
  addMessage: (message: PublicMessage) => void;
  upsertStream: (stream: SessionStream) => void;
  removeStream: (messageId: string) => void;
  reset: () => void;
}

export type MessageStore = MessageState & MessageActions;

function sortMessages(messages: PublicMessage[]): PublicMessage[] {
  return [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export const useMessageStore = create<MessageStore>()((set, get) => ({
  messages: [],
  streams: {},
  pendingAttachments: [],
  replyTargetId: null,

  setMessages: (messages: PublicMessage[]) => {
    set({ messages: sortMessages(messages) });
  },

  sendMessage: async (params) => {
    const { roomId, memberId, wsToken, content } = params;
    const { pendingAttachments, replyTargetId } = get();

    const message = await sendMessageAPI(roomId, {
      senderMemberId: memberId,
      wsToken,
      content,
      attachmentIds: pendingAttachments.map((a) => a.id),
      replyToMessageId: replyTargetId,
    });

    set((state) => ({
      messages: sortMessages([
        ...state.messages.filter((m) => m.id !== message.id),
        message,
      ]),
      pendingAttachments: [],
      replyTargetId: null,
    }));
  },

  uploadAttachments: async (params) => {
    const { roomId, memberId, wsToken, files } = params;
    const attachments = await uploadAttachmentsAPI(roomId, memberId, wsToken, files);
    set((state) => ({
      pendingAttachments: [...state.pendingAttachments, ...attachments],
    }));
  },

  removeAttachment: async (params) => {
    const { roomId, memberId, wsToken, attachmentId } = params;
    await deletePendingAttachmentAPI(roomId, attachmentId, memberId, wsToken);
    set((state) => ({
      pendingAttachments: state.pendingAttachments.filter((a) => a.id !== attachmentId),
    }));
  },

  setReplyTarget: (messageId: string | null) => {
    set({ replyTargetId: messageId });
  },

  clearReplyTarget: () => {
    set({ replyTargetId: null });
  },

  addMessage: (message: PublicMessage) => {
    set((state) => ({
      messages: sortMessages([
        ...state.messages.filter((m) => m.id !== message.id),
        message,
      ]),
    }));
  },

  upsertStream: (stream: SessionStream) => {
    set((state) => ({
      streams: { ...state.streams, [stream.id]: stream },
    }));
  },

  removeStream: (messageId: string) => {
    set((state) => {
      const next = { ...state.streams };
      delete next[messageId];
      return { streams: next };
    });
  },

  reset: () => {
    set({
      messages: [],
      streams: {},
      pendingAttachments: [],
      replyTargetId: null,
    });
  },
}));

export function getVisibleMessages(
  state: Pick<MessageStore, "messages" | "streams">,
): (PublicMessage | SessionStream)[] {
  return [...state.messages, ...Object.values(state.streams)];
}
