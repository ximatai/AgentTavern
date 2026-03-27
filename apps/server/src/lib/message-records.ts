import type { Member, Message, SystemMessageData } from "@agent-tavern/shared";

import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { members, messages } from "../db/schema";

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
  const sender = db.select().from(members).where(eq(members.id, message.senderMemberId)).get();
  const typedSender = sender
    ? ({
        type: sender.type as Member["type"],
        roleKind: sender.roleKind as Member["roleKind"],
        displayName: sender.displayName,
      } satisfies Pick<Member, "type" | "roleKind" | "displayName">)
    : null;

  return {
    id: message.id,
    roomId: message.roomId,
    senderMemberId: message.senderMemberId,
    senderDisplayName: message.senderDisplayName ?? typedSender?.displayName ?? message.senderMemberId,
    senderType: message.senderType ?? typedSender?.type ?? null,
    senderRoleKind: message.senderRoleKind ?? typedSender?.roleKind ?? null,
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
    senderDisplayName: row.senderDisplayName ?? undefined,
    senderType: (row.senderType as Message["senderType"]) ?? undefined,
    senderRoleKind: (row.senderRoleKind as Message["senderRoleKind"]) ?? undefined,
    messageType: row.messageType as Message["messageType"],
    content: row.content,
    attachments: [],
    systemData: parseSystemMessageData(row.systemData),
    replyToMessageId: row.replyToMessageId ?? null,
    createdAt: row.createdAt,
  };
}
