import { eq, desc, and } from "drizzle-orm";
import { Hono } from "hono";

import type {
  AgentBinding,
  AgentBackendType,
  AgentSession,
  Approval,
  AssistantInvite,
  Member,
  Message,
  RealtimeEvent,
  Room,
} from "@agent-tavern/shared";

import { queueAgentSession } from "./agents/runtime";
import { db } from "./db/client";
import {
  agentBindings,
  agentSessions,
  approvals,
  assistantInvites,
  members,
  mentions,
  messages,
  rooms,
} from "./db/schema";
import { createId, createInviteToken } from "./lib/id";
import { toPublicApproval, toPublicMember, toPublicMessage } from "./lib/public";
import {
  broadcastToRoom,
  isMemberOnline,
  issueWsToken,
  verifyWsToken,
} from "./realtime";

const app = new Hono();
const approvalTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const APPROVAL_TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS ?? 30_000);
const ASSISTANT_INVITE_TTL_MS = Number(process.env.ASSISTANT_INVITE_TTL_MS ?? 10 * 60_000);

function now(): string {
  return new Date().toISOString();
}

function extractMentionNames(content: string): string[] {
  return [...content.matchAll(/@([^\s@]+)/g)].map((match) => match[1] ?? "");
}

function isValidDisplayName(displayName: string): boolean {
  return /^[^\s@]+$/u.test(displayName);
}

function isSupportedAgentBackendType(value: unknown): value is AgentBackendType {
  return value === "local_process" || value === "codex_cli";
}

function resolveInviteExpiry(): string {
  return new Date(Date.now() + ASSISTANT_INVITE_TTL_MS).toISOString();
}

function createMessageCreatedEvent(roomId: string, message: Message): RealtimeEvent {
  return {
    type: "message.created",
    roomId,
    timestamp: now(),
    payload: { message: toPublicMessage(message) },
  };
}

function createApprovalRequestedEvent(roomId: string, approval: Approval): RealtimeEvent {
  return {
    type: "approval.requested",
    roomId,
    timestamp: now(),
    payload: { approval: toPublicApproval(approval) },
  };
}

function createApprovalResolvedEvent(roomId: string, approval: Approval): RealtimeEvent {
  return {
    type: "approval.resolved",
    roomId,
    timestamp: now(),
    payload: { approval: toPublicApproval(approval) },
  };
}

function clearApprovalTimeout(approvalId: string): void {
  const timeout = approvalTimeouts.get(approvalId);

  if (timeout) {
    clearTimeout(timeout);
    approvalTimeouts.delete(approvalId);
  }
}

function scheduleApprovalTimeout(approval: Approval): void {
  clearApprovalTimeout(approval.id);

  const timeout = setTimeout(() => {
    const current = db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .get();

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

    broadcastToRoom(current.roomId, createApprovalResolvedEvent(current.roomId, expiredApproval));

    const timeoutMessage: Message = {
      id: createId("msg"),
      roomId: current.roomId,
      senderMemberId: current.agentMemberId,
      messageType: "approval_result",
      content: "Approval request timed out.",
      replyToMessageId: current.triggerMessageId,
      createdAt: resolvedAt,
    };

    db.insert(messages).values(timeoutMessage).run();
    broadcastToRoom(current.roomId, createMessageCreatedEvent(current.roomId, timeoutMessage));
    approvalTimeouts.delete(current.id);
  }, APPROVAL_TIMEOUT_MS);

  approvalTimeouts.set(approval.id, timeout);
}

app.get("/healthz", (c) => {
  return c.json({
    ok: true,
    service: "agent-tavern-server",
  });
});

app.get("/", (c) => {
  return c.json({
    name: "AgentTavern",
    status: "bootstrapped",
  });
});

app.post("/api/rooms/:roomId/assistant-invites", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";
  const presetDisplayName =
    typeof body?.presetDisplayName === "string" ? body.presetDisplayName.trim() : "";
  const backendType = isSupportedAgentBackendType(body?.backendType)
    ? body.backendType
    : null;

  if (!actorMemberId || !wsToken || !backendType) {
    return c.json({ error: "actorMemberId, wsToken and backendType are required" }, 400);
  }

  if (presetDisplayName && !isValidDisplayName(presetDisplayName)) {
    return c.json({ error: "presetDisplayName must not contain spaces or @" }, 400);
  }

  const actor = db
    .select()
    .from(members)
    .where(and(eq(members.id, actorMemberId), eq(members.roomId, roomId)))
    .get();

  if (!actor) {
    return c.json({ error: "actor not found in room" }, 404);
  }

  if (!verifyWsToken(wsToken, actorMemberId, roomId)) {
    return c.json({ error: "invalid wsToken for actor" }, 403);
  }

  const invite: AssistantInvite = {
    id: createId("ain"),
    roomId,
    ownerMemberId: actorMemberId,
    presetDisplayName: presetDisplayName || null,
    backendType,
    inviteToken: createInviteToken(),
    status: "pending",
    acceptedMemberId: null,
    createdAt: now(),
    expiresAt: resolveInviteExpiry(),
    acceptedAt: null,
  };

  db.insert(assistantInvites).values(invite).run();

  return c.json({
    id: invite.id,
    roomId: invite.roomId,
    ownerMemberId: invite.ownerMemberId,
    presetDisplayName: invite.presetDisplayName,
    backendType: invite.backendType,
    inviteToken: invite.inviteToken,
    inviteUrl: `/assistant-invites/${invite.inviteToken}`,
    status: invite.status,
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  }, 201);
});

app.post("/api/assistant-invites/:inviteToken/accept", async (c) => {
  const inviteToken = c.req.param("inviteToken");
  const invite = db
    .select()
    .from(assistantInvites)
    .where(eq(assistantInvites.inviteToken, inviteToken))
    .get();

  if (!invite) {
    return c.json({ error: "assistant invite not found" }, 404);
  }

  if (invite.status !== "pending") {
    return c.json({ error: "assistant invite already resolved" }, 409);
  }

  if (!isSupportedAgentBackendType(invite.backendType)) {
    return c.json({ error: "assistant invite backendType is invalid" }, 500);
  }

  const inviteBackendType: AgentBackendType = invite.backendType;

  if (invite.expiresAt && invite.expiresAt <= now()) {
    db
      .update(assistantInvites)
      .set({ status: "expired" })
      .where(eq(assistantInvites.id, invite.id))
      .run();
    return c.json({ error: "assistant invite expired" }, 410);
  }

  const body = await c.req.json().catch(() => null);
  const backendThreadId =
    typeof body?.backendThreadId === "string" ? body.backendThreadId.trim() : "";
  const requestedDisplayName =
    typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const cwd = typeof body?.cwd === "string" ? body.cwd.trim() : "";

  if (!backendThreadId) {
    return c.json({ error: "backendThreadId is required" }, 400);
  }

  const displayName = invite.presetDisplayName ?? requestedDisplayName;

  if (!displayName) {
    return c.json({ error: "displayName is required when invite has no presetDisplayName" }, 400);
  }

  if (!isValidDisplayName(displayName)) {
    return c.json({ error: "displayName must not contain spaces or @" }, 400);
  }

  const bindingConflict = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.backendThreadId, backendThreadId))
    .get();

  if (bindingConflict) {
    return c.json({ error: "backendThreadId already bound" }, 409);
  }

  const displayNameConflict = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, invite.roomId), eq(members.displayName, displayName)))
    .get();

  if (displayNameConflict) {
    return c.json({ error: "displayName already exists in room" }, 409);
  }

  const member: Member = {
    id: createId("mem"),
    roomId: invite.roomId,
    type: "agent",
    roleKind: "assistant",
    displayName,
    ownerMemberId: invite.ownerMemberId,
    adapterType: inviteBackendType,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt: now(),
  };

  db.insert(members).values(member).run();

  const binding: AgentBinding = {
    id: createId("agb"),
    memberId: member.id,
    backendType: inviteBackendType,
    backendThreadId,
    cwd: cwd || null,
    status: "active",
    attachedAt: now(),
    detachedAt: null,
  };

  db.insert(agentBindings).values(binding).run();

  db
    .update(assistantInvites)
    .set({
      status: "accepted",
      acceptedMemberId: member.id,
      acceptedAt: now(),
    })
    .where(eq(assistantInvites.id, invite.id))
    .run();

  const event: RealtimeEvent = {
    type: "member.joined",
    roomId: member.roomId,
    timestamp: now(),
    payload: { member: toPublicMember(member) },
  };

  broadcastToRoom(member.roomId, event);

  return c.json({
    memberId: member.id,
    roomId: member.roomId,
    displayName: member.displayName,
    ownerMemberId: member.ownerMemberId,
  }, 201);
});

app.post("/api/rooms", async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  if (!name) {
    return c.json({ error: "room name is required" }, 400);
  }

  const room: Room = {
    id: createId("room"),
    name,
    inviteToken: createInviteToken(),
    status: "active",
    createdAt: now(),
  };

  db.insert(rooms).values(room).run();

  return c.json({
    id: room.id,
    name: room.name,
    inviteToken: room.inviteToken,
    inviteUrl: `/join/${room.inviteToken}`,
  });
});

app.get("/api/rooms/:roomId", (c) => {
  const room = db
    .select()
    .from(rooms)
    .where(eq(rooms.id, c.req.param("roomId")))
    .get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  return c.json(room);
});

app.get("/api/invites/:inviteToken", (c) => {
  const room = db
    .select()
    .from(rooms)
    .where(eq(rooms.inviteToken, c.req.param("inviteToken")))
    .get();

  if (!room) {
    return c.json({ error: "invite not found" }, 404);
  }

  return c.json({
    id: room.id,
    name: room.name,
    inviteToken: room.inviteToken,
    inviteUrl: `/join/${room.inviteToken}`,
  });
});

app.post("/api/rooms/:roomId/join", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const displayName = typeof body?.nickname === "string" ? body.nickname.trim() : "";

  if (!displayName) {
    return c.json({ error: "nickname is required" }, 400);
  }

  if (!isValidDisplayName(displayName)) {
    return c.json({ error: "displayName must not contain spaces or @" }, 400);
  }

  const existing = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, roomId), eq(members.displayName, displayName)))
    .get();

  if (existing) {
    return c.json({ error: "displayName already exists in room" }, 409);
  }

  const member: Member = {
    id: createId("mem"),
    roomId,
    type: "human",
    roleKind: "none",
    displayName,
    ownerMemberId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt: now(),
  };

  db.insert(members).values(member).run();

  const wsToken = issueWsToken(member.id, roomId);

  const event: RealtimeEvent = {
    type: "member.joined",
    roomId,
    timestamp: now(),
    payload: { member: toPublicMember(member) },
  };

  broadcastToRoom(roomId, event);

  return c.json({
    memberId: member.id,
    roomId: member.roomId,
    displayName: member.displayName,
    wsToken,
  });
});

app.post("/api/invites/:inviteToken/join", async (c) => {
  const room = db
    .select()
    .from(rooms)
    .where(eq(rooms.inviteToken, c.req.param("inviteToken")))
    .get();

  if (!room) {
    return c.json({ error: "invite not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const displayName = typeof body?.nickname === "string" ? body.nickname.trim() : "";

  if (!displayName) {
    return c.json({ error: "nickname is required" }, 400);
  }

  if (!isValidDisplayName(displayName)) {
    return c.json({ error: "displayName must not contain spaces or @" }, 400);
  }

  const existing = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, room.id), eq(members.displayName, displayName)))
    .get();

  if (existing) {
    return c.json({ error: "displayName already exists in room" }, 409);
  }

  const member: Member = {
    id: createId("mem"),
    roomId: room.id,
    type: "human",
    roleKind: "none",
    displayName,
    ownerMemberId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt: now(),
  };

  db.insert(members).values(member).run();

  const wsToken = issueWsToken(member.id, room.id);

  const event: RealtimeEvent = {
    type: "member.joined",
    roomId: room.id,
    timestamp: now(),
    payload: { member: toPublicMember(member) },
  };

  broadcastToRoom(room.id, event);

  return c.json({
    memberId: member.id,
    roomId: member.roomId,
    displayName: member.displayName,
    wsToken,
  });
});

app.get("/api/rooms/:roomId/members", (c) => {
  const roomId = c.req.param("roomId");
  const roomMembers = db
    .select()
    .from(members)
    .where(eq(members.roomId, roomId))
    .all()
    .map((member) => toPublicMember(member as Member));

  return c.json(roomMembers);
});

app.post("/api/rooms/:roomId/members/agents", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const displayName =
    typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const roleKind =
    body?.roleKind === "independent" || body?.roleKind === "assistant"
      ? body.roleKind
      : null;
  const ownerMemberId =
    typeof body?.ownerMemberId === "string" ? body.ownerMemberId.trim() : null;
  const adapterType =
    typeof body?.adapterType === "string" ? body.adapterType.trim() : "";
  const adapterConfig =
    body?.adapterConfig && typeof body.adapterConfig === "object" && !Array.isArray(body.adapterConfig)
      ? JSON.stringify(body.adapterConfig)
      : null;
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";

  if (!displayName || !roleKind) {
    return c.json({ error: "displayName and roleKind are required" }, 400);
  }

  if (!actorMemberId || !wsToken) {
    return c.json({ error: "actorMemberId and wsToken are required" }, 400);
  }

  if (!adapterType) {
    return c.json({ error: "adapterType is required" }, 400);
  }

  if (!isValidDisplayName(displayName)) {
    return c.json({ error: "displayName must not contain spaces or @" }, 400);
  }

  if (adapterType !== "local_process") {
    return c.json({ error: "unsupported adapterType" }, 400);
  }

  if (!adapterConfig) {
    return c.json({ error: "adapterConfig is required" }, 400);
  }

  const actor = db
    .select()
    .from(members)
    .where(and(eq(members.id, actorMemberId), eq(members.roomId, roomId)))
    .get();

  if (!actor) {
    return c.json({ error: "actor not found in room" }, 404);
  }

  if (!verifyWsToken(wsToken, actorMemberId, roomId)) {
    return c.json({ error: "invalid wsToken for actor" }, 403);
  }

  const existing = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, roomId), eq(members.displayName, displayName)))
    .get();

  if (existing) {
    return c.json({ error: "displayName already exists in room" }, 409);
  }

  if (roleKind === "assistant" && !ownerMemberId) {
    return c.json({ error: "assistant agent requires ownerMemberId" }, 400);
  }

  if (roleKind === "independent" && ownerMemberId) {
    return c.json({ error: "independent agent cannot have ownerMemberId" }, 400);
  }

  if (ownerMemberId) {
    const owner = db
      .select()
      .from(members)
      .where(and(eq(members.id, ownerMemberId), eq(members.roomId, roomId)))
      .get();

    if (!owner) {
      return c.json({ error: "owner member not found in room" }, 404);
    }
  }

  const member: Member = {
    id: createId("mem"),
    roomId,
    type: "agent",
    roleKind,
    displayName,
    ownerMemberId,
    adapterType,
    adapterConfig,
    presenceStatus: "online",
    createdAt: now(),
  };

  db.insert(members).values(member).run();

  const event: RealtimeEvent = {
    type: "member.joined",
    roomId,
    timestamp: now(),
    payload: { member: toPublicMember(member) },
  };

  broadcastToRoom(roomId, event);

  return c.json(toPublicMember(member), 201);
});

app.get("/api/rooms/:roomId/messages", (c) => {
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

app.post("/api/rooms/:roomId/messages", async (c) => {
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

app.post("/api/approvals/:approvalId/approve", async (c) => {
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

app.post("/api/approvals/:approvalId/reject", async (c) => {
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

export { app };
