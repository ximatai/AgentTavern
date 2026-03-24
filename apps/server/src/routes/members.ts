import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { Member, RealtimeEvent } from "@agent-tavern/shared";

import { db } from "../db/client";
import { members, rooms } from "../db/schema";
import { createId } from "../lib/id";
import { toPublicMember } from "../lib/public";
import { broadcastToRoom, verifyWsToken } from "../realtime";
import { isValidDisplayName, now } from "./support";

const memberRoutes = new Hono();

memberRoutes.get("/api/rooms/:roomId/members", (c) => {
  const roomId = c.req.param("roomId");
  const roomMembers = db
    .select()
    .from(members)
    .where(eq(members.roomId, roomId))
    .all()
    .map((member) => toPublicMember(member as Member));

  return c.json(roomMembers);
});

memberRoutes.post("/api/rooms/:roomId/members/agents", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const roleKind =
    body?.roleKind === "independent" || body?.roleKind === "assistant" ? body.roleKind : null;
  const ownerMemberId =
    typeof body?.ownerMemberId === "string" ? body.ownerMemberId.trim() : null;
  const adapterType = typeof body?.adapterType === "string" ? body.adapterType.trim() : "";
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

export { memberRoutes };
