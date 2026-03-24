import { eq, desc, and } from "drizzle-orm";
import { Hono } from "hono";

import type {
  AgentSession,
  Approval,
  Member,
  Message,
  RealtimeEvent,
  Room,
} from "@agent-tavern/shared";

import { db } from "./db/client";
import {
  agentSessions,
  approvals,
  members,
  mentions,
  messages,
  rooms,
} from "./db/schema";
import { createId, createInviteToken } from "./lib/id";
import { broadcastToRoom, issueWsToken } from "./realtime";

const app = new Hono();

function now(): string {
  return new Date().toISOString();
}

function extractMentionNames(content: string): string[] {
  return [...content.matchAll(/@([^\s@]+)/g)].map((match) => match[1] ?? "");
}

function createMessageCreatedEvent(roomId: string, message: Message): RealtimeEvent {
  return {
    type: "message.created",
    roomId,
    timestamp: now(),
    payload: { message },
  };
}

function createApprovalRequestedEvent(roomId: string, approval: Approval): RealtimeEvent {
  return {
    type: "approval.requested",
    roomId,
    timestamp: now(),
    payload: { approval },
  };
}

function createApprovalResolvedEvent(roomId: string, approval: Approval): RealtimeEvent {
  return {
    type: "approval.resolved",
    roomId,
    timestamp: now(),
    payload: { approval },
  };
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
    presenceStatus: "online",
    createdAt: now(),
  };

  db.insert(members).values(member).run();

  const wsToken = issueWsToken(member.id, roomId);

  const event: RealtimeEvent = {
    type: "member.joined",
    roomId,
    timestamp: now(),
    payload: { member },
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
    presenceStatus: "online",
    createdAt: now(),
  };

  db.insert(members).values(member).run();

  const wsToken = issueWsToken(member.id, room.id);

  const event: RealtimeEvent = {
    type: "member.joined",
    roomId: room.id,
    timestamp: now(),
    payload: { member },
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
    .all();

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

  if (!displayName || !roleKind) {
    return c.json({ error: "displayName and roleKind are required" }, 400);
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
    presenceStatus: "online",
    createdAt: now(),
  };

  db.insert(members).values(member).run();

  const event: RealtimeEvent = {
    type: "member.joined",
    roomId,
    timestamp: now(),
    payload: { member },
  };

  broadcastToRoom(roomId, event);

  return c.json(member, 201);
});

app.get("/api/rooms/:roomId/messages", (c) => {
  const roomId = c.req.param("roomId");
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .orderBy(desc(messages.createdAt))
    .all()
    .reverse();

  return c.json(roomMessages);
});

app.post("/api/rooms/:roomId/messages", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await c.req.json().catch(() => null);
  const senderMemberId =
    typeof body?.senderMemberId === "string" ? body.senderMemberId.trim() : "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";

  if (!senderMemberId || !content) {
    return c.json({ error: "senderMemberId and content are required" }, 400);
  }

  const sender = db
    .select()
    .from(members)
    .where(and(eq(members.id, senderMemberId), eq(members.roomId, roomId)))
    .get();

  if (!sender) {
    return c.json({ error: "sender not found in room" }, 404);
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
        status: "running" as const,
        startedAt: now(),
        endedAt: null,
      };

      db.insert(agentSessions).values(session).run();

      const systemMessage: Message = {
        id: createId("msg"),
        roomId,
        senderMemberId: target.id,
        messageType: "system_notice",
        content: `${target.displayName} received the request and is preparing a response.`,
        replyToMessageId: message.id,
        createdAt: now(),
      };

      db.insert(messages).values(systemMessage).run();
      broadcastToRoom(roomId, createMessageCreatedEvent(roomId, systemMessage));
    }

    if (target.type === "agent" && target.roleKind === "assistant") {
      if (!target.ownerMemberId) {
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

  return c.json(message, 201);
});

app.post("/api/approvals/:approvalId/approve", async (c) => {
  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";

  if (!actorMemberId) {
    return c.json({ error: "actorMemberId is required" }, 400);
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

  if (approval.status !== "pending") {
    return c.json({ error: "approval already resolved" }, 409);
  }

  const resolvedApproval: Approval = {
    ...approval,
    status: "approved",
    resolvedAt: now(),
  };

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
      status: "running",
      startedAt: now(),
    })
    .where(eq(agentSessions.approvalId, approval.id))
    .run();

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

  return c.json(resolvedApproval);
});

app.post("/api/approvals/:approvalId/reject", async (c) => {
  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";

  if (!actorMemberId) {
    return c.json({ error: "actorMemberId is required" }, 400);
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

  if (approval.status !== "pending") {
    return c.json({ error: "approval already resolved" }, 409);
  }

  const resolvedApproval: Approval = {
    ...approval,
    status: "rejected",
    resolvedAt: now(),
  };

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

  return c.json(resolvedApproval);
});

export { app };
