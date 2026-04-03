import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";

import type { AgentBinding, Member, Citizen, Room, RoomSecretaryMode } from "@agent-tavern/shared";

import { stopAgentSession } from "../agents/runtime";
import { db } from "../db/client";
import {
  agentAuthorizations,
  agentSessions,
  approvals,
  bridgeTasks,
  members,
  mentions,
  messages,
  citizens,
  roomSummaries,
  rooms,
} from "../db/schema";
import { createId, createInviteToken } from "../lib/id";
import { resolveBindingForCitizen } from "../lib/agent-binding-resolution";
import { resolveMemberRuntimeStatus } from "../lib/member-runtime";
import { toPublicMember } from "../lib/public";
import { getRoomSummary } from "../lib/room-summary";
import {
  broadcastToCitizen,
  broadcastToRoom,
  issueWsToken,
  revokeWsTokensForMember,
  verifyCitizenToken,
  verifyWsToken,
} from "../realtime";
import { isUniqueConstraintError, isValidDisplayName, now } from "./support";

const roomRoutes = new Hono();

function buildDirectRoomName(actor: Citizen, peer: Citizen): string {
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
  principal: Citizen | null;
  roomDisplayName: string | null;
  nickname: string | null;
}) {
  return params.roomDisplayName || params.principal?.globalDisplayName || params.nickname || "";
}

function joinRoom(params: {
  roomId: string;
  principal: Citizen | null;
  displayName: string;
}) {
  if (params.principal) {
    const existingByPrincipal = db
      .select()
      .from(members)
      .where(and(eq(members.roomId, params.roomId), eq(members.citizenId, params.principal.id)))
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
        ? resolveBindingForCitizen(params.principal.id)
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
    citizenId: params.principal?.id ?? null,
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
    ? resolveBindingForCitizen(params.principal.id)
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
  principal: Citizen;
}) {
  const existingMembership = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, params.roomId), eq(members.citizenId, params.principal.id)))
    .get() as Member | undefined;

  if (!existingMembership || (existingMembership.membershipStatus ?? "active") !== "active") {
    return {
      payload: {
        left: false,
        roomId: params.roomId,
        citizenId: params.principal.id,
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
      citizenId: params.principal.id,
      memberId: existingMembership.id,
    },
  };
}

function removeRoomMember(params: {
  room: Room;
  roomId: string;
  actor: Member;
  target: Member;
}) {
  if (!isHumanMember(params.actor) || !isRoomOwner(params.room, params.actor)) {
    return {
      error: {
        error: "only the room owner can remove members",
      },
      status: 403 as const,
    };
  }

  if (!isActiveMember(params.target)) {
    return {
      error: {
        error: "target member is not active",
      },
      status: 409 as const,
    };
  }

  if (params.target.id === params.actor.id) {
    return {
      error: {
        error: "room owner cannot remove self",
      },
      status: 409 as const,
    };
  }

  if (isRoomOwner(params.room, params.target)) {
    return {
      error: {
        error: "room owner cannot be removed",
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
    .where(eq(members.id, params.target.id))
    .run();
  revokeWsTokensForMember(params.target.id, params.roomId);
  broadcastToRoom(params.roomId, {
    type: "member.left",
    roomId: params.roomId,
    timestamp: now(),
    payload: { memberId: params.target.id },
  });

  return {
    payload: {
      removed: true,
      roomId: params.roomId,
      memberId: params.target.id,
    },
  };
}

function findReusableDirectRoom(params: {
  actorCitizenId: string;
  peerCitizenId: string;
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

    const citizenIds = roomMembers.map((member) => member.citizenId).filter(Boolean) as string[];

    if (citizenIds.length !== 2) {
      continue;
    }

    const uniquePrincipalIds = new Set(citizenIds);
    if (
      uniquePrincipalIds.size === 2 &&
      uniquePrincipalIds.has(params.actorCitizenId) &&
      uniquePrincipalIds.has(params.peerCitizenId)
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
  const citizenIds = [...new Set(activeMembers.map((member) => member.citizenId).filter(Boolean))] as string[];
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

  for (const citizenId of citizenIds) {
    broadcastToCitizen(citizenId, {
      type: "rooms.changed",
      citizenId,
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
  const citizenId = typeof body?.citizenId === "string" ? body.citizenId.trim() : "";
  const citizenToken = typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";

  if (!name || !citizenId || !citizenToken) {
    return c.json({ error: "room name, citizenId and citizenToken are required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const principal = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, citizenId))
    .get() as Citizen | undefined;

  if (!principal) {
    return c.json({ error: "citizen not found" }, 404);
  }

  if (principal.kind !== "human") {
    return c.json({ error: "only human citizens can create rooms" }, 403);
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
    citizenId: principal.id,
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
  const citizenId = c.req.query("citizenId")?.trim() ?? "";
  const citizenToken = c.req.query("citizenToken")?.trim() ?? "";

  if (!citizenId || !citizenToken) {
    return c.json({ error: "citizenId and citizenToken are required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const joinedMembers = db
    .select()
    .from(members)
    .where(eq(members.citizenId, citizenId))
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
  const actorCitizenId =
    typeof body?.actorCitizenId === "string"
      ? body.actorCitizenId.trim()
      : typeof body?.citizenId === "string"
        ? body.citizenId.trim()
        : "";
  const actorCitizenToken =
    typeof body?.actorCitizenToken === "string"
      ? body.actorCitizenToken.trim()
      : typeof body?.citizenToken === "string"
        ? body.citizenToken.trim()
        : "";
  const peerCitizenId =
    typeof body?.peerCitizenId === "string"
      ? body.peerCitizenId.trim()
      : typeof body?.targetCitizenId === "string"
        ? body.targetCitizenId.trim()
        : "";

  if (!actorCitizenId || !actorCitizenToken || !peerCitizenId) {
    return c.json({ error: "actorCitizenId, actorCitizenToken and peerCitizenId are required" }, 400);
  }

  if (actorCitizenId === peerCitizenId) {
    return c.json({ error: "actor and peer must be different" }, 400);
  }

  if (!verifyCitizenToken(actorCitizenToken, actorCitizenId)) {
    return c.json({ error: "invalid citizen token for actor" }, 403);
  }

  const actor = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, actorCitizenId))
    .get() as Citizen | undefined;
  const peer = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, peerCitizenId))
    .get() as Citizen | undefined;

  if (!actor || !peer) {
    return c.json({ error: "citizen not found" }, 404);
  }

  const reusable = findReusableDirectRoom({ actorCitizenId, peerCitizenId });

  if (reusable) {
    const actorMember = db
      .select()
      .from(members)
      .where(and(eq(members.roomId, reusable.id), eq(members.citizenId, actorCitizenId)))
      .get() as Member | undefined;

    if (!actorMember || (actorMember.membershipStatus ?? "active") !== "active") {
      return c.json({ error: "actor membership missing in reusable direct room" }, 409);
    }

    const wsToken = issueWsToken(actorMember.id, reusable.id);

    broadcastToCitizen(peerCitizenId, {
      type: "rooms.changed",
      citizenId: peerCitizenId,
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
    citizenId: actor.id,
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
    citizenId: peer.id,
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

  room.ownerMemberId = actor.kind === "human"
    ? actorMember.id
    : peer.kind === "human"
      ? peerMember.id
      : null;

  db.insert(rooms).values(room).run();
  db.insert(members).values([actorMember, peerMember]).run();

  const wsToken = issueWsToken(actorMember.id, room.id);

  broadcastToCitizen(peerCitizenId, {
    type: "rooms.changed",
    citizenId: peerCitizenId,
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
  const citizenId = typeof body?.citizenId === "string" ? body.citizenId.trim() : "";
  const citizenToken =
    typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";
  const roomDisplayName =
    typeof body?.roomDisplayName === "string" ? body.roomDisplayName.trim() : "";
  const nickname = typeof body?.nickname === "string" ? body.nickname.trim() : "";
  const principal = citizenId
    ? (db.select().from(citizens).where(eq(citizens.id, citizenId)).get() as Citizen | undefined)
    : undefined;

  if (citizenId && !principal) {
    return c.json({ error: "citizen not found" }, 404);
  }

  if (citizenId && !citizenToken) {
    return c.json({ error: "citizenToken is required" }, 400);
  }

  if (citizenId && !verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  if (principal) {
    const existingMembership = db
      .select()
      .from(members)
      .where(and(eq(members.roomId, roomId), eq(members.citizenId, principal.id)))
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
    return c.json({ error: "citizenId or nickname is required" }, 400);
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
  const citizenId = typeof body?.citizenId === "string" ? body.citizenId.trim() : "";
  const citizenToken =
    typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";
  const roomDisplayName =
    typeof body?.roomDisplayName === "string" ? body.roomDisplayName.trim() : "";
  const nickname = typeof body?.nickname === "string" ? body.nickname.trim() : "";
  const principal = citizenId
    ? (db.select().from(citizens).where(eq(citizens.id, citizenId)).get() as Citizen | undefined)
    : undefined;

  if (citizenId && !principal) {
    return c.json({ error: "citizen not found" }, 404);
  }

  if (citizenId && !citizenToken) {
    return c.json({ error: "citizenToken is required" }, 400);
  }

  if (citizenId && !verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const displayName = resolveDisplayName({
    principal: principal ?? null,
    roomDisplayName: roomDisplayName || null,
    nickname: nickname || null,
  });

  if (!displayName) {
    return c.json({ error: "citizenId or nickname is required" }, 400);
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
  const citizenId = typeof body?.citizenId === "string" ? body.citizenId.trim() : "";
  const citizenToken =
    typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";

  if (!citizenId || !citizenToken) {
    return c.json({ error: "citizenId and citizenToken are required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const principal = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, citizenId))
    .get() as Citizen | undefined;

  if (!principal) {
    return c.json({ error: "citizen not found" }, 404);
  }

  const result = leaveRoomByPrincipal({ room: room as Room, roomId, principal });
  if ("error" in result) {
    return c.json(result.error, result.status);
  }
  return c.json(result.payload);
});

roomRoutes.post("/api/rooms/:roomId/remove-member", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get() as Room | undefined;

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";
  const targetMemberId =
    typeof body?.targetMemberId === "string" ? body.targetMemberId.trim() : "";

  if (!actorMemberId || !wsToken || !targetMemberId) {
    return c.json({ error: "actorMemberId, wsToken and targetMemberId are required" }, 400);
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

  const target = db
    .select()
    .from(members)
    .where(and(eq(members.id, targetMemberId), eq(members.roomId, roomId)))
    .get() as Member | undefined;

  if (!target) {
    return c.json({ error: "target member not found in room" }, 404);
  }

  const result = removeRoomMember({
    room,
    roomId,
    actor,
    target,
  });
  if ("error" in result) {
    return c.json(result.error, result.status);
  }
  return c.json(result.payload);
});

roomRoutes.post("/api/rooms/:roomId/agent-sessions/:sessionId/stop", async (c) => {
  const roomId = c.req.param("roomId");
  const sessionId = c.req.param("sessionId");
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

  if (!actorMemberId || !wsToken) {
    return c.json({ error: "actorMemberId and wsToken are required" }, 400);
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
    return c.json({ error: "only the room owner can stop agent output" }, 403);
  }

  const session = stopAgentSession({
    roomId,
    sessionId,
    stoppedByMemberId: actor.id,
  });

  if (!session) {
    return c.json({ error: "session not found" }, 404);
  }

  if (!["pending", "running", "cancelled"].includes(session.status)) {
    return c.json({ error: "session is not stoppable" }, 409);
  }

  return c.json({ session });
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
  const targetCitizenId =
    typeof body?.targetCitizenId === "string" ? body.targetCitizenId.trim() : "";
  const roomDisplayName =
    typeof body?.roomDisplayName === "string" ? body.roomDisplayName.trim() : "";

  if (!actorMemberId || !wsToken || !targetCitizenId) {
    return c.json({ error: "actorMemberId, wsToken and targetCitizenId are required" }, 400);
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
    .from(citizens)
    .where(eq(citizens.id, targetCitizenId))
    .get() as Citizen | undefined;

  if (!targetPrincipal) {
    return c.json({ error: "target citizen not found" }, 404);
  }

  const existingMembership = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, roomId), eq(members.citizenId, targetCitizenId)))
    .get();

  if (existingMembership) {
    return c.json({ error: "citizen already in room" }, 409);
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
