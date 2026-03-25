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
  isApprovalGrantDuration,
  markMentionStatus,
  now,
  upsertAuthorization,
} from "./support";

const approvalRoutes = new Hono();

approvalRoutes.post("/api/approvals/:approvalId/approve", async (c) => {
  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";
  const grantDurationProvided = Object.prototype.hasOwnProperty.call(body ?? {}, "grantDuration");
  const grantDuration = grantDurationProvided
    ? body?.grantDuration
    : "once";

  if (!actorMemberId || !wsToken) {
    return c.json({ error: "actorMemberId and wsToken are required" }, 400);
  }

  if (!isApprovalGrantDuration(grantDuration)) {
    return c.json({ error: "invalid grantDuration" }, 400);
  }

  const approval = db
    .select()
    .from(approvals)
    .where(eq(approvals.id, c.req.param("approvalId")))
    .get() as Approval | undefined;

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
    grantDuration,
    resolvedAt: now(),
  };
  clearApprovalTimeout(approval.id);

  db
    .update(approvals)
    .set({
      status: resolvedApproval.status,
      grantDuration: resolvedApproval.grantDuration,
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

  upsertAuthorization({
    roomId: approval.roomId,
    ownerMemberId: approval.ownerMemberId,
    requesterMemberId: approval.requesterMemberId,
    agentMemberId: approval.agentMemberId,
    grantDuration,
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
    content: `Approval granted for ${approval.agentMemberId} (${grantDuration}).`,
    attachments: [],
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
    .get() as Approval | undefined;

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
    attachments: [],
    replyToMessageId: approval.triggerMessageId,
    createdAt: now(),
  };

  db.insert(messages).values(rejectionMessage).run();
  broadcastToRoom(approval.roomId, createMessageCreatedEvent(approval.roomId, rejectionMessage));

  return c.json(toPublicApproval(resolvedApproval));
});

export { approvalRoutes };
