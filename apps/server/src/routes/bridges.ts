import { and, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";

import type { Member } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, localBridges, members } from "../db/schema";
import { createId, createInviteToken } from "../lib/id";
import { resolveMemberRuntimeStatus } from "../lib/member-runtime";
import { toPublicMember } from "../lib/public";
import { broadcastToRoom } from "../realtime";
import { now } from "./support";

const bridgeRoutes = new Hono();

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type StoredBridge = {
  id: string;
  bridgeName: string;
  bridgeToken: string;
  currentInstanceId: string | null;
  status: string;
  platform: string | null;
  version: string | null;
  metadata: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

function autoAttachPendingBindingsToSoleOnlineBridge(bridge: StoredBridge): void {
  const onlineBridges = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.status, "online"))
    .all() as StoredBridge[];

  if (onlineBridges.length !== 1 || onlineBridges[0]?.id !== bridge.id) {
    return;
  }

  const pendingBindings = db
    .select()
    .from(agentBindings)
    .where(and(isNull(agentBindings.bridgeId), eq(agentBindings.status, "pending_bridge")))
    .all();

  if (pendingBindings.length === 0) {
    return;
  }

  for (const binding of pendingBindings) {
    const timestamp = now();
    const result = db
      .update(agentBindings)
      .set({
        bridgeId: bridge.id,
        status: "active",
        attachedAt: timestamp,
        detachedAt: null,
      })
      .where(
        and(
          eq(agentBindings.id, binding.id),
          isNull(agentBindings.bridgeId),
          eq(agentBindings.status, "pending_bridge"),
        ),
      )
      .run();

    if (result.changes === 0) {
      continue;
    }

    broadcastBindingMemberUpdates({
      principalId: binding.principalId,
      privateAssistantId: binding.privateAssistantId,
      bridge,
    });
  }
}

function broadcastBindingMemberUpdates(params: {
  principalId: string | null;
  privateAssistantId: string | null;
  bridge: StoredBridge;
}): void {
  if (!params.principalId && !params.privateAssistantId) {
    return;
  }

  const linkedMembers = db
    .select()
    .from(members)
    .all()
    .filter((member) => {
      if (params.principalId && member.principalId === params.principalId) {
        return true;
      }
      if (
        params.privateAssistantId &&
        member.sourcePrivateAssistantId === params.privateAssistantId
      ) {
        return true;
      }
      return false;
    }) as Member[];

  for (const member of linkedMembers) {
    broadcastToRoom(member.roomId, {
      type: "member.updated",
      roomId: member.roomId,
      timestamp: now(),
      payload: {
        member: toPublicMember(
          member,
          resolveMemberRuntimeStatus(
            member,
            { bridgeId: params.bridge.id, status: "active" },
            params.bridge,
          ),
        ),
      },
    });
  }
}

bridgeRoutes.post("/api/bridges/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  const bridgeName = typeof body?.bridgeName === "string" ? body.bridgeName.trim() : "";
  const existingBridgeId =
    typeof body?.bridgeId === "string" ? body.bridgeId.trim() : "";
  const existingBridgeToken =
    typeof body?.bridgeToken === "string" ? body.bridgeToken.trim() : "";
  const bridgeInstanceId =
    typeof body?.bridgeInstanceId === "string" ? body.bridgeInstanceId.trim() : "";
  const platform = normalizeOptionalString(body?.platform);
  const version = normalizeOptionalString(body?.version);
  const metadataProvided = Object.prototype.hasOwnProperty.call(body ?? {}, "metadata");
  const metadata =
    body?.metadata && typeof body.metadata === "object"
      ? JSON.stringify(body.metadata)
      : null;

  if (!bridgeName) {
    return c.json({ error: "bridgeName is required" }, 400);
  }

  if (!bridgeInstanceId) {
    return c.json({ error: "bridgeInstanceId is required" }, 400);
  }

  const timestamp = now();

  if (existingBridgeId && existingBridgeToken) {
    const bridge = db
      .select()
      .from(localBridges)
      .where(eq(localBridges.id, existingBridgeId))
      .get();

    if (!bridge || bridge.bridgeToken !== existingBridgeToken) {
      return c.json({ error: "invalid bridge credentials" }, 403);
    }

    db
      .update(localBridges)
      .set({
        bridgeName,
        currentInstanceId: bridgeInstanceId,
        status: "online",
        platform,
        version,
        metadata: metadataProvided ? metadata : bridge.metadata,
        lastSeenAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(localBridges.id, bridge.id))
      .run();

    const refreshedBridge = db
      .select()
      .from(localBridges)
      .where(eq(localBridges.id, bridge.id))
      .get() as StoredBridge;

    autoAttachPendingBindingsToSoleOnlineBridge(refreshedBridge);

    return c.json({
      bridgeId: bridge.id,
      bridgeToken: bridge.bridgeToken,
      bridgeInstanceId,
      status: "online",
      lastSeenAt: timestamp,
    });
  }

  const bridge: StoredBridge = {
    id: createId("brg"),
    bridgeName,
    bridgeToken: createInviteToken(),
    currentInstanceId: bridgeInstanceId,
    status: "online",
    platform,
    version,
    metadata,
    lastSeenAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  db.insert(localBridges).values(bridge).run();
  autoAttachPendingBindingsToSoleOnlineBridge(bridge);

  return c.json(
    {
      bridgeId: bridge.id,
      bridgeToken: bridge.bridgeToken,
      bridgeInstanceId,
      status: bridge.status,
      lastSeenAt: bridge.lastSeenAt,
    },
    201,
  );
});

bridgeRoutes.post("/api/bridges/:bridgeId/heartbeat", async (c) => {
  const bridgeId = c.req.param("bridgeId");
  const body = await c.req.json().catch(() => null);
  const bridgeToken = typeof body?.bridgeToken === "string" ? body.bridgeToken.trim() : "";
  const bridgeInstanceId =
    typeof body?.bridgeInstanceId === "string" ? body.bridgeInstanceId.trim() : "";
  const metadataProvided = Object.prototype.hasOwnProperty.call(body ?? {}, "metadata");
  const metadata =
    body?.metadata && typeof body.metadata === "object"
      ? JSON.stringify(body.metadata)
      : null;

  if (!bridgeToken || !bridgeInstanceId) {
    return c.json({ error: "bridgeToken and bridgeInstanceId are required" }, 400);
  }

  const bridge = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, bridgeId))
    .get();

  if (!bridge) {
    return c.json({ error: "bridge not found" }, 404);
  }

  if (bridge.bridgeToken !== bridgeToken) {
    return c.json({ error: "invalid bridge credentials" }, 403);
  }

  if (bridge.currentInstanceId && bridge.currentInstanceId !== bridgeInstanceId) {
    return c.json({ error: "stale bridge instance" }, 409);
  }

  const timestamp = now();

  db
    .update(localBridges)
    .set({
      currentInstanceId: bridgeInstanceId,
      status: "online",
      metadata: metadataProvided ? metadata : bridge.metadata,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(localBridges.id, bridgeId))
    .run();

  const refreshedBridge = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, bridgeId))
    .get() as StoredBridge;

  autoAttachPendingBindingsToSoleOnlineBridge(refreshedBridge);

  return c.json({
    bridgeId,
    bridgeInstanceId,
    status: "online",
    lastSeenAt: timestamp,
  });
});

bridgeRoutes.post("/api/bridges/:bridgeId/agents/attach", async (c) => {
  const bridgeId = c.req.param("bridgeId");
  const body = await c.req.json().catch(() => null);
  const bridgeToken = typeof body?.bridgeToken === "string" ? body.bridgeToken.trim() : "";
  const backendThreadId =
    typeof body?.backendThreadId === "string" ? body.backendThreadId.trim() : "";
  const memberId = typeof body?.memberId === "string" ? body.memberId.trim() : "";
  const principalId = typeof body?.principalId === "string" ? body.principalId.trim() : "";
  const privateAssistantId =
    typeof body?.privateAssistantId === "string" ? body.privateAssistantId.trim() : "";
  const cwd = normalizeOptionalString(body?.cwd);

  if (!bridgeToken) {
    return c.json({ error: "bridgeToken is required" }, 400);
  }

  if (!backendThreadId && !memberId && !principalId && !privateAssistantId) {
    return c.json(
      { error: "backendThreadId, memberId, principalId or privateAssistantId is required" },
      400,
    );
  }

  const bridge = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, bridgeId))
    .get();

  if (!bridge) {
    return c.json({ error: "bridge not found" }, 404);
  }

  if (bridge.bridgeToken !== bridgeToken) {
    return c.json({ error: "invalid bridge credentials" }, 403);
  }

  const resolvedMember = memberId
    ? db.select().from(members).where(eq(members.id, memberId)).get() ?? null
    : null;
  const resolvedPrincipalId = principalId || resolvedMember?.principalId || "";
  const resolvedPrivateAssistantId =
    privateAssistantId || resolvedMember?.sourcePrivateAssistantId || "";

  const bindingByThread = backendThreadId
    ? db
        .select()
        .from(agentBindings)
        .where(eq(agentBindings.backendThreadId, backendThreadId))
        .get()
    : null;
  const bindingByPrincipal = resolvedPrincipalId
    ? db
        .select()
        .from(agentBindings)
        .where(eq(agentBindings.principalId, resolvedPrincipalId))
        .get()
    : null;
  const bindingByPrivateAssistant = resolvedPrivateAssistantId
    ? db
        .select()
        .from(agentBindings)
        .where(eq(agentBindings.privateAssistantId, resolvedPrivateAssistantId))
        .get()
    : null;

  const resolvedBindings = [bindingByThread, bindingByPrincipal, bindingByPrivateAssistant].filter(
    Boolean,
  );
  const uniqueBindingIds = new Set(resolvedBindings.map((binding) => binding!.id));

  if (uniqueBindingIds.size > 1) {
    return c.json({ error: "attach targets do not match the same binding" }, 400);
  }

  const binding = bindingByThread ?? bindingByPrincipal ?? bindingByPrivateAssistant;

  if (!binding) {
    return c.json({ error: "agent binding not found" }, 404);
  }

  if (binding.bridgeId && binding.bridgeId !== bridgeId) {
    return c.json({ error: "agent binding already attached to another bridge" }, 409);
  }

  const timestamp = now();

  const result = db
    .update(agentBindings)
    .set({
      bridgeId,
      cwd: cwd ?? binding.cwd,
      status: "active",
      attachedAt: timestamp,
      detachedAt: null,
    })
    .where(
      and(
        eq(agentBindings.id, binding.id),
        backendThreadId ? eq(agentBindings.backendThreadId, binding.backendThreadId) : eq(agentBindings.id, binding.id),
        or(isNull(agentBindings.bridgeId), eq(agentBindings.bridgeId, bridgeId)),
      ),
    )
    .run();

  if (result.changes === 0) {
    const latestBinding = db
      .select()
      .from(agentBindings)
      .where(eq(agentBindings.id, binding.id))
      .get();

    if (latestBinding?.bridgeId && latestBinding.bridgeId !== bridgeId) {
      return c.json({ error: "agent binding already attached to another bridge" }, 409);
    }

    return c.json({ error: "agent binding attach conflict" }, 409);
  }

  broadcastBindingMemberUpdates({
    principalId: binding.principalId,
    privateAssistantId: binding.privateAssistantId,
    bridge: bridge as StoredBridge,
  });

  return c.json({
    bindingId: binding.id,
    principalId: binding.principalId,
    privateAssistantId: binding.privateAssistantId,
    bridgeId,
    backendThreadId: binding.backendThreadId,
    status: "active",
  });
});

export { bridgeRoutes };
