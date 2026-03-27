import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type {
  AgentBackendType,
  AgentBinding,
  AssistantInvite,
  Member,
  PrivateAssistant,
  RealtimeEvent,
} from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, assistantInvites, members, privateAssistants, rooms } from "../db/schema";
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
type DbExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete">;

function ensurePrivateAssistantBinding(
  assistant: PrivateAssistant,
  cwd: string | null,
  database: DbExecutor = db,
): void {
  if (!assistant.backendThreadId) {
    return;
  }

  const existingByAsset = database
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.privateAssistantId, assistant.id))
    .get() as AgentBinding | undefined;

  const existingByThread = database
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.backendThreadId, assistant.backendThreadId))
    .get() as AgentBinding | undefined;

  if (existingByThread && existingByThread.privateAssistantId !== assistant.id) {
    throw new Error("backendThreadId already bound");
  }

  if (existingByAsset) {
    database
      .update(agentBindings)
      .set({
        backendType: assistant.backendType,
        backendThreadId: assistant.backendThreadId,
        cwd: cwd ?? existingByAsset.cwd,
        status: existingByAsset.bridgeId ? existingByAsset.status : "pending_bridge",
      })
      .where(eq(agentBindings.id, existingByAsset.id))
      .run();
    return;
  }

  database.insert(agentBindings).values({
    id: createId("agb"),
    principalId: null,
    privateAssistantId: assistant.id,
    bridgeId: null,
    backendType: assistant.backendType,
    backendThreadId: assistant.backendThreadId,
    cwd,
    status: assistant.backendType !== "local_process" ? "pending_bridge" : "active",
    attachedAt: now(),
    detachedAt: null,
  }).run();
}

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

  if (!actor.principalId) {
    return c.json({ error: "only principal-backed members can invite assistants" }, 400);
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
    acceptedPrivateAssistantId: null,
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

  const owner = db
    .select()
    .from(members)
    .where(eq(members.id, invite.ownerMemberId))
    .get() as Member | undefined;

  if (!owner || owner.roomId !== invite.roomId) {
    return c.json({ error: "assistant invite owner not found in room" }, 409);
  }

  if (!owner.principalId) {
    return c.json({ error: "assistant invite owner must be principal-backed" }, 409);
  }

  try {
    const accepted = db.transaction((tx) => {
      let assistant = tx
        .select()
        .from(privateAssistants)
        .where(
          and(
            eq(privateAssistants.ownerPrincipalId, owner.principalId!),
            eq(privateAssistants.backendThreadId, backendThreadId),
          ),
        )
        .get() as PrivateAssistant | undefined;

      const existingBinding = tx
        .select()
        .from(agentBindings)
        .where(eq(agentBindings.backendThreadId, backendThreadId))
        .get() as AgentBinding | undefined;

      if (existingBinding) {
        if (!existingBinding.privateAssistantId) {
          throw new Error("backendThreadId already bound");
        }

        const bindingAssistant = tx
          .select()
          .from(privateAssistants)
          .where(eq(privateAssistants.id, existingBinding.privateAssistantId))
          .get() as PrivateAssistant | undefined;

        if (!bindingAssistant || bindingAssistant.ownerPrincipalId !== owner.principalId) {
          throw new Error("backendThreadId already bound");
        }

        assistant = bindingAssistant;
      }

      const namedAssistant = tx
        .select()
        .from(privateAssistants)
        .where(
          and(
            eq(privateAssistants.ownerPrincipalId, owner.principalId!),
            eq(privateAssistants.name, displayName),
          ),
        )
        .get() as PrivateAssistant | undefined;

      if (namedAssistant && namedAssistant.backendThreadId !== backendThreadId) {
        throw new Error("private assistant name already exists for this principal");
      }

      if (!assistant && namedAssistant) {
        assistant = namedAssistant;
      }

      const projectionDisplayName = assistant?.name ?? displayName;
      const existingProjection = assistant
        ? (tx
            .select()
            .from(members)
            .where(
              and(
                eq(members.roomId, invite.roomId),
                eq(members.sourcePrivateAssistantId, assistant.id),
              ),
            )
            .get() as Member | undefined)
        : undefined;

      const displayNameConflict = tx
        .select()
        .from(members)
        .where(and(eq(members.roomId, invite.roomId), eq(members.displayName, projectionDisplayName)))
        .get() as Member | undefined;

      if (
        displayNameConflict &&
        (!existingProjection || displayNameConflict.id !== existingProjection.id)
      ) {
        throw new Error("displayName already exists in room");
      }

      if (!assistant) {
        assistant = {
          id: createId("pa"),
          ownerPrincipalId: owner.principalId!,
          name: displayName,
          backendType: inviteBackendType,
          backendThreadId,
          status: inviteBackendType !== "local_process" ? "pending_bridge" : "active",
          createdAt: now(),
        };

        tx.insert(privateAssistants).values(assistant).run();
      }

      let member: Member;
      if (existingProjection) {
        tx
          .update(members)
          .set({
            displayName: assistant.name,
            ownerMemberId: invite.ownerMemberId,
            adapterType: inviteBackendType,
            presenceStatus: "online",
          })
          .where(eq(members.id, existingProjection.id))
          .run();

        member = tx
          .select()
          .from(members)
          .where(eq(members.id, existingProjection.id))
          .get() as Member;
      } else {
        member = {
          id: createId("mem"),
          roomId: invite.roomId,
          principalId: null,
          type: "agent",
          roleKind: "assistant",
          displayName: assistant.name,
          ownerMemberId: invite.ownerMemberId,
          sourcePrivateAssistantId: assistant.id,
          adapterType: inviteBackendType,
          adapterConfig: null,
          presenceStatus: "online",
          createdAt: now(),
        };

        tx.insert(members).values(member).run();
      }

      ensurePrivateAssistantBinding(assistant, cwd || null, tx);
      const binding = tx
        .select()
        .from(agentBindings)
        .where(eq(agentBindings.privateAssistantId, assistant.id))
        .get() as AgentBinding | undefined;

      tx
        .update(assistantInvites)
        .set({
          status: "accepted",
          acceptedMemberId: member.id,
          acceptedPrivateAssistantId: assistant.id,
          acceptedAt: now(),
        })
        .where(eq(assistantInvites.id, invite.id))
        .run();

      return { assistant, member, binding };
    });

    const event: RealtimeEvent = {
      type: "member.joined",
      roomId: accepted.member.roomId,
      timestamp: now(),
      payload: {
        member: toPublicMember(
          accepted.member,
          accepted.binding?.status === "pending_bridge" ? "pending_bridge" : "ready",
        ),
      },
    };

    broadcastToRoom(accepted.member.roomId, event);

    return c.json(
      {
        memberId: accepted.member.id,
        roomId: accepted.member.roomId,
        displayName: accepted.member.displayName,
        ownerMemberId: accepted.member.ownerMemberId,
        privateAssistantId: accepted.assistant.id,
      },
      201,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "backendThreadId already bound") {
      return c.json({ error: "backendThreadId already bound" }, 409);
    }
    if (error instanceof Error && error.message === "displayName already exists in room") {
      return c.json({ error: "displayName already exists in room" }, 409);
    }
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "private assistant name already exists for this principal" }, 409);
    }

    throw error;
  }
});

export { assistantInviteRoutes };
