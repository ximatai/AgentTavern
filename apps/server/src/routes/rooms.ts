import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";

import type { AgentBinding, Member, Principal, Room, RoomSecretaryMode } from "@agent-tavern/shared";

import { db } from "../db/client";
import {
  agentAuthorizations,
  agentSessions,
  approvals,
  bridgeTasks,
  members,
  mentions,
  messages,
  principals,
  roomSummaries,
  rooms,
} from "../db/schema";
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

function isRoomArchived(room: { status: string | null }): boolean {
  return room.status !== "active";
}

function isActiveMember(member: { membershipStatus?: string | null }): boolean {
  return (member.membershipStatus ?? "active") === "active";
}

function isHumanMember(member: { type: string | null }): boolean {
  return member.type === "human";
}

function isRoomOwner(
  room: { ownerMemberId?: string | null },
  member: { id: string },
): boolean {
  return room.ownerMemberId === member.id;
}

function broadcastRoomUpdated(room: Room): void {
  broadcastToRoom(room.id, {
    type: "room.updated",
    roomId: room.id,
    timestamp: now(),
    payload: { room },
  });
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
  room: Room;
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

  if (isRoomOwner(params.room, existingMembership)) {
    const otherActiveHumans = db
      .select()
      .from(members)
      .where(eq(members.roomId, params.roomId))
      .all()
      .filter((member) => isActiveMember(member) && isHumanMember(member) && member.id !== existingMembership.id);

    if (otherActiveHumans.length > 0) {
      return {
        error: {
          error: "room owner must transfer ownership before leaving",
        },
        status: 409 as const,
      };
    }

    return {
      error: {
        error: "room owner must disband the room before leaving",
      },
      status: 409 as const,
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
  const allRooms = db.select().from(rooms).where(eq(rooms.status, "active")).all() as Room[];

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
  ownerMemberId: string | null;
  createdAt: string;
}): Room {
  return {
    id: params.id,
    name: params.name,
    inviteToken: params.inviteToken,
    status: "active",
    ownerMemberId: params.ownerMemberId,
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
    ownerMemberId: room.ownerMemberId,
    secretaryMemberId: room.secretaryMemberId,
    secretaryMode: room.secretaryMode,
    createdAt: room.createdAt,
  };
}

function disbandRoom(params: {
  room: Room;
  actor: Member;
}) {
  const timestamp = now();
  const roomId = params.room.id;
  const roomMembers = db
    .select()
    .from(members)
    .where(eq(members.roomId, roomId))
    .all() as Member[];
  const activeMembers = roomMembers.filter((member) => (member.membershipStatus ?? "active") === "active");
  const principalIds = [...new Set(activeMembers.map((member) => member.principalId).filter(Boolean))] as string[];
  const messageIds = db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all()
    .map((row) => row.id);

  db
    .update(rooms)
    .set({
      status: "archived",
      ownerMemberId: null,
      secretaryMemberId: null,
      secretaryMode: "off",
    })
    .where(eq(rooms.id, roomId))
    .run();

  db
    .update(members)
    .set({
      presenceStatus: "offline",
      membershipStatus: "left",
      leftAt: timestamp,
    })
    .where(and(eq(members.roomId, roomId), eq(members.membershipStatus, "active")))
    .run();

  db
    .update(agentSessions)
    .set({
      status: "cancelled",
      endedAt: timestamp,
    })
    .where(
      and(
        eq(agentSessions.roomId, roomId),
        inArray(agentSessions.status, ["pending", "waiting_approval", "running"]),
      ),
    )
    .run();

  db
    .update(bridgeTasks)
    .set({
      status: "failed",
      failedAt: timestamp,
    })
    .where(
      and(
        eq(bridgeTasks.roomId, roomId),
        inArray(bridgeTasks.status, ["pending", "assigned", "accepted"]),
      ),
    )
    .run();

  db
    .update(approvals)
    .set({
      status: "expired",
      resolvedAt: timestamp,
    })
    .where(and(eq(approvals.roomId, roomId), eq(approvals.status, "pending")))
    .run();

  if (messageIds.length > 0) {
    db
      .update(mentions)
      .set({ status: "expired" })
      .where(
        and(
          inArray(mentions.messageId, messageIds),
          inArray(mentions.status, ["detected", "pending_approval", "approved"]),
        ),
      )
      .run();
  }

  db
    .update(agentAuthorizations)
    .set({
      revokedAt: timestamp,
      updatedAt: timestamp,
    })
    .where(and(eq(agentAuthorizations.roomId, roomId), isNull(agentAuthorizations.revokedAt)))
    .run();

  db.delete(roomSummaries).where(eq(roomSummaries.roomId, roomId)).run();

  for (const member of activeMembers) {
    revokeWsTokensForMember(member.id, roomId);
    broadcastToRoom(roomId, {
      type: "member.left",
      roomId,
      timestamp,
      payload: { memberId: member.id },
    });
  }

  for (const principalId of principalIds) {
    broadcastToPrincipal(principalId, {
      type: "rooms.changed",
      principalId,
      timestamp,
      payload: {
        reason: "room_disbanded",
        roomId,
      },
    });
  }

  return {
    roomId,
    status: "archived" as const,
    disbandedAt: timestamp,
    disbandedByMemberId: params.actor.id,
  };
}

roomRoutes.post("/api/rooms", async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const principalId = typeof body?.principalId === "string" ? body.principalId.trim() : "";
  const principalToken = typeof body?.principalToken === "string" ? body.principalToken.trim() : "";

  if (!name || !principalId || !principalToken) {
    return c.json({ error: "room name, principalId and principalToken are required" }, 400);
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

  if (principal.kind !== "human") {
    return c.json({ error: "only human principals can create rooms" }, 403);
  }

  const createdAt = now();
  const ownerMemberId = createId("mem");
  const room = createRoomRecord({
    id: createId("room"),
    name,
    inviteToken: createInviteToken(),
    ownerMemberId,
    createdAt,
  });
  const ownerMember: Member = {
    id: ownerMemberId,
    roomId: room.id,
    principalId: principal.id,
    type: "human",
    roleKind: "none",
    displayName: principal.globalDisplayName,
    ownerMemberId: null,
    sourcePrivateAssistantId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "online",
    membershipStatus: "active",
    leftAt: null,
    createdAt,
  };

  db.insert(rooms).values(room).run();
  db.insert(members).values(ownerMember).run();
  const wsToken = issueWsToken(ownerMember.id, room.id);

  return c.json({
    room: {
      id: room.id,
      name: room.name,
      inviteToken: room.inviteToken,
      ownerMemberId: room.ownerMemberId,
      secretaryMemberId: room.secretaryMemberId,
      secretaryMode: room.secretaryMode,
      inviteUrl: `/join/${room.inviteToken}`,
    },
    join: {
      memberId: ownerMember.id,
      roomId: room.id,
      displayName: ownerMember.displayName,
      wsToken,
    },
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
    .filter((room) => Boolean(room) && room!.status === "active")
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

  if (actor.kind !== "human") {
    return c.json({ error: "only human principals can create direct rooms" }, 403);
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
    ownerMemberId: null,
    createdAt,
  });

  const actorMember: Member = {
    id: createId("mem"),
    roomId: room.id,
    principalId: actor.id,
    type: "human",
    roleKind: "none",
    displayName: actor.globalDisplayName,
    ownerMemberId: null,
    sourcePrivateAssistantId: null,
    adapterType: null,
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

  room.ownerMemberId = actorMember.id;

  db.insert(rooms).values(room).run();
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

  if (isRoomArchived(room)) {
    return c.json({ error: "room is archived" }, 410);
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

  if (isRoomArchived(room)) {
    return c.json({ error: "invite is no longer active" }, 410);
  }

  return c.json({
    id: room.id,
    name: room.name,
    inviteToken: room.inviteToken,
    ownerMemberId: room.ownerMemberId,
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

  if (isRoomArchived(room)) {
    return c.json({ error: "room is archived" }, 410);
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

  if (!isHumanMember(actor)) {
    return c.json({ error: "only human members can configure room secretary" }, 403);
  }

  if (!isRoomOwner(room, actor)) {
    return c.json({ error: "only the room owner can configure room secretary" }, 403);
  }

  if (secretaryMode === "off") {
    const updatedRoom = {
      ...room,
      ownerMemberId: room.ownerMemberId,
      secretaryMemberId: null,
      secretaryMode: "off",
    } satisfies Room;
    db
      .update(rooms)
      .set({ secretaryMemberId: null, secretaryMode: "off" })
      .where(eq(rooms.id, roomId))
      .run();
    broadcastRoomUpdated(updatedRoom);
    return c.json(updatedRoom);
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

  const updatedRoom: Room = {
    ...room,
    ownerMemberId: room.ownerMemberId,
    secretaryMemberId: secretaryMember.id,
    secretaryMode,
  };

  db
    .update(rooms)
    .set({
      secretaryMemberId: secretaryMember.id,
      secretaryMode,
    })
    .where(eq(rooms.id, roomId))
    .run();

  broadcastRoomUpdated(updatedRoom);

  return c.json(updatedRoom);
});

roomRoutes.post("/api/rooms/:roomId/ownership/transfer", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get() as Room | undefined;

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  if (isRoomArchived(room)) {
    return c.json({ error: "room is archived" }, 410);
  }

  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";
  const nextOwnerMemberId =
    typeof body?.nextOwnerMemberId === "string" ? body.nextOwnerMemberId.trim() : "";

  if (!actorMemberId || !wsToken || !nextOwnerMemberId) {
    return c.json({ error: "actorMemberId, wsToken and nextOwnerMemberId are required" }, 400);
  }

  const actor = db
    .select()
    .from(members)
    .where(and(eq(members.id, actorMemberId), eq(members.roomId, roomId)))
    .get() as Member | undefined;

  if (!actor || !isActiveMember(actor)) {
    return c.json({ error: "actor not found in room" }, 404);
  }

  if (!verifyWsToken(wsToken, actorMemberId, roomId)) {
    return c.json({ error: "invalid wsToken for actor" }, 403);
  }

  if (!isHumanMember(actor) || !isRoomOwner(room, actor)) {
    return c.json({ error: "only the room owner can transfer ownership" }, 403);
  }

  const nextOwner = db
    .select()
    .from(members)
    .where(and(eq(members.id, nextOwnerMemberId), eq(members.roomId, roomId)))
    .get() as Member | undefined;

  if (!nextOwner || !isActiveMember(nextOwner)) {
    return c.json({ error: "next owner not found in room" }, 404);
  }

  if (!isHumanMember(nextOwner)) {
    return c.json({ error: "room owner must be an active human member" }, 400);
  }

  if (nextOwner.id === actor.id) {
    return c.json({ error: "next owner must be different from current owner" }, 409);
  }

  const updatedRoom: Room = {
    ...room,
    ownerMemberId: nextOwner.id,
  };

  db
    .update(rooms)
    .set({ ownerMemberId: nextOwner.id })
    .where(eq(rooms.id, roomId))
    .run();

  broadcastRoomUpdated(updatedRoom);

  return c.json(updatedRoom);
});

roomRoutes.post("/api/rooms/:roomId/join", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  if (isRoomArchived(room)) {
    return c.json({ error: "room is archived" }, 410);
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

  if (isRoomArchived(room)) {
    return c.json({ error: "invite is no longer active" }, 410);
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

  const result = leaveRoomByPrincipal({ room: room as Room, roomId, principal });
  if ("error" in result) {
    return c.json(result.error, result.status);
  }
  return c.json(result.payload);
});

roomRoutes.post("/api/rooms/:roomId/pull", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  if (isRoomArchived(room)) {
    return c.json({ error: "room is archived" }, 410);
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

roomRoutes.post("/api/rooms/:roomId/disband", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get() as Room | undefined;

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  if (isRoomArchived(room)) {
    return c.json({ error: "room is already archived" }, 409);
  }

  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";

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

  if (!isHumanMember(actor) || !isRoomOwner(room, actor)) {
    return c.json({ error: "only the room owner can disband a room" }, 403);
  }

  return c.json(disbandRoom({ room, actor }));
});

export { roomRoutes };
