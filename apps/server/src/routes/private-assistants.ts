import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type {
  AgentBackendType,
  AgentBinding,
  Member,
  PrivateAssistant,
  PrivateAssistantStatus,
  PrivateAssistantInvite,
  RealtimeEvent,
} from "@agent-tavern/shared";

import { db } from "../db/client";
import {
  agentBindings,
  localBridges,
  members,
  privateAssistantInvites,
  privateAssistants,
  rooms,
  serverConfigs,
} from "../db/schema";
import { resolveBindingForPrivateAssistant } from "../lib/agent-binding-resolution";
import { createId, createInviteToken } from "../lib/id";
import { resolveMemberRuntimeStatus } from "../lib/member-runtime";
import { toPublicMember } from "../lib/public";
import { broadcastToCitizen, broadcastToRoom, verifyCitizenToken, verifyWsToken } from "../realtime";
import {
  isSupportedAgentBackendType,
  normalizeAgentBackendConfig,
  normalizeAgentBackendThreadId,
  isUniqueConstraintError,
  isValidDisplayName,
  now,
  resolveInviteExpiry,
} from "./support";

const privateAssistantRoutes = new Hono();

function resolveAssistantStatus(assistant: Pick<PrivateAssistant, "id" | "status">): PrivateAssistantStatus {
  if (assistant.status === "paused") {
    return "paused";
  }

  const binding = resolveBindingForPrivateAssistant(assistant.id);
  return (binding?.status as PrivateAssistantStatus | undefined) ?? "pending_bridge";
}

function broadcastPrivateAssistantChanged(
  citizenId: string,
  reason: "assistant_created" | "assistant_updated" | "assistant_deleted",
): void {
  broadcastToCitizen(citizenId, {
    type: "private_assistants.changed",
    citizenId,
    timestamp: now(),
    payload: { reason },
  });
}

function syncPrivateAssistantProjectionPresence(
  assistantId: string,
  presenceStatus: "online" | "offline",
  assistantStatus: PrivateAssistantStatus,
): void {
  const assistantMembers = db
    .select()
    .from(members)
    .where(eq(members.sourcePrivateAssistantId, assistantId))
    .all() as Member[];
  const binding = resolveBindingForPrivateAssistant(assistantId);
  const bridge = binding?.bridgeId
    ? db.select().from(localBridges).where(eq(localBridges.id, binding.bridgeId)).get() ?? null
    : null;

  for (const assistantMember of assistantMembers) {
    const room = db.select().from(rooms).where(eq(rooms.id, assistantMember.roomId)).get();
    if (!room || room.status !== "active") {
      continue;
    }

    db.update(members).set({ presenceStatus }).where(eq(members.id, assistantMember.id)).run();
    const updatedMember = db
      .select()
      .from(members)
      .where(eq(members.id, assistantMember.id))
      .get() as Member | undefined;

    if (!updatedMember) {
      continue;
    }

    broadcastToRoom(updatedMember.roomId, {
      type: "member.updated",
      roomId: updatedMember.roomId,
      timestamp: now(),
      payload: {
        member: toPublicMember(
          updatedMember,
          assistantStatus === "paused"
            ? null
            : resolveMemberRuntimeStatus(updatedMember, binding, bridge),
        ),
      },
    });
  }
}

function ensurePrivateAssistantBinding(assistant: PrivateAssistant): void {
  if (!assistant.backendThreadId) {
    return;
  }

  const existingByAsset = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.privateAssistantId, assistant.id))
    .get() as AgentBinding | undefined;

  const existingByThread = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.backendThreadId, assistant.backendThreadId))
    .get() as AgentBinding | undefined;

  if (existingByThread && existingByThread.privateAssistantId !== assistant.id) {
    throw new Error("backendThreadId already bound");
  }

  if (existingByAsset) {
    db
      .update(agentBindings)
      .set({
        backendType: assistant.backendType,
        backendThreadId: assistant.backendThreadId,
        status: existingByAsset.bridgeId ? existingByAsset.status : "pending_bridge",
      })
      .where(eq(agentBindings.id, existingByAsset.id))
      .run();
    return;
  }

  db.insert(agentBindings).values({
    id: createId("agb"),
    citizenId: null,
    privateAssistantId: assistant.id,
    bridgeId: null,
    backendType: assistant.backendType,
    backendThreadId: assistant.backendThreadId,
    cwd: null,
    status: "pending_bridge",
    attachedAt: now(),
    detachedAt: null,
  }).run();
}

privateAssistantRoutes.get("/api/me/assistants", (c) => {
  const citizenId = c.req.query("citizenId")?.trim() ?? "";
  const citizenToken = c.req.query("citizenToken")?.trim() ?? "";

  if (!citizenId || !citizenToken) {
    return c.json({ error: "citizenId and citizenToken are required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const items = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.ownerCitizenId, citizenId))
    .all();

  return c.json(items.map((item) => ({ ...item, status: resolveAssistantStatus(item as PrivateAssistant) })));
});

privateAssistantRoutes.get("/api/me/assistants/invites", (c) => {
  const citizenId = c.req.query("citizenId")?.trim() ?? "";
  const citizenToken = c.req.query("citizenToken")?.trim() ?? "";

  if (!citizenId || !citizenToken) {
    return c.json({ error: "citizenId and citizenToken are required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const items = db
    .select()
    .from(privateAssistantInvites)
    .where(eq(privateAssistantInvites.ownerCitizenId, citizenId))
    .all();

  return c.json(
    items.map((item) => ({
      ...item,
      inviteUrl: `/private-assistant-invites/${item.inviteToken}`,
    })),
  );
});

privateAssistantRoutes.post("/api/me/assistants", async (c) => {
  const body = await c.req.json().catch(() => null);
  const citizenId = typeof body?.citizenId === "string" ? body.citizenId.trim() : "";
  const citizenToken =
    typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const requestedServerConfigId =
    typeof body?.serverConfigId === "string" ? body.serverConfigId.trim() : "";

  if (!citizenId || !citizenToken || !name) {
    return c.json({ error: "citizenId, citizenToken and name are required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  if (!isValidDisplayName(name)) {
    return c.json({ error: "name must not contain spaces or @" }, 400);
  }

  let backendType = isSupportedAgentBackendType(body?.backendType) ? body.backendType : null;
  let backendConfig: string | null = null;
  let backendConfigError: string | null = null;

  if (requestedServerConfigId) {
    const serverConfig = db
      .select()
      .from(serverConfigs)
      .where(eq(serverConfigs.id, requestedServerConfigId))
      .get();

    if (!serverConfig) {
      return c.json({ error: "server config not found" }, 404);
    }

    if (
      serverConfig.ownerCitizenId !== citizenId &&
      serverConfig.visibility !== "shared"
    ) {
      return c.json({ error: "server config is not available to this citizen" }, 403);
    }

    backendType = serverConfig.backendType as AgentBackendType;
    backendConfig = serverConfig.configPayload;
  } else {
    const normalized = normalizeAgentBackendConfig(backendType, body?.backendConfig);
    backendConfig = normalized.backendConfig;
    backendConfigError = normalized.error;
  }

  const backendThreadId = normalizeAgentBackendThreadId(backendType, "");

  if (backendType !== "openai_compatible") {
    return c.json({ error: "only openai_compatible backend supports direct web setup" }, 400);
  }

  if (backendConfigError) {
    return c.json({ error: backendConfigError }, 400);
  }

  if (!backendThreadId) {
    return c.json({ error: "backendThreadId is required" }, 400);
  }

  const existingAssistant = db
    .select()
    .from(privateAssistants)
    .where(
      and(
        eq(privateAssistants.ownerCitizenId, citizenId),
        eq(privateAssistants.name, name),
      ),
    )
    .get();

  if (existingAssistant) {
    return c.json({ error: "private assistant name already exists for this citizen" }, 409);
  }

  const existingPendingInvite = db
    .select()
    .from(privateAssistantInvites)
    .where(
      and(
        eq(privateAssistantInvites.ownerCitizenId, citizenId),
        eq(privateAssistantInvites.name, name),
        eq(privateAssistantInvites.status, "pending"),
      ),
    )
    .get();

  if (existingPendingInvite) {
    return c.json({ error: "private assistant name already has a pending invite" }, 409);
  }

  const assistant: PrivateAssistant = {
    id: createId("pa"),
    ownerCitizenId: citizenId,
    name,
    backendType,
    backendThreadId,
    backendConfig,
    status: "pending_bridge",
    createdAt: now(),
  };

  try {
    db.insert(privateAssistants).values(assistant).run();
    ensurePrivateAssistantBinding(assistant);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      db.delete(privateAssistants).where(eq(privateAssistants.id, assistant.id)).run();
      return c.json({ error: "private assistant name already exists for this citizen" }, 409);
    }

    if (error instanceof Error && error.message === "backendThreadId already bound") {
      db.delete(privateAssistants).where(eq(privateAssistants.id, assistant.id)).run();
      return c.json({ error: "backendThreadId already bound" }, 409);
    }

    throw error;
  }

  broadcastPrivateAssistantChanged(citizenId, "assistant_created");

  return c.json(assistant, 201);
});

privateAssistantRoutes.post("/api/me/assistants/invites", async (c) => {
  const body = await c.req.json().catch(() => null);
  const citizenId = typeof body?.citizenId === "string" ? body.citizenId.trim() : "";
  const citizenToken =
    typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const backendType = isSupportedAgentBackendType(body?.backendType) ? body.backendType : null;
  const {
    backendConfig,
    error: backendConfigError,
  } = normalizeAgentBackendConfig(backendType, body?.backendConfig);

  if (!citizenId || !citizenToken || !name || !backendType) {
    return c.json({ error: "citizenId, citizenToken, name and backendType are required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  if (!isValidDisplayName(name)) {
    return c.json({ error: "name must not contain spaces or @" }, 400);
  }

  if (backendType === "local_process") {
    return c.json({ error: "local_process backend is not supported for private assistants" }, 400);
  }

  if (backendConfigError) {
    return c.json({ error: backendConfigError }, 400);
  }

  const existingAssistant = db
    .select()
    .from(privateAssistants)
    .where(
      and(
        eq(privateAssistants.ownerCitizenId, citizenId),
        eq(privateAssistants.name, name),
      ),
    )
    .get();

  if (existingAssistant) {
    return c.json({ error: "private assistant name already exists for this citizen" }, 409);
  }

  const existingPendingInvite = db
    .select()
    .from(privateAssistantInvites)
    .where(
      and(
        eq(privateAssistantInvites.ownerCitizenId, citizenId),
        eq(privateAssistantInvites.name, name),
        eq(privateAssistantInvites.status, "pending"),
      ),
    )
    .get();

  if (existingPendingInvite) {
    return c.json(
      {
        ...existingPendingInvite,
        inviteUrl: `/private-assistant-invites/${existingPendingInvite.inviteToken}`,
        reused: true,
      },
      200,
    );
  }

  const invite: PrivateAssistantInvite = {
    id: createId("pai"),
    ownerCitizenId: citizenId,
    name,
    backendType: backendType as AgentBackendType,
    backendConfig,
    status: "pending",
    inviteToken: createInviteToken(),
    acceptedPrivateAssistantId: null,
    createdAt: now(),
    expiresAt: resolveInviteExpiry(),
    acceptedAt: null,
  };

  try {
    db.insert(privateAssistantInvites).values({
      ...invite,
      status: "pending",
    }).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "private assistant invite token conflict" }, 409);
    }

    throw error;
  }

  broadcastToCitizen(citizenId, {
    type: "private_assistants.changed",
    citizenId,
    timestamp: now(),
    payload: { reason: "invite_created" },
  });

  return c.json(
    {
      ...invite,
      inviteUrl: `/private-assistant-invites/${invite.inviteToken}`,
    },
    201,
  );
});

privateAssistantRoutes.post("/api/private-assistant-invites/:inviteToken/accept", async (c) => {
  const inviteToken = c.req.param("inviteToken");
  const invite = db
    .select()
    .from(privateAssistantInvites)
    .where(eq(privateAssistantInvites.inviteToken, inviteToken))
    .get() as PrivateAssistantInvite | undefined;

  if (!invite) {
    return c.json({ error: "private assistant invite not found" }, 404);
  }

  if (invite.status !== "pending") {
    return c.json({ error: "private assistant invite already resolved" }, 409);
  }

  if (!isSupportedAgentBackendType(invite.backendType)) {
    return c.json({ error: "private assistant invite backendType is invalid" }, 500);
  }

  if (invite.expiresAt && invite.expiresAt <= now()) {
    db
      .update(privateAssistantInvites)
      .set({ status: "expired" })
      .where(eq(privateAssistantInvites.id, invite.id))
      .run();
    return c.json({ error: "private assistant invite expired" }, 410);
  }

  const body = await c.req.json().catch(() => null);
  const backendThreadId =
    normalizeAgentBackendThreadId(
      invite.backendType,
      typeof body?.backendThreadId === "string" ? body.backendThreadId.trim() : "",
    ) ?? "";

  if (!backendThreadId) {
    return c.json({ error: "backendThreadId is required" }, 400);
  }

  const bindingConflict = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.backendThreadId, backendThreadId))
    .get();

  if (bindingConflict) {
    return c.json({ error: "backendThreadId already bound" }, 409);
  }

  const existingAssistant = db
    .select()
    .from(privateAssistants)
    .where(
      and(
        eq(privateAssistants.ownerCitizenId, invite.ownerCitizenId),
        eq(privateAssistants.name, invite.name),
      ),
    )
    .get();

  if (existingAssistant) {
    return c.json({ error: "private assistant name already exists for this citizen" }, 409);
  }

  const assistant: PrivateAssistant = {
    id: createId("pa"),
    ownerCitizenId: invite.ownerCitizenId,
    name: invite.name,
    backendType: invite.backendType,
    backendThreadId,
    backendConfig: invite.backendConfig ?? null,
    status: "pending_bridge",
    createdAt: now(),
  };

  try {
    db.insert(privateAssistants).values(assistant).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "private assistant name already exists for this citizen" }, 409);
    }

    throw error;
  }

  try {
    ensurePrivateAssistantBinding(assistant);
  } catch (error) {
    if (error instanceof Error && error.message === "backendThreadId already bound") {
      db.delete(privateAssistants).where(eq(privateAssistants.id, assistant.id)).run();
      return c.json({ error: "backendThreadId already bound" }, 409);
    }

    throw error;
  }

  db
    .update(privateAssistantInvites)
    .set({
      status: "accepted",
      acceptedPrivateAssistantId: assistant.id,
      acceptedAt: now(),
    })
    .where(eq(privateAssistantInvites.id, invite.id))
    .run();

  broadcastToCitizen(invite.ownerCitizenId, {
    type: "private_assistants.changed",
    citizenId: invite.ownerCitizenId,
    timestamp: now(),
    payload: { reason: "invite_accepted" },
  });

  return c.json(assistant, 201);
});

privateAssistantRoutes.delete("/api/me/assistants/invites/:inviteId", (c) => {
  const inviteId = c.req.param("inviteId");
  const citizenId = c.req.query("citizenId")?.trim() ?? "";
  const citizenToken = c.req.query("citizenToken")?.trim() ?? "";

  if (!citizenId || !citizenToken) {
    return c.json({ error: "citizenId and citizenToken are required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const invite = db
    .select()
    .from(privateAssistantInvites)
    .where(eq(privateAssistantInvites.id, inviteId))
    .get() as PrivateAssistantInvite | undefined;

  if (!invite) {
    return c.json({ error: "private assistant invite not found" }, 404);
  }

  if (invite.ownerCitizenId !== citizenId) {
    return c.json({ error: "private assistant invite does not belong to actor citizen" }, 403);
  }

  db.delete(privateAssistantInvites).where(eq(privateAssistantInvites.id, inviteId)).run();

  broadcastToCitizen(citizenId, {
    type: "private_assistants.changed",
    citizenId,
    timestamp: now(),
    payload: { reason: "invite_created" },
  });

  return c.json({ ok: true });
});

privateAssistantRoutes.post("/api/me/assistants/:assistantId/pause", async (c) => {
  const assistantId = c.req.param("assistantId");
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

  const assistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, assistantId))
    .get() as PrivateAssistant | undefined;

  if (!assistant) {
    return c.json({ error: "private assistant not found" }, 404);
  }

  if (assistant.ownerCitizenId !== citizenId) {
    return c.json({ error: "private assistant does not belong to actor citizen" }, 403);
  }

  if (assistant.status !== "paused") {
    db.update(privateAssistants).set({ status: "paused" }).where(eq(privateAssistants.id, assistantId)).run();
    syncPrivateAssistantProjectionPresence(assistantId, "offline", "paused");
    broadcastPrivateAssistantChanged(citizenId, "assistant_updated");
  }

  return c.json({ ...assistant, status: "paused" satisfies PrivateAssistantStatus });
});

privateAssistantRoutes.post("/api/me/assistants/:assistantId/resume", async (c) => {
  const assistantId = c.req.param("assistantId");
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

  const assistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, assistantId))
    .get() as PrivateAssistant | undefined;

  if (!assistant) {
    return c.json({ error: "private assistant not found" }, 404);
  }

  if (assistant.ownerCitizenId !== citizenId) {
    return c.json({ error: "private assistant does not belong to actor citizen" }, 403);
  }

  const resumedStatus = resolveAssistantStatus({ ...assistant, status: "pending_bridge" });
  db
    .update(privateAssistants)
    .set({ status: resumedStatus })
    .where(eq(privateAssistants.id, assistantId))
    .run();
  syncPrivateAssistantProjectionPresence(assistantId, "online", resumedStatus);
  broadcastPrivateAssistantChanged(citizenId, "assistant_updated");

  return c.json({ ...assistant, status: resumedStatus });
});

privateAssistantRoutes.delete("/api/me/assistants/:assistantId", (c) => {
  const assistantId = c.req.param("assistantId");
  const citizenId = c.req.query("citizenId")?.trim() ?? "";
  const citizenToken = c.req.query("citizenToken")?.trim() ?? "";

  if (!citizenId || !citizenToken) {
    return c.json({ error: "citizenId and citizenToken are required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const assistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, assistantId))
    .get() as PrivateAssistant | undefined;

  if (!assistant) {
    return c.json({ error: "private assistant not found" }, 404);
  }

  if (assistant.ownerCitizenId !== citizenId) {
    return c.json({ error: "private assistant does not belong to actor citizen" }, 403);
  }

  const projections = db
    .select()
    .from(members)
    .where(eq(members.sourcePrivateAssistantId, assistantId))
    .all() as Member[];

  for (const projection of projections) {
    db
      .update(members)
      .set({ presenceStatus: "offline" })
      .where(eq(members.id, projection.id))
      .run();

    broadcastToRoom(projection.roomId, {
      type: "member.left",
      roomId: projection.roomId,
      timestamp: now(),
      payload: { memberId: projection.id },
    });
  }

  db
    .update(privateAssistantInvites)
    .set({ status: "revoked", acceptedPrivateAssistantId: null })
    .where(
      and(
        eq(privateAssistantInvites.ownerCitizenId, citizenId),
        eq(privateAssistantInvites.acceptedPrivateAssistantId, assistantId),
      ),
    )
    .run();

  db.delete(agentBindings).where(eq(agentBindings.privateAssistantId, assistant.id)).run();
  db.delete(privateAssistants).where(eq(privateAssistants.id, assistantId)).run();

  broadcastPrivateAssistantChanged(citizenId, "assistant_deleted");

  return c.json({ ok: true });
});

privateAssistantRoutes.post("/api/rooms/:roomId/assistants/adopt", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  if (room.status !== "active") {
    return c.json({ error: "room is archived" }, 410);
  }

  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";
  const privateAssistantId =
    typeof body?.privateAssistantId === "string" ? body.privateAssistantId.trim() : "";

  if (!actorMemberId || !wsToken || !privateAssistantId) {
    return c.json({ error: "actorMemberId, wsToken and privateAssistantId are required" }, 400);
  }

  const actor = db
    .select()
    .from(members)
    .where(and(eq(members.id, actorMemberId), eq(members.roomId, roomId)))
    .get() as Member | undefined;

  if (!actor) {
    return c.json({ error: "actor not found in room" }, 404);
  }

  if (!verifyWsToken(wsToken, actorMemberId, roomId)) {
    return c.json({ error: "invalid wsToken for actor" }, 403);
  }

  if (!actor.citizenId) {
    return c.json({ error: "only citizen-backed members can adopt private assistants" }, 400);
  }

  const assistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, privateAssistantId))
    .get() as PrivateAssistant | undefined;

  if (!assistant) {
    return c.json({ error: "private assistant not found" }, 404);
  }

  if (assistant.ownerCitizenId !== actor.citizenId) {
    return c.json({ error: "private assistant does not belong to actor citizen" }, 403);
  }

  if (assistant.status === "paused") {
    return c.json({ error: "private assistant is temporarily offline" }, 409);
  }

  const existingProjection = db
    .select()
    .from(members)
    .where(
      and(
        eq(members.roomId, roomId),
        eq(members.sourcePrivateAssistantId, privateAssistantId),
      ),
    )
    .get();

  if (existingProjection) {
    if (existingProjection.presenceStatus === "online") {
      return c.json({ error: "private assistant already joined this room" }, 409);
    }

    db
      .update(members)
      .set({
        ownerMemberId: actorMemberId,
        sourcePrivateAssistantId: assistant.id,
        adapterType: assistant.backendType,
        presenceStatus: "online",
      })
      .where(eq(members.id, existingProjection.id))
      .run();

    const reusedMember = db
      .select()
      .from(members)
      .where(eq(members.id, existingProjection.id))
      .get() as Member;

    const event: RealtimeEvent = {
      type: "member.joined",
      roomId,
      timestamp: now(),
      payload: { member: toPublicMember(reusedMember, "pending_bridge") },
    };

    broadcastToRoom(roomId, event);

    return c.json(toPublicMember(reusedMember, "pending_bridge"), 201);
  }

  const dormantProjection = db
    .select()
    .from(members)
    .where(
      and(
        eq(members.roomId, roomId),
        eq(members.displayName, assistant.name),
        eq(members.ownerMemberId, actorMemberId),
        eq(members.roleKind, "assistant"),
        eq(members.presenceStatus, "offline"),
      ),
    )
    .get() as Member | undefined;

  if (dormantProjection) {
    db
      .update(members)
      .set({
        sourcePrivateAssistantId: assistant.id,
        adapterType: assistant.backendType,
        presenceStatus: "online",
      })
      .where(eq(members.id, dormantProjection.id))
      .run();

    const reusedMember = db
      .select()
      .from(members)
      .where(eq(members.id, dormantProjection.id))
      .get() as Member;

    const event: RealtimeEvent = {
      type: "member.joined",
      roomId,
      timestamp: now(),
      payload: { member: toPublicMember(reusedMember, "pending_bridge") },
    };

    broadcastToRoom(roomId, event);

    return c.json(toPublicMember(reusedMember, "pending_bridge"), 201);
  }

  const displayNameConflict = db
    .select()
    .from(members)
    .where(and(eq(members.roomId, roomId), eq(members.displayName, assistant.name)))
    .get();

  if (displayNameConflict) {
    return c.json({ error: "displayName already exists in room" }, 409);
  }

  const member: Member = {
    id: createId("mem"),
    roomId,
    citizenId: null,
    type: "agent",
    roleKind: "assistant",
    displayName: assistant.name,
    ownerMemberId: actorMemberId,
    sourcePrivateAssistantId: assistant.id,
    adapterType: assistant.backendType,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt: now(),
  };

  db.insert(members).values(member).run();

  const event: RealtimeEvent = {
    type: "member.joined",
    roomId,
    timestamp: now(),
    payload: { member: toPublicMember(member, "pending_bridge") },
  };

  broadcastToRoom(roomId, event);

  return c.json(toPublicMember(member, "pending_bridge"), 201);
});

privateAssistantRoutes.post("/api/rooms/:roomId/assistants/:assistantMemberId/offline", async (c) => {
  const roomId = c.req.param("roomId");
  const assistantMemberId = c.req.param("assistantMemberId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  if (room.status !== "active") {
    return c.json({ error: "room is archived" }, 410);
  }

  const body = await c.req.json().catch(() => null);
  const actorMemberId =
    typeof body?.actorMemberId === "string" ? body.actorMemberId.trim() : "";
  const wsToken = typeof body?.wsToken === "string" ? body.wsToken.trim() : "";

  if (!actorMemberId || !wsToken) {
    return c.json({ error: "actorMemberId and wsToken are required" }, 400);
  }

  if (!verifyWsToken(wsToken, actorMemberId, roomId)) {
    return c.json({ error: "invalid wsToken for actor" }, 403);
  }

  const actor = db
    .select()
    .from(members)
    .where(and(eq(members.id, actorMemberId), eq(members.roomId, roomId)))
    .get() as Member | undefined;

  if (!actor) {
    return c.json({ error: "actor not found in room" }, 404);
  }

  const assistantMember = db
    .select()
    .from(members)
    .where(and(eq(members.id, assistantMemberId), eq(members.roomId, roomId)))
    .get() as Member | undefined;

  if (!assistantMember) {
    return c.json({ error: "assistant member not found in room" }, 404);
  }

  if (
    assistantMember.roleKind !== "assistant" ||
    !assistantMember.sourcePrivateAssistantId ||
    assistantMember.ownerMemberId !== actorMemberId
  ) {
    return c.json({ error: "only your private assistant projections can be taken offline" }, 403);
  }

  db
    .update(members)
    .set({ presenceStatus: "offline" })
    .where(eq(members.id, assistantMember.id))
    .run();

  broadcastToRoom(roomId, {
    type: "member.left",
    roomId,
    timestamp: now(),
    payload: { memberId: assistantMember.id },
  });

  return c.json({ ok: true });
});

export { privateAssistantRoutes };
