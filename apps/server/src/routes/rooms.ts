import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { AgentBinding, Member, Principal, Room, RoomSecretaryMode } from "@agent-tavern/shared";

import { db } from "../db/client";
import { members, principals, rooms } from "../db/schema";
import { createId, createInviteToken } from "../lib/id";
import { resolveBindingForPrincipal } from "../lib/agent-binding-resolution";
import { resolveMemberRuntimeStatus } from "../lib/member-runtime";
import { toPublicMember } from "../lib/public";
import { getRoomSummary } from "../lib/room-summary";
import {
  broadcastToPrincipal,
  broadcastToRoom,
  issueWsToken,
  revokeWsTokensForMember,
  verifyPrincipalToken,
  verifyWsToken,
} from "../realtime";
import { isUniqueConstraintError, isValidDisplayName, now } from "./support";

const roomRoutes = new Hono();

function buildDirectRoomName(actor: Principal, peer: Principal): string {
  return `${actor.globalDisplayName} · ${peer.globalDisplayName}`;
}

function resolveDisplayName(params: {
  principal: Principal | null;
  roomDisplayName: string | null;
  nickname: string | null;
}) {
  return params.roomDisplayName || params.principal?.globalDisplayName || params.nickname || "";
}

function joinRoom(params: {
  roomId: string;
  principal: Principal | null;
  displayName: string;
}) {
  if (params.principal) {
    const existingByPrincipal = db
      .select()
      .from(members)
      .where(and(eq(members.roomId, params.roomId), eq(members.principalId, params.principal.id)))
      .get() as Member | undefined;

    if (existingByPrincipal && (existingByPrincipal.membershipStatus ?? "active") === "left") {
      const conflictingActiveMember = db
        .select()
        .from(members)
        .where(and(eq(members.roomId, params.roomId), eq(members.displayName, params.displayName)))
        .get() as Member | undefined;

      if (
        conflictingActiveMember &&
        conflictingActiveMember.id !== existingByPrincipal.id &&
        (conflictingActiveMember.membershipStatus ?? "active") === "active"
      ) {
        return { error: { error: "displayName already exists in room" }, status: 409 as const };
      }

      db
        .update(members)
        .set({
          displayName: params.displayName,
          presenceStatus: "online",
          membershipStatus: "active",
          leftAt: null,
        })
        .where(eq(members.id, existingByPrincipal.id))
        .run();

      const restoredMember = db
        .select()
        .from(members)
        .where(eq(members.id, existingByPrincipal.id))
        .get() as Member;
      const wsToken = issueWsToken(restoredMember.id, params.roomId);
      const binding = params.principal.kind === "agent"
        ? resolveBindingForPrincipal(params.principal.id)
        : null;
      const runtimeStatus = resolveMemberRuntimeStatus(restoredMember, binding, null);
      broadcastToRoom(params.roomId, {
        type: "member.joined",
        roomId: params.roomId,
        timestamp: now(),
        payload: { member: toPublicMember(restoredMember, runtimeStatus) },
      });

      return {
        payload: {
          memberId: restoredMember.id,
          roomId: restoredMember.roomId,
          displayName: restoredMember.displayName,
          wsToken,
        },
      };
    }

    if (existingByPrincipal) {
      const wsToken = issueWsToken(existingByPrincipal.id, params.roomId);

      return {
        payload: {
          memberId: existingByPrincipal.id,
          roomId: existingByPrincipal.roomId,
          displayName: existingByPrincipal.displayName,
          wsToken,
        },
      };
    }
  }

  const existing = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, params.roomId), eq(members.displayName, params.displayName)))
    .get() as Member | undefined;

  if (existing && (existing.membershipStatus ?? "active") === "active") {
    return { error: { error: "displayName already exists in room" }, status: 409 as const };
  }

  const member: Member = {
    id: createId("mem"),
    roomId: params.roomId,
    principalId: params.principal?.id ?? null,
    type: params.principal?.kind === "agent" ? "agent" : "human",
    roleKind: params.principal?.kind === "agent" ? "independent" : "none",
    displayName: params.displayName,
    ownerMemberId: null,
    sourcePrivateAssistantId: null,
    adapterType: params.principal?.kind === "agent" ? (params.principal.backendType ?? "codex_cli") : null,
    adapterConfig: null,
    presenceStatus: "online",
    membershipStatus: "active",
    leftAt: null,
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

  const wsToken = issueWsToken(member.id, params.roomId);
  const binding = params.principal?.kind === "agent"
    ? resolveBindingForPrincipal(params.principal.id)
    : null;
  const runtimeStatus = resolveMemberRuntimeStatus(member, binding, null);
  broadcastToRoom(params.roomId, {
    type: "member.joined",
    roomId: params.roomId,
    timestamp: now(),
    payload: { member: toPublicMember(member, runtimeStatus) },
  });

  return {
    payload: {
      memberId: member.id,
      roomId: member.roomId,
      displayName: member.displayName,
      wsToken,
    },
  };
}

function leaveRoomByPrincipal(params: {
  roomId: string;
  principal: Principal;
}) {
  const existingMembership = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, params.roomId), eq(members.principalId, params.principal.id)))
    .get() as Member | undefined;

  if (!existingMembership || (existingMembership.membershipStatus ?? "active") !== "active") {
    return {
      payload: {
        left: false,
        roomId: params.roomId,
        principalId: params.principal.id,
        memberId: null,
      },
    };
  }

  db
    .update(members)
    .set({
      presenceStatus: "offline",
      membershipStatus: "left",
      leftAt: now(),
    })
    .where(eq(members.id, existingMembership.id))
    .run();
  revokeWsTokensForMember(existingMembership.id, params.roomId);
  broadcastToRoom(params.roomId, {
    type: "member.left",
    roomId: params.roomId,
    timestamp: now(),
    payload: { memberId: existingMembership.id },
  });

  return {
    payload: {
      left: true,
      roomId: params.roomId,
      principalId: params.principal.id,
      memberId: existingMembership.id,
    },
  };
}

function findReusableDirectRoom(params: {
  actorPrincipalId: string;
  peerPrincipalId: string;
}): Room | null {
  const allRooms = db.select().from(rooms).all() as Room[];

  for (const room of allRooms) {
    const roomMembers = db
      .select()
      .from(members)
      .where(eq(members.roomId, room.id))
      .all()
      .filter((member) => (member.membershipStatus ?? "active") === "active") as Member[];

    if (roomMembers.length !== 2) {
      continue;
    }

    const principalIds = roomMembers.map((member) => member.principalId).filter(Boolean) as string[];

    if (principalIds.length !== 2) {
      continue;
    }

    const uniquePrincipalIds = new Set(principalIds);
    if (
      uniquePrincipalIds.size === 2 &&
      uniquePrincipalIds.has(params.actorPrincipalId) &&
      uniquePrincipalIds.has(params.peerPrincipalId)
    ) {
      return room;
    }
  }

  return null;
}

function createRoomRecord(params: {
  id: string;
  name: string;
  inviteToken: string;
  createdAt: string;
}): Room {
  return {
    id: params.id,
    name: params.name,
    inviteToken: params.inviteToken,
    status: "active",
    secretaryMemberId: null,
    secretaryMode: "off",
    createdAt: params.createdAt,
  };
}

function toRoomSummary(room: Room) {
  return {
    id: room.id,
    name: room.name,
    inviteToken: room.inviteToken,
    secretaryMemberId: room.secretaryMemberId,
    secretaryMode: room.secretaryMode,
    createdAt: room.createdAt,
  };
}

roomRoutes.post("/api/rooms", async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";

  if (!name) {
    return c.json({ error: "room name is required" }, 400);
  }

  const room = createRoomRecord({
    id: createId("room"),
    name,
    inviteToken: createInviteToken(),
    createdAt: now(),
  });

  db.insert(rooms).values(room).run();

  return c.json({
    id: room.id,
    name: room.name,
    inviteToken: room.inviteToken,
    secretaryMemberId: room.secretaryMemberId,
    secretaryMode: room.secretaryMode,
    inviteUrl: `/join/${room.inviteToken}`,
  });
});

roomRoutes.get("/api/me/rooms", (c) => {
  const principalId = c.req.query("principalId")?.trim() ?? "";
  const principalToken = c.req.query("principalToken")?.trim() ?? "";

  if (!principalId || !principalToken) {
    return c.json({ error: "principalId and principalToken are required" }, 400);
  }

  if (!verifyPrincipalToken(principalToken, principalId)) {
    return c.json({ error: "invalid principal token" }, 403);
  }

  const joinedMembers = db
    .select()
    .from(members)
    .where(eq(members.principalId, principalId))
    .all()
    .filter((member) => (member.membershipStatus ?? "active") === "active") as Member[];

  const joinedRoomIds = Array.from(new Set(joinedMembers.map((member) => member.roomId)));
  const joinedRooms = joinedRoomIds
    .map((roomId) => db.select().from(rooms).where(eq(rooms.id, roomId)).get() as Room | undefined)
    .filter(Boolean)
    .sort((a, b) => b!.createdAt.localeCompare(a!.createdAt))
    .map((room) => toRoomSummary(room!));

  return c.json({ rooms: joinedRooms });
});

roomRoutes.post("/api/direct-rooms", async (c) => {
  const body = await c.req.json().catch(() => null);
  const actorPrincipalId =
    typeof body?.actorPrincipalId === "string"
      ? body.actorPrincipalId.trim()
      : typeof body?.principalId === "string"
        ? body.principalId.trim()
        : "";
  const actorPrincipalToken =
    typeof body?.actorPrincipalToken === "string"
      ? body.actorPrincipalToken.trim()
      : typeof body?.principalToken === "string"
        ? body.principalToken.trim()
        : "";
  const peerPrincipalId =
    typeof body?.peerPrincipalId === "string"
      ? body.peerPrincipalId.trim()
      : typeof body?.targetPrincipalId === "string"
        ? body.targetPrincipalId.trim()
        : "";

  if (!actorPrincipalId || !actorPrincipalToken || !peerPrincipalId) {
    return c.json({ error: "actorPrincipalId, actorPrincipalToken and peerPrincipalId are required" }, 400);
  }

  if (actorPrincipalId === peerPrincipalId) {
    return c.json({ error: "actor and peer must be different" }, 400);
  }

  if (!verifyPrincipalToken(actorPrincipalToken, actorPrincipalId)) {
    return c.json({ error: "invalid principal token for actor" }, 403);
  }

  const actor = db
    .select()
    .from(principals)
    .where(eq(principals.id, actorPrincipalId))
    .get() as Principal | undefined;
  const peer = db
    .select()
    .from(principals)
    .where(eq(principals.id, peerPrincipalId))
    .get() as Principal | undefined;

  if (!actor || !peer) {
    return c.json({ error: "principal not found" }, 404);
  }

  const reusable = findReusableDirectRoom({ actorPrincipalId, peerPrincipalId });

  if (reusable) {
    const actorMember = db
      .select()
      .from(members)
      .where(and(eq(members.roomId, reusable.id), eq(members.principalId, actorPrincipalId)))
      .get() as Member | undefined;

    if (!actorMember || (actorMember.membershipStatus ?? "active") !== "active") {
      return c.json({ error: "actor membership missing in reusable direct room" }, 409);
    }

    const wsToken = issueWsToken(actorMember.id, reusable.id);

    broadcastToPrincipal(peerPrincipalId, {
      type: "rooms.changed",
      principalId: peerPrincipalId,
      timestamp: now(),
      payload: {
        reason: "room_joined",
        roomId: reusable.id,
      },
    });

    return c.json({
      room: reusable,
      reused: true,
      join: {
        memberId: actorMember.id,
        roomId: reusable.id,
        displayName: actorMember.displayName,
        wsToken,
      },
    });
  }

  const createdAt = now();
  const room = createRoomRecord({
    id: createId("room"),
    name: buildDirectRoomName(actor, peer),
    inviteToken: createInviteToken(),
    createdAt,
  });

  db.insert(rooms).values(room).run();

  const actorMember: Member = {
    id: createId("mem"),
    roomId: room.id,
    principalId: actor.id,
    type: actor.kind === "agent" ? "agent" : "human",
    roleKind: actor.kind === "agent" ? "independent" : "none",
    displayName: actor.globalDisplayName,
    ownerMemberId: null,
    sourcePrivateAssistantId: null,
    adapterType: actor.kind === "agent" ? (actor.backendType ?? "codex_cli") : null,
    adapterConfig: null,
    presenceStatus: "online",
    membershipStatus: "active",
    leftAt: null,
    createdAt,
  };

  const peerMember: Member = {
    id: createId("mem"),
    roomId: room.id,
    principalId: peer.id,
    type: peer.kind === "agent" ? "agent" : "human",
    roleKind: peer.kind === "agent" ? "independent" : "none",
    displayName: peer.globalDisplayName,
    ownerMemberId: null,
    sourcePrivateAssistantId: null,
    adapterType: peer.kind === "agent" ? (peer.backendType ?? "codex_cli") : null,
    adapterConfig: null,
    presenceStatus: peer.status,
    membershipStatus: "active",
    leftAt: null,
    createdAt,
  };

  db.insert(members).values([actorMember, peerMember]).run();

  const wsToken = issueWsToken(actorMember.id, room.id);

  broadcastToPrincipal(peerPrincipalId, {
    type: "rooms.changed",
    principalId: peerPrincipalId,
    timestamp: now(),
    payload: {
      reason: "direct_room_created",
      roomId: room.id,
    },
  });

  return c.json({
    room,
    reused: false,
    join: {
      memberId: actorMember.id,
      roomId: room.id,
      displayName: actorMember.displayName,
      wsToken,
    },
  });
});

roomRoutes.get("/api/rooms/:roomId", (c) => {
  const room = db.select().from(rooms).where(eq(rooms.id, c.req.param("roomId"))).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  return c.json(room);
});

roomRoutes.get("/api/rooms/:roomId/summary", (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  return c.json({ summary: getRoomSummary(roomId) });
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
    secretaryMemberId: room.secretaryMemberId,
    secretaryMode: room.secretaryMode,
    inviteUrl: `/join/${room.inviteToken}`,
  });
});

roomRoutes.patch("/api/rooms/:roomId/secretary", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get() as Room | undefined;

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";
  const secretaryMemberId =
    typeof body?.secretaryMemberId === "string" ? body.secretaryMemberId.trim() : null;
  const secretaryMode: RoomSecretaryMode =
    body?.secretaryMode === "coordinate" || body?.secretaryMode === "coordinate_and_summarize"
      ? body.secretaryMode
      : "off";

  if (!actorMemberId || !wsToken) {
    return c.json({ error: "actorMemberId and wsToken are required" }, 400);
  }

  const actor = db
    .select()
    .from(members)
    .where(and(eq(members.id, actorMemberId), eq(members.roomId, roomId)))
    .get() as Member | undefined;

  if (!actor || (actor.membershipStatus ?? "active") !== "active") {
    return c.json({ error: "actor not found in room" }, 404);
  }

  if (!verifyWsToken(wsToken, actorMemberId, roomId)) {
    return c.json({ error: "invalid wsToken for actor" }, 403);
  }

  if (actor.type !== "human") {
    return c.json({ error: "only human members can configure room secretary" }, 403);
  }

  if (secretaryMode === "off") {
    db.update(rooms).set({ secretaryMemberId: null, secretaryMode: "off" }).where(eq(rooms.id, roomId)).run();
    return c.json({
      ...room,
      secretaryMemberId: null,
      secretaryMode: "off",
    });
  }

  if (!secretaryMemberId) {
    return c.json({ error: "secretaryMemberId is required unless secretaryMode is off" }, 400);
  }

  const secretaryMember = db
    .select()
    .from(members)
    .where(and(eq(members.id, secretaryMemberId), eq(members.roomId, roomId)))
    .get() as Member | undefined;

  if (!secretaryMember || (secretaryMember.membershipStatus ?? "active") !== "active") {
    return c.json({ error: "secretary member not found in room" }, 404);
  }

  if (secretaryMember.type !== "agent" || secretaryMember.roleKind !== "independent") {
    return c.json({ error: "room secretary must be an active independent agent" }, 400);
  }

  db
    .update(rooms)
    .set({
      secretaryMemberId: secretaryMember.id,
      secretaryMode,
    })
    .where(eq(rooms.id, roomId))
    .run();

  return c.json({
    ...room,
    secretaryMemberId: secretaryMember.id,
    secretaryMode,
  });
});

roomRoutes.post("/api/rooms/:roomId/join", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const principalId = typeof body?.principalId === "string" ? body.principalId.trim() : "";
  const principalToken =
    typeof body?.principalToken === "string" ? body.principalToken.trim() : "";
  const roomDisplayName =
    typeof body?.roomDisplayName === "string" ? body.roomDisplayName.trim() : "";
  const nickname = typeof body?.nickname === "string" ? body.nickname.trim() : "";
  const principal = principalId
    ? (db.select().from(principals).where(eq(principals.id, principalId)).get() as Principal | undefined)
    : undefined;

  if (principalId && !principal) {
    return c.json({ error: "principal not found" }, 404);
  }

  if (principalId && !principalToken) {
    return c.json({ error: "principalToken is required" }, 400);
  }

  if (principalId && !verifyPrincipalToken(principalToken, principalId)) {
    return c.json({ error: "invalid principal token" }, 403);
  }

  if (principal) {
    const existingMembership = db
      .select()
      .from(members)
      .where(and(eq(members.roomId, roomId), eq(members.principalId, principal.id)))
      .get();

    if (!existingMembership) {
      return c.json({ error: "room join requires invite or existing membership" }, 403);
    }
  }

  const displayName = resolveDisplayName({
    principal: principal ?? null,
    roomDisplayName: roomDisplayName || null,
    nickname: nickname || null,
  });

  if (!displayName) {
    return c.json({ error: "principalId or nickname is required" }, 400);
  }

  if (!isValidDisplayName(displayName)) {
    return c.json({ error: "displayName must not contain spaces or @" }, 400);
  }

  const result = joinRoom({
    roomId,
    principal: principal ?? null,
    displayName,
  });

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
  const principalId = typeof body?.principalId === "string" ? body.principalId.trim() : "";
  const principalToken =
    typeof body?.principalToken === "string" ? body.principalToken.trim() : "";
  const roomDisplayName =
    typeof body?.roomDisplayName === "string" ? body.roomDisplayName.trim() : "";
  const nickname = typeof body?.nickname === "string" ? body.nickname.trim() : "";
  const principal = principalId
    ? (db.select().from(principals).where(eq(principals.id, principalId)).get() as Principal | undefined)
    : undefined;

  if (principalId && !principal) {
    return c.json({ error: "principal not found" }, 404);
  }

  if (principalId && !principalToken) {
    return c.json({ error: "principalToken is required" }, 400);
  }

  if (principalId && !verifyPrincipalToken(principalToken, principalId)) {
    return c.json({ error: "invalid principal token" }, 403);
  }

  const displayName = resolveDisplayName({
    principal: principal ?? null,
    roomDisplayName: roomDisplayName || null,
    nickname: nickname || null,
  });

  if (!displayName) {
    return c.json({ error: "principalId or nickname is required" }, 400);
  }

  if (!isValidDisplayName(displayName)) {
    return c.json({ error: "displayName must not contain spaces or @" }, 400);
  }

  const result = joinRoom({
    roomId: room.id,
    principal: principal ?? null,
    displayName,
  });

  if ("error" in result) {
    return c.json(result.error, result.status);
  }

  return c.json(result.payload);
});

roomRoutes.post("/api/rooms/:roomId/leave", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const principalId = typeof body?.principalId === "string" ? body.principalId.trim() : "";
  const principalToken =
    typeof body?.principalToken === "string" ? body.principalToken.trim() : "";

  if (!principalId || !principalToken) {
    return c.json({ error: "principalId and principalToken are required" }, 400);
  }

  if (!verifyPrincipalToken(principalToken, principalId)) {
    return c.json({ error: "invalid principal token" }, 403);
  }

  const principal = db
    .select()
    .from(principals)
    .where(eq(principals.id, principalId))
    .get() as Principal | undefined;

  if (!principal) {
    return c.json({ error: "principal not found" }, 404);
  }

  const result = leaveRoomByPrincipal({ roomId, principal });
  return c.json(result.payload);
});

roomRoutes.post("/api/rooms/:roomId/pull", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";
  const targetPrincipalId =
    typeof body?.targetPrincipalId === "string" ? body.targetPrincipalId.trim() : "";
  const roomDisplayName =
    typeof body?.roomDisplayName === "string" ? body.roomDisplayName.trim() : "";

  if (!actorMemberId || !wsToken || !targetPrincipalId) {
    return c.json({ error: "actorMemberId, wsToken and targetPrincipalId are required" }, 400);
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

  const targetPrincipal = db
    .select()
    .from(principals)
    .where(eq(principals.id, targetPrincipalId))
    .get() as Principal | undefined;

  if (!targetPrincipal) {
    return c.json({ error: "target principal not found" }, 404);
  }

  const existingMembership = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, roomId), eq(members.principalId, targetPrincipalId)))
    .get();

  if (existingMembership) {
    return c.json({ error: "principal already in room" }, 409);
  }

  const displayName = roomDisplayName || targetPrincipal.globalDisplayName;

  if (!isValidDisplayName(displayName)) {
    return c.json({ error: "displayName must not contain spaces or @" }, 400);
  }

  const result = joinRoom({
    roomId,
    principal: targetPrincipal,
    displayName,
  });

  if ("error" in result) {
    return c.json(result.error, result.status);
  }

  return c.json(result.payload, 201);
});

export { roomRoutes };
