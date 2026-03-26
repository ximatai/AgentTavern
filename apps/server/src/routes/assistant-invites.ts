import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { AgentBackendType, AgentBinding, AssistantInvite, Member, RealtimeEvent } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, assistantInvites, members, rooms } from "../db/schema";
import { createId, createInviteToken } from "../lib/id";
import { toPublicMember } from "../lib/public";
import { broadcastToRoom, verifyWsToken } from "../realtime";
import {
  isSupportedAgentBackendType,
  isUniqueConstraintError,
  isValidDisplayName,
  now,
  resolveInviteExpiry,
} from "./support";

const assistantInviteRoutes = new Hono();

assistantInviteRoutes.post("/api/rooms/:roomId/assistant-invites", async (c) => {
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
  const backendType = isSupportedAgentBackendType(body?.backendType) ? body.backendType : null;

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

  try {
    db.insert(assistantInvites).values(invite).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "assistant invite token conflict" }, 409);
    }

    throw error;
  }

  return c.json(
    {
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
    },
    201,
  );
});

assistantInviteRoutes.post("/api/assistant-invites/:inviteToken/accept", async (c) => {
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
    principalId: null,
    type: "agent",
    roleKind: "assistant",
    displayName,
    ownerMemberId: invite.ownerMemberId,
    sourcePrivateAssistantId: null,
    adapterType: inviteBackendType,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt: now(),
  };

  try {
    db.insert(members).values(member).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "displayName already exists in room" }, 409);
    }

    throw error;
  }

  const binding: AgentBinding = {
    id: createId("agb"),
    memberId: member.id,
    bridgeId: null,
    backendType: inviteBackendType,
    backendThreadId,
    cwd: cwd || null,
    status: inviteBackendType === "codex_cli" ? "pending_bridge" : "active",
    attachedAt: now(),
    detachedAt: null,
  };

  try {
    db.insert(agentBindings).values(binding).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "backendThreadId already bound" }, 409);
    }

    throw error;
  }

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
    payload: { member: toPublicMember(member, binding.status === "pending_bridge" ? "pending_bridge" : "ready") },
  };

  broadcastToRoom(member.roomId, event);

  return c.json(
    {
      memberId: member.id,
      roomId: member.roomId,
      displayName: member.displayName,
      ownerMemberId: member.ownerMemberId,
    },
    201,
  );
});

export { assistantInviteRoutes };
