import type { Member, Message, MessageAttachment } from "@agent-tavern/shared";

import { queueAgentSession } from "../agents/runtime";
import { submitMessageInternal } from "./message-submission";

export function submitMessage(params: {
  roomId: string;
  sender: Member;
  content: string;
  attachments: MessageAttachment[];
  mentionedDisplayNames?: string[];
  replyToMessageId?: string | null;
  messageId?: string;
  createdAt?: string;
}): Message {
  const { message, queuedSessionIds } = submitMessageInternal(params);

  for (const sessionId of queuedSessionIds) {
    queueAgentSession(sessionId);
  }

  return message;
}
