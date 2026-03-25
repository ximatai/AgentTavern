import { and, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/client";
import { agentBindings, localBridges } from "../db/schema";
import { createId, createInviteToken } from "../lib/id";
import { now } from "./support";

const bridgeRoutes = new Hono();

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type StoredBridge = {
  id: string;
  bridgeName: string;
  bridgeToken: string;
  status: string;
  platform: string | null;
  version: string | null;
  metadata: string | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

bridgeRoutes.post("/api/bridges/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  const bridgeName = typeof body?.bridgeName === "string" ? body.bridgeName.trim() : "";
  const existingBridgeId =
    typeof body?.bridgeId === "string" ? body.bridgeId.trim() : "";
  const existingBridgeToken =
    typeof body?.bridgeToken === "string" ? body.bridgeToken.trim() : "";
  const platform = normalizeOptionalString(body?.platform);
  const version = normalizeOptionalString(body?.version);
  const metadata =
    body?.metadata && typeof body.metadata === "object"
      ? JSON.stringify(body.metadata)
      : null;

  if (!bridgeName) {
    return c.json({ error: "bridgeName is required" }, 400);
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
        status: "online",
        platform,
        version,
        metadata,
        lastSeenAt: timestamp,
        updatedAt: timestamp,
      })
      .where(eq(localBridges.id, bridge.id))
      .run();

    return c.json({
      bridgeId: bridge.id,
      bridgeToken: bridge.bridgeToken,
      status: "online",
      lastSeenAt: timestamp,
    });
  }

  const bridge: StoredBridge = {
    id: createId("brg"),
    bridgeName,
    bridgeToken: createInviteToken(),
    status: "online",
    platform,
    version,
    metadata,
    lastSeenAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  db.insert(localBridges).values(bridge).run();

  return c.json(
    {
      bridgeId: bridge.id,
      bridgeToken: bridge.bridgeToken,
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
  const metadataProvided = Object.prototype.hasOwnProperty.call(body ?? {}, "metadata");
  const metadata =
    body?.metadata && typeof body.metadata === "object"
      ? JSON.stringify(body.metadata)
      : null;

  if (!bridgeToken) {
    return c.json({ error: "bridgeToken is required" }, 400);
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

  const timestamp = now();

  db
    .update(localBridges)
    .set({
      status: "online",
      metadata: metadataProvided ? metadata : bridge.metadata,
      lastSeenAt: timestamp,
      updatedAt: timestamp,
    })
    .where(eq(localBridges.id, bridgeId))
    .run();

  return c.json({
    bridgeId,
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
  const cwd = normalizeOptionalString(body?.cwd);

  if (!bridgeToken) {
    return c.json({ error: "bridgeToken is required" }, 400);
  }

  if (!backendThreadId && !memberId) {
    return c.json({ error: "backendThreadId or memberId is required" }, 400);
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

  const bindingByThread = backendThreadId
    ? db
        .select()
        .from(agentBindings)
        .where(eq(agentBindings.backendThreadId, backendThreadId))
        .get()
    : null;
  const bindingByMember = memberId
    ? db
        .select()
        .from(agentBindings)
        .where(eq(agentBindings.memberId, memberId))
        .get()
    : null;

  if (
    bindingByThread &&
    bindingByMember &&
    bindingByThread.id !== bindingByMember.id
  ) {
    return c.json({ error: "backendThreadId and memberId do not match the same binding" }, 400);
  }

  const binding = bindingByThread ?? bindingByMember;

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
        backendThreadId
          ? eq(agentBindings.backendThreadId, binding.backendThreadId)
          : eq(agentBindings.memberId, binding.memberId),
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

  return c.json({
    bindingId: binding.id,
    memberId: binding.memberId,
    bridgeId,
    backendThreadId: binding.backendThreadId,
    status: "active",
  });
});

export { bridgeRoutes };
