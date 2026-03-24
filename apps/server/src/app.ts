import { eq, desc, and } from "drizzle-orm";
import { Hono } from "hono";

import type { Member, Message, RealtimeEvent, Room } from "@agent-tavern/shared";

import { db } from "./db/client";
import { members, messages, rooms } from "./db/schema";
import { createId, createInviteToken } from "./lib/id";
import { broadcastToRoom, issueWsToken } from "./realtime";

const app = new Hono();

function now(): string {
  return new Date().toISOString();
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

  const event: RealtimeEvent = {
    type: "message.created",
    roomId,
    timestamp: now(),
    payload: { message },
  };

  broadcastToRoom(roomId, event);

  return c.json(message, 201);
});

export { app };
