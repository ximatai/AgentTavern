import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { AgentBinding, Member, PrivateAssistant, RealtimeEvent } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, members, privateAssistants, rooms } from "../db/schema";
import { createId } from "../lib/id";
import { toPublicMember } from "../lib/public";
import { broadcastToRoom, verifyPrincipalToken, verifyWsToken } from "../realtime";
import { isUniqueConstraintError, isValidDisplayName, now } from "./support";

const privateAssistantRoutes = new Hono();

privateAssistantRoutes.get("/api/me/assistants", (c) => {
  const principalId = c.req.query("principalId")?.trim() ?? "";
  const principalToken = c.req.query("principalToken")?.trim() ?? "";

  if (!principalId || !principalToken) {
    return c.json({ error: "principalId and principalToken are required" }, 400);
  }

  if (!verifyPrincipalToken(principalToken, principalId)) {
    return c.json({ error: "invalid principal token" }, 403);
  }

  const items = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.ownerPrincipalId, principalId))
    .all();

  return c.json(items);
});

privateAssistantRoutes.post("/api/me/assistants", async (c) => {
  const body = await c.req.json().catch(() => null);
  const principalId = typeof body?.principalId === "string" ? body.principalId.trim() : "";
  const principalToken =
    typeof body?.principalToken === "string" ? body.principalToken.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const backendType = typeof body?.backendType === "string" ? body.backendType.trim() : "";
  const backendThreadId =
    typeof body?.backendThreadId === "string" ? body.backendThreadId.trim() : "";

  if (!principalId || !principalToken || !name || !backendType) {
    return c.json({ error: "principalId, principalToken, name and backendType are required" }, 400);
  }

  if (!verifyPrincipalToken(principalToken, principalId)) {
    return c.json({ error: "invalid principal token" }, 403);
  }

  if (!isValidDisplayName(name)) {
    return c.json({ error: "name must not contain spaces or @" }, 400);
  }

  if (backendType !== "codex_cli") {
    return c.json({ error: "only codex_cli private assistants are supported for now" }, 400);
  }

  if (!backendThreadId) {
    return c.json({ error: "backendThreadId is required for codex private assistants" }, 400);
  }

  const assistant: PrivateAssistant = {
    id: createId("pa"),
    ownerPrincipalId: principalId,
    name,
    backendType: "codex_cli",
    backendThreadId,
    status: "pending_bridge",
    createdAt: now(),
  };

  try {
    db.insert(privateAssistants).values(assistant).run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return c.json({ error: "private assistant name already exists for this principal" }, 409);
    }

    throw error;
  }

  return c.json(assistant, 201);
});

privateAssistantRoutes.post("/api/rooms/:roomId/assistants/adopt", async (c) => {
  const roomId = c.req.param("roomId");
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();

  if (!room) {
    return c.json({ error: "room not found" }, 404);
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

  if (!actor.principalId) {
    return c.json({ error: "only principal-backed members can adopt private assistants" }, 400);
  }

  const assistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, privateAssistantId))
    .get() as PrivateAssistant | undefined;

  if (!assistant) {
    return c.json({ error: "private assistant not found" }, 404);
  }

  if (assistant.ownerPrincipalId !== actor.principalId) {
    return c.json({ error: "private assistant does not belong to actor principal" }, 403);
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
    return c.json({ error: "private assistant already joined this room" }, 409);
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
    principalId: null,
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

  if (assistant.backendThreadId) {
    const existingBinding = db
      .select()
      .from(agentBindings)
      .where(eq(agentBindings.backendThreadId, assistant.backendThreadId))
      .get();

    if (!existingBinding) {
      const binding: AgentBinding = {
        id: createId("agb"),
        memberId: member.id,
        bridgeId: null,
        backendType: assistant.backendType,
        backendThreadId: assistant.backendThreadId,
        cwd: null,
        status: "pending_bridge",
        attachedAt: now(),
        detachedAt: null,
      };

      db.insert(agentBindings).values(binding).run();
    }
  }

  const event: RealtimeEvent = {
    type: "member.joined",
    roomId,
    timestamp: now(),
    payload: { member: toPublicMember(member, "pending_bridge") },
  };

  broadcastToRoom(roomId, event);

  return c.json(toPublicMember(member, "pending_bridge"), 201);
});

export { privateAssistantRoutes };
