import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { Member, RealtimeEvent, Room } from "@agent-tavern/shared";

import { db } from "../db/client";
import { members, rooms } from "../db/schema";
import { createId, createInviteToken } from "../lib/id";
import { toPublicMember } from "../lib/public";
import { broadcastToRoom, issueWsToken } from "../realtime";
import { isUniqueConstraintError, isValidDisplayName, now } from "./support";

const roomRoutes = new Hono();

function createJoinEvent(roomId: string, member: Member): RealtimeEvent {
  return {
    type: "member.joined",
    roomId,
    timestamp: now(),
    payload: { member: toPublicMember(member) },
  };
}

function joinRoom(roomId: string, displayName: string) {
  const existing = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, roomId), eq(members.displayName, displayName)))
    .get();

  if (existing) {
    return { error: { error: "displayName already exists in room" }, status: 409 as const };
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

  try {
    db.insert(members).values(member).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { error: { error: "displayName already exists in room" }, status: 409 as const };
    }

    throw error;
  }

  const wsToken = issueWsToken(member.id, roomId);
  broadcastToRoom(roomId, createJoinEvent(roomId, member));

  return {
    payload: {
      memberId: member.id,
      roomId: member.roomId,
      displayName: member.displayName,
      wsToken,
    },
  };
}

roomRoutes.post("/api/rooms", async (c) => {
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

roomRoutes.get("/api/rooms/:roomId", (c) => {
  const room = db.select().from(rooms).where(eq(rooms.id, c.req.param("roomId"))).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  return c.json(room);
});

roomRoutes.get("/api/invites/:inviteToken", (c) => {
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

roomRoutes.post("/api/rooms/:roomId/join", async (c) => {
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

  const result = joinRoom(roomId, displayName);

  if ("error" in result) {
    return c.json(result.error, result.status);
  }

  return c.json(result.payload);
});

roomRoutes.post("/api/invites/:inviteToken/join", async (c) => {
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

  const result = joinRoom(room.id, displayName);

  if ("error" in result) {
    return c.json(result.error, result.status);
  }

  return c.json(result.payload);
});

export { roomRoutes };
