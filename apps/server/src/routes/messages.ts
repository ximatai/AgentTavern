import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { Member, Message } from "@agent-tavern/shared";

import { db } from "../db/client";
import { members, messages } from "../db/schema";
import { submitMessage } from "../lib/message-orchestration";
import {
  MAX_MESSAGE_ATTACHMENTS,
  attachDraftsToMessage,
  hydrateMessagesWithAttachments,
  resolveDraftAttachments,
} from "../lib/message-attachments";
import { toPublicMessage } from "../lib/public";
import { verifyWsToken } from "../realtime";

const messageRoutes = new Hono();

messageRoutes.get("/api/rooms/:roomId/messages", (c) => {
  const roomId = c.req.param("roomId");
  const roomMessages = hydrateMessagesWithAttachments(
    db
      .select()
      .from(messages)
      .where(eq(messages.roomId, roomId))
      .orderBy(desc(messages.createdAt))
      .all()
      .reverse(),
  ).map((message) => toPublicMessage(message));

  return c.json(roomMessages);
});

messageRoutes.post("/api/rooms/:roomId/messages", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await c.req.json().catch(() => null);
  const senderMemberId =
    typeof body?.senderMemberId === "string" ? body.senderMemberId.trim() : "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";
  const attachmentIds = Array.isArray(body?.attachmentIds)
    ? body.attachmentIds.flatMap((value: unknown) =>
        typeof value === "string" && value.trim() ? [value.trim()] : [],
      )
    : [];

  if (!senderMemberId || !wsToken) {
    return c.json({ error: "senderMemberId and wsToken are required" }, 400);
  }

  if (attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
    return c.json({ error: `up to ${MAX_MESSAGE_ATTACHMENTS} attachments are allowed` }, 400);
  }

  if (!content && attachmentIds.length === 0) {
    return c.json({ error: "content or attachments are required" }, 400);
  }

  const sender = db
    .select()
    .from(members)
    .where(and(eq(members.id, senderMemberId), eq(members.roomId, roomId)))
    .get();

  if (!sender) {
    return c.json({ error: "sender not found in room" }, 404);
  }

  if (!verifyWsToken(wsToken, senderMemberId, roomId)) {
    return c.json({ error: "invalid wsToken for sender" }, 403);
  }

  const attachments = resolveDraftAttachments({
    roomId,
    uploaderMemberId: senderMemberId,
    attachmentIds,
  });

  if (attachments === null) {
    return c.json({ error: "one or more attachments are invalid or unavailable" }, 409);
  }

  const typedSender: Member = {
    id: sender.id,
    roomId: sender.roomId,
    type: sender.type as Member["type"],
    roleKind: sender.roleKind as Member["roleKind"],
    displayName: sender.displayName,
    ownerMemberId: sender.ownerMemberId,
    adapterType: sender.adapterType,
    adapterConfig: sender.adapterConfig,
    presenceStatus: sender.presenceStatus as Member["presenceStatus"],
    createdAt: sender.createdAt,
  };

  const message: Message = submitMessage({
    roomId,
    sender: typedSender,
    content,
    attachments,
  });
  attachDraftsToMessage({
    roomId,
    uploaderMemberId: senderMemberId,
    messageId: message.id,
    attachmentIds,
  });

  return c.json(toPublicMessage(message), 201);
});

export { messageRoutes };
