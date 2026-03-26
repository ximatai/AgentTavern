import type { Message, SystemMessageData } from "@agent-tavern/shared";

import { db } from "../db/client";
import { messages } from "../db/schema";

function isSystemMessageData(value: unknown): value is SystemMessageData {
  if (!value || typeof value !== "object") {
    return false;
  }

  const data = value as Record<string, unknown>;
  return (
    typeof data.kind === "string" &&
    typeof data.status === "string" &&
    typeof data.title === "string" &&
    typeof data.detail === "string"
  );
}

export function parseSystemMessageData(raw: string | null): SystemMessageData | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSystemMessageData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function toMessageRecord(message: Message): typeof messages.$inferInsert {
  return {
    id: message.id,
    roomId: message.roomId,
    senderMemberId: message.senderMemberId,
    messageType: message.messageType,
    content: message.content,
    systemData: message.systemData ? JSON.stringify(message.systemData) : null,
    replyToMessageId: message.replyToMessageId,
    createdAt: message.createdAt,
  };
}

export function insertMessage(message: Message): void {
  db.insert(messages).values(toMessageRecord(message)).run();
}

export function toDomainMessage(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    roomId: row.roomId,
    senderMemberId: row.senderMemberId,
    messageType: row.messageType as Message["messageType"],
    content: row.content,
    attachments: [],
    systemData: parseSystemMessageData(row.systemData),
    replyToMessageId: row.replyToMessageId ?? null,
    createdAt: row.createdAt,
  };
}
