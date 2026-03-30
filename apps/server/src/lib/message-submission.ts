import type {
  Member,
  Message,
  MessageAttachment,
} from "@agent-tavern/shared";

import { broadcastToRoom } from "../realtime";
import { createMessageCreatedEvent, now } from "../routes/support";
import { createId } from "./id";
import { attachDraftsToMessage } from "./message-attachments";
import { insertMessage } from "./message-records";
import { processMessageTriggers } from "./message-triggering";

export function submitMessageInternal(params: {
  roomId: string;
  sender: Member;
  content: string;
  attachments: MessageAttachment[];
  replyToMessageId?: string | null;
  messageId?: string;
  createdAt?: string;
  draftAttachmentIds?: string[];
  attachmentUploaderMemberId?: string;
}): { message: Message; queuedSessionIds: string[] } {
  const message: Message = {
    id: params.messageId ?? createId("msg"),
    roomId: params.roomId,
    senderMemberId: params.sender.id,
    messageType: params.sender.type === "agent" ? "agent_text" : "user_text",
    content: params.content,
    attachments: params.attachments,
    replyToMessageId: params.replyToMessageId ?? null,
    createdAt: params.createdAt ?? now(),
  };

  insertMessage(message);

  if (params.draftAttachmentIds?.length) {
    attachDraftsToMessage({
      roomId: params.roomId,
      uploaderMemberId: params.attachmentUploaderMemberId ?? params.sender.id,
      messageId: message.id,
      attachmentIds: params.draftAttachmentIds,
    });
  }

  broadcastToRoom(params.roomId, createMessageCreatedEvent(params.roomId, message));

  return {
    message,
    queuedSessionIds: processMessageTriggers({
      roomId: params.roomId,
      sender: params.sender,
      message,
    }),
  };
}
