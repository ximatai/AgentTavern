import { and, eq, gt, isNull } from "drizzle-orm";

import type {
  AgentBackendType,
  AgentAuthorization,
  ApprovalGrantDuration,
  Approval,
  AssistantInvite,
  Message,
  RealtimeEvent,
} from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentAuthorizations, agentSessions, approvals, mentions, messages } from "../db/schema";
import { createId } from "../lib/id";
import { toPublicApproval, toPublicMessage } from "../lib/public";
import { broadcastToRoom } from "../realtime";

const approvalTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 30_000);
const ASSISTANT_INVITE_TTL_MS = Number(process.env.ASSISTANT_INVITE_TTL_MS ?? 10 * 60_000);

export function now(): string {
  return new Date().toISOString();
}

export function extractMentionNames(content: string): string[] {
  return [...content.matchAll(/@([^\s@]+)/g)].map((match) => match[1] ?? "");
}

export function isValidDisplayName(displayName: string): boolean {
  return /^[^\s@]+$/u.test(displayName);
}

export function isSupportedAgentBackendType(value: unknown): value is AgentBackendType {
  return value === "local_process" || value === "codex_cli";
}

export function isApprovalGrantDuration(value: unknown): value is ApprovalGrantDuration {
  return (
    value === "once" ||
    value === "10_minutes" ||
    value === "30_minutes" ||
    value === "1_hour" ||
    value === "forever"
  );
}

export function resolveAuthorizationExpiry(
  grantDuration: ApprovalGrantDuration,
  issuedAt = Date.now(),
): string | null {
  const ttlMs =
    grantDuration === "10_minutes"
      ? 10 * 60_000
      : grantDuration === "30_minutes"
        ? 30 * 60_000
        : grantDuration === "1_hour"
          ? 60 * 60_000
          : null;

  return ttlMs ? new Date(issuedAt + ttlMs).toISOString() : null;
}

export function findActiveAuthorization(params: {
  roomId: string;
  ownerMemberId: string;
  requesterMemberId: string;
  agentMemberId: string;
}): AgentAuthorization | null {
  const authorization = db
    .select()
    .from(agentAuthorizations)
    .where(
      and(
        eq(agentAuthorizations.roomId, params.roomId),
        eq(agentAuthorizations.ownerMemberId, params.ownerMemberId),
        eq(agentAuthorizations.requesterMemberId, params.requesterMemberId),
        eq(agentAuthorizations.agentMemberId, params.agentMemberId),
        isNull(agentAuthorizations.revokedAt),
      ),
    )
    .get();

  if (!authorization) {
    return null;
  }

  if (authorization.expiresAt && new Date(authorization.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  if (authorization.remainingUses !== null && authorization.remainingUses <= 0) {
    return null;
  }

  return authorization as AgentAuthorization;
}

export function upsertAuthorization(params: {
  roomId: string;
  ownerMemberId: string;
  requesterMemberId: string;
  agentMemberId: string;
  grantDuration: ApprovalGrantDuration;
}): AgentAuthorization {
  const timestamp = now();
  const expiresAt = resolveAuthorizationExpiry(params.grantDuration);
  const remainingUses = params.grantDuration === "once" ? 1 : null;
  const existing = db
    .select()
    .from(agentAuthorizations)
    .where(
      and(
        eq(agentAuthorizations.roomId, params.roomId),
        eq(agentAuthorizations.ownerMemberId, params.ownerMemberId),
        eq(agentAuthorizations.requesterMemberId, params.requesterMemberId),
        eq(agentAuthorizations.agentMemberId, params.agentMemberId),
        isNull(agentAuthorizations.revokedAt),
      ),
    )
    .get();

  if (existing) {
    db
      .update(agentAuthorizations)
      .set({
        grantDuration: params.grantDuration,
        remainingUses,
        expiresAt,
        updatedAt: timestamp,
      })
      .where(eq(agentAuthorizations.id, existing.id))
      .run();

    return {
      ...(existing as AgentAuthorization),
      grantDuration: params.grantDuration,
      remainingUses,
      expiresAt,
      updatedAt: timestamp,
    };
  }

  const authorization: AgentAuthorization = {
    id: createId("aut"),
    roomId: params.roomId,
    ownerMemberId: params.ownerMemberId,
    requesterMemberId: params.requesterMemberId,
    agentMemberId: params.agentMemberId,
    grantDuration: params.grantDuration,
    remainingUses,
    expiresAt,
    revokedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  db.insert(agentAuthorizations).values(authorization).run();
  return authorization;
}

export function consumeAuthorization(authorization: AgentAuthorization): AgentAuthorization | null {
  if (authorization.remainingUses === null) {
    return authorization;
  }

  const revokedAt = now();

  const result = db
    .update(agentAuthorizations)
    .set({
      remainingUses: 0,
      revokedAt,
      updatedAt: revokedAt,
    })
    .where(
      and(
        eq(agentAuthorizations.id, authorization.id),
        isNull(agentAuthorizations.revokedAt),
        gt(agentAuthorizations.remainingUses, 0),
      ),
    )
    .run();

  return result.changes > 0
    ? {
        ...authorization,
        remainingUses: 0,
        revokedAt,
        updatedAt: revokedAt,
      }
    : null;
}

export function resolveInviteExpiry(): string {
  return new Date(Date.now() + ASSISTANT_INVITE_TTL_MS).toISOString();
}

export function createMessageCreatedEvent(roomId: string, message: Message): RealtimeEvent {
  return {
    type: "message.created",
    roomId,
    timestamp: now(),
    payload: { message: toPublicMessage(message) },
  };
}

export function createApprovalRequestedEvent(roomId: string, approval: Approval): RealtimeEvent {
  return {
    type: "approval.requested",
    roomId,
    timestamp: now(),
    payload: { approval: toPublicApproval(approval) },
  };
}

export function createApprovalResolvedEvent(roomId: string, approval: Approval): RealtimeEvent {
  return {
    type: "approval.resolved",
    roomId,
    timestamp: now(),
    payload: { approval: toPublicApproval(approval) },
  };
}

export function clearApprovalTimeout(approvalId: string): void {
  const timeout = approvalTimeouts.get(approvalId);

  if (timeout) {
    clearTimeout(timeout);
    approvalTimeouts.delete(approvalId);
  }
}

export function scheduleApprovalTimeout(approval: Approval): void {
  clearApprovalTimeout(approval.id);

  const timeout = setTimeout(() => {
    const current = db.select().from(approvals).where(eq(approvals.id, approval.id)).get() as Approval | undefined;

    if (!current || current.status !== "pending") {
      approvalTimeouts.delete(approval.id);
      return;
    }

    const resolvedAt = now();
    const expiredApproval: Approval = {
      ...current,
      status: "expired",
      resolvedAt,
    };

    db
      .update(approvals)
      .set({
        status: expiredApproval.status,
        resolvedAt: expiredApproval.resolvedAt,
      })
      .where(eq(approvals.id, current.id))
      .run();

    db
      .update(agentSessions)
      .set({
        status: "rejected",
        endedAt: resolvedAt,
      })
      .where(eq(agentSessions.approvalId, current.id))
      .run();

    db
      .update(mentions)
      .set({ status: "expired" })
      .where(and(eq(mentions.messageId, current.triggerMessageId), eq(mentions.targetMemberId, current.agentMemberId)))
      .run();

    broadcastToRoom(current.roomId, createApprovalResolvedEvent(current.roomId, expiredApproval));

    const timeoutMessage: Message = {
      id: createId("msg"),
      roomId: current.roomId,
      senderMemberId: current.agentMemberId,
      messageType: "approval_result",
      content: "Approval request timed out.",
      attachments: [],
      replyToMessageId: current.triggerMessageId,
      createdAt: resolvedAt,
    };

    db.insert(messages).values(timeoutMessage).run();
    broadcastToRoom(current.roomId, createMessageCreatedEvent(current.roomId, timeoutMessage));
    approvalTimeouts.delete(current.id);
  }, APPROVAL_TIMEOUT_MS);

  approvalTimeouts.set(approval.id, timeout);
}

export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique/i.test(error.message);
}

export function markMentionStatus(params: {
  messageId: string;
  targetMemberId: string;
  status: string;
}): void {
  db
    .update(mentions)
    .set({ status: params.status })
    .where(
      and(
        eq(mentions.messageId, params.messageId),
        eq(mentions.targetMemberId, params.targetMemberId),
      ),
    )
    .run();
}
