import { eq } from "drizzle-orm";
import { Hono } from "hono";

import type { Approval, Message } from "@agent-tavern/shared";

import { queueAgentSession } from "../agents/runtime";
import { db } from "../db/client";
import { agentSessions, approvals, messages } from "../db/schema";
import { createId } from "../lib/id";
import { toPublicApproval } from "../lib/public";
import { broadcastToRoom, verifyWsToken } from "../realtime";
import {
  clearApprovalTimeout,
  createApprovalResolvedEvent,
  createMessageCreatedEvent,
  markMentionStatus,
  now,
} from "./support";

const approvalRoutes = new Hono();

approvalRoutes.post("/api/approvals/:approvalId/approve", async (c) => {
  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";

  if (!actorMemberId || !wsToken) {
    return c.json({ error: "actorMemberId and wsToken are required" }, 400);
  }

  const approval = db
    .select()
    .from(approvals)
    .where(eq(approvals.id, c.req.param("approvalId")))
    .get();

  if (!approval) {
    return c.json({ error: "approval not found" }, 404);
  }

  if (approval.ownerMemberId !== actorMemberId) {
    return c.json({ error: "only owner can approve" }, 403);
  }

  if (!verifyWsToken(wsToken, actorMemberId, approval.roomId)) {
    return c.json({ error: "invalid wsToken for actor" }, 403);
  }

  if (approval.status !== "pending") {
    return c.json({ error: "approval already resolved" }, 409);
  }

  const resolvedApproval: Approval = {
    ...approval,
    status: "approved",
    resolvedAt: now(),
  };
  clearApprovalTimeout(approval.id);

  db
    .update(approvals)
    .set({
      status: resolvedApproval.status,
      resolvedAt: resolvedApproval.resolvedAt,
    })
    .where(eq(approvals.id, approval.id))
    .run();

  db
    .update(agentSessions)
    .set({
      status: "pending",
      startedAt: null,
    })
    .where(eq(agentSessions.approvalId, approval.id))
    .run();

  markMentionStatus({
    messageId: approval.triggerMessageId,
    targetMemberId: approval.agentMemberId,
    status: "approved",
  });

  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.approvalId, approval.id))
    .get();

  broadcastToRoom(approval.roomId, createApprovalResolvedEvent(approval.roomId, resolvedApproval));

  const approvalMessage: Message = {
    id: createId("msg"),
    roomId: approval.roomId,
    senderMemberId: approval.agentMemberId,
    messageType: "approval_result",
    content: `Approval granted for ${approval.agentMemberId}.`,
    replyToMessageId: approval.triggerMessageId,
    createdAt: now(),
  };

  db.insert(messages).values(approvalMessage).run();
  broadcastToRoom(approval.roomId, createMessageCreatedEvent(approval.roomId, approvalMessage));

  if (session) {
    queueAgentSession(session.id);
  }

  return c.json(toPublicApproval(resolvedApproval));
});

approvalRoutes.post("/api/approvals/:approvalId/reject", async (c) => {
  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";

  if (!actorMemberId || !wsToken) {
    return c.json({ error: "actorMemberId and wsToken are required" }, 400);
  }

  const approval = db
    .select()
    .from(approvals)
    .where(eq(approvals.id, c.req.param("approvalId")))
    .get();

  if (!approval) {
    return c.json({ error: "approval not found" }, 404);
  }

  if (approval.ownerMemberId !== actorMemberId) {
    return c.json({ error: "only owner can reject" }, 403);
  }

  if (!verifyWsToken(wsToken, actorMemberId, approval.roomId)) {
    return c.json({ error: "invalid wsToken for actor" }, 403);
  }

  if (approval.status !== "pending") {
    return c.json({ error: "approval already resolved" }, 409);
  }

  const resolvedApproval: Approval = {
    ...approval,
    status: "rejected",
    resolvedAt: now(),
  };
  clearApprovalTimeout(approval.id);

  db
    .update(approvals)
    .set({
      status: resolvedApproval.status,
      resolvedAt: resolvedApproval.resolvedAt,
    })
    .where(eq(approvals.id, approval.id))
    .run();

  db
    .update(agentSessions)
    .set({
      status: "rejected",
      endedAt: now(),
    })
    .where(eq(agentSessions.approvalId, approval.id))
    .run();

  markMentionStatus({
    messageId: approval.triggerMessageId,
    targetMemberId: approval.agentMemberId,
    status: "rejected",
  });

  broadcastToRoom(approval.roomId, createApprovalResolvedEvent(approval.roomId, resolvedApproval));

  const rejectionMessage: Message = {
    id: createId("msg"),
    roomId: approval.roomId,
    senderMemberId: approval.agentMemberId,
    messageType: "approval_result",
    content: `Approval rejected for ${approval.agentMemberId}.`,
    replyToMessageId: approval.triggerMessageId,
    createdAt: now(),
  };

  db.insert(messages).values(rejectionMessage).run();
  broadcastToRoom(approval.roomId, createMessageCreatedEvent(approval.roomId, rejectionMessage));

  return c.json(toPublicApproval(resolvedApproval));
});

export { approvalRoutes };
