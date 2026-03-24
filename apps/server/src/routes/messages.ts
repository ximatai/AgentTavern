import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { AgentSession, Approval, Message } from "@agent-tavern/shared";

import { queueAgentSession } from "../agents/runtime";
import { db } from "../db/client";
import { agentSessions, approvals, members, mentions, messages } from "../db/schema";
import { createId } from "../lib/id";
import { toPublicMessage } from "../lib/public";
import { broadcastToRoom, isMemberOnline, verifyWsToken } from "../realtime";
import {
  createApprovalRequestedEvent,
  createApprovalResolvedEvent,
  createMessageCreatedEvent,
  extractMentionNames,
  markMentionStatus,
  now,
  scheduleApprovalTimeout,
} from "./support";

const messageRoutes = new Hono();

messageRoutes.get("/api/rooms/:roomId/messages", (c) => {
  const roomId = c.req.param("roomId");
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .orderBy(desc(messages.createdAt))
    .all()
    .reverse()
    .map((message) => toPublicMessage(message as Message));

  return c.json(roomMessages);
});

messageRoutes.post("/api/rooms/:roomId/messages", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await c.req.json().catch(() => null);
  const senderMemberId =
    typeof body?.senderMemberId === "string" ? body.senderMemberId.trim() : "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";

  if (!senderMemberId || !content || !wsToken) {
    return c.json({ error: "senderMemberId, content and wsToken are required" }, 400);
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

  const message: Message = {
    id: createId("msg"),
    roomId,
    senderMemberId,
    messageType: sender.type === "agent" ? "agent_text" : "user_text",
    content,
    replyToMessageId: null,
    createdAt: now(),
  };

  db.insert(messages).values(message).run();

  broadcastToRoom(roomId, createMessageCreatedEvent(roomId, message));

  const mentionNames = extractMentionNames(content);

  for (const mentionName of mentionNames) {
    const target = db
      .select()
      .from(members)
      .where(and(eq(members.roomId, roomId), eq(members.displayName, mentionName)))
      .get();

    if (!target) {
      continue;
    }

    db.insert(mentions).values({
      id: createId("men"),
      messageId: message.id,
      targetMemberId: target.id,
      triggerText: `@${mentionName}`,
      status:
        target.type === "agent" && target.roleKind === "assistant"
          ? "pending_approval"
          : "triggered",
      createdAt: now(),
    }).run();

    if (target.type === "agent" && target.roleKind === "independent") {
      markMentionStatus({
        messageId: message.id,
        targetMemberId: target.id,
        status: "triggered",
      });

      const session: AgentSession = {
        id: createId("as"),
        roomId,
        agentMemberId: target.id,
        triggerMessageId: message.id,
        requesterMemberId: senderMemberId,
        approvalId: null,
        approvalRequired: false,
        status: "pending",
        startedAt: null,
        endedAt: null,
      };

      db.insert(agentSessions).values(session).run();
      queueAgentSession(session.id);
    }

    if (target.type === "agent" && target.roleKind === "assistant") {
      if (!target.ownerMemberId) {
        continue;
      }

      const ownerOnline = isMemberOnline(target.ownerMemberId, roomId);

      if (!ownerOnline) {
        markMentionStatus({
          messageId: message.id,
          targetMemberId: target.id,
          status: "expired",
        });

        const resolvedAt = now();
        const offlineApproval: Approval = {
          id: createId("apr"),
          roomId,
          requesterMemberId: senderMemberId,
          ownerMemberId: target.ownerMemberId,
          agentMemberId: target.id,
          triggerMessageId: message.id,
          status: "expired",
          createdAt: resolvedAt,
          resolvedAt,
        };

        db.insert(approvals).values(offlineApproval).run();

        const failedSession: AgentSession = {
          id: createId("as"),
          roomId,
          agentMemberId: target.id,
          triggerMessageId: message.id,
          requesterMemberId: senderMemberId,
          approvalId: offlineApproval.id,
          approvalRequired: true,
          status: "rejected",
          startedAt: null,
          endedAt: resolvedAt,
        };

        db.insert(agentSessions).values(failedSession).run();
        broadcastToRoom(roomId, createApprovalResolvedEvent(roomId, offlineApproval));

        const offlineMessage: Message = {
          id: createId("msg"),
          roomId,
          senderMemberId: target.id,
          messageType: "approval_result",
          content: `${target.displayName} cannot start because the owner is offline.`,
          replyToMessageId: message.id,
          createdAt: resolvedAt,
        };

        db.insert(messages).values(offlineMessage).run();
        broadcastToRoom(roomId, createMessageCreatedEvent(roomId, offlineMessage));
        continue;
      }

      const approval: Approval = {
        id: createId("apr"),
        roomId,
        requesterMemberId: senderMemberId,
        ownerMemberId: target.ownerMemberId,
        agentMemberId: target.id,
        triggerMessageId: message.id,
        status: "pending",
        createdAt: now(),
        resolvedAt: null,
      };

      db.insert(approvals).values(approval).run();
      scheduleApprovalTimeout(approval);

      const session: AgentSession = {
        id: createId("as"),
        roomId,
        agentMemberId: target.id,
        triggerMessageId: message.id,
        requesterMemberId: senderMemberId,
        approvalId: approval.id,
        approvalRequired: true,
        status: "waiting_approval",
        startedAt: null,
        endedAt: null,
      };

      db.insert(agentSessions).values(session).run();
      broadcastToRoom(roomId, createApprovalRequestedEvent(roomId, approval));

      const approvalMessage: Message = {
        id: createId("msg"),
        roomId,
        senderMemberId: target.id,
        messageType: "approval_request",
        content: `${target.displayName} is waiting for owner approval.`,
        replyToMessageId: message.id,
        createdAt: now(),
      };

      db.insert(messages).values(approvalMessage).run();
      broadcastToRoom(roomId, createMessageCreatedEvent(roomId, approvalMessage));
    }
  }

  return c.json(toPublicMessage(message), 201);
});

export { messageRoutes };
