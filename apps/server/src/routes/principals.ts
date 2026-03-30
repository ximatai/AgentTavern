import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { Principal, PrincipalKind } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, localBridges, members, principals } from "../db/schema";
import { resolveBindingForPrincipal } from "../lib/agent-binding-resolution";
import { createId } from "../lib/id";
import { resolveMemberRuntimeStatus } from "../lib/member-runtime";
import { toPublicMember } from "../lib/public";
import {
  broadcastToRoom,
  issuePrincipalToken,
  revokePrincipalTokensForPrincipal,
  revokeWsTokensForMember,
  verifyPrincipalToken,
} from "../realtime";
import {
  isSupportedAgentBackendType,
  normalizeAgentBackendConfig,
  normalizeAgentBackendThreadId,
  now,
} from "./support";

const principalRoutes = new Hono();
type DbExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete">;

function isPrincipalKind(value: unknown): value is PrincipalKind {
  return value === "human" || value === "agent";
}

function toPublicBackendConfig(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function ensureAgentPrincipalBinding(principal: Principal, database: DbExecutor = db): void {
  if (principal.kind !== "agent" || !principal.backendThreadId) {
    return;
  }

  const existingByOwner = database
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.principalId, principal.id))
    .get();

  const existingByThread = database
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.backendThreadId, principal.backendThreadId))
    .get();

  if (existingByThread && existingByThread.principalId !== principal.id) {
    throw new Error("backendThreadId already bound");
  }

  const timestamp = now();

  if (existingByOwner) {
    database
      .update(agentBindings)
      .set({
        backendType: principal.backendType!,
        backendThreadId: principal.backendThreadId,
        status: existingByOwner.bridgeId ? existingByOwner.status : "pending_bridge",
        detachedAt: existingByOwner.detachedAt,
      })
      .where(eq(agentBindings.id, existingByOwner.id))
      .run();
    return;
  }

  database.insert(agentBindings).values({
    id: createId("agb"),
    principalId: principal.id,
    privateAssistantId: null,
    bridgeId: null,
    backendType: principal.backendType!,
    backendThreadId: principal.backendThreadId,
    cwd: null,
    status: "pending_bridge",
    attachedAt: timestamp,
    detachedAt: null,
  }).run();
}

principalRoutes.post("/api/principals/bootstrap", async (c) => {
  const body = await c.req.json().catch(() => null);
  const kind = isPrincipalKind(body?.kind) ? body.kind : "human";
  const loginKey = typeof body?.loginKey === "string" ? body.loginKey.trim() : "";
  const globalDisplayName =
    typeof body?.globalDisplayName === "string" ? body.globalDisplayName.trim() : "";
  const backendType = typeof body?.backendType === "string" ? body.backendType.trim() : "";
  const requestedBackendThreadId =
    typeof body?.backendThreadId === "string" ? body.backendThreadId.trim() : "";
  const resolvedBackendType = kind === "agent" && isSupportedAgentBackendType(backendType)
    ? backendType
    : null;
  const backendThreadId = normalizeAgentBackendThreadId(resolvedBackendType, requestedBackendThreadId);
  const {
    backendConfig,
    error: backendConfigError,
  } = normalizeAgentBackendConfig(resolvedBackendType, body?.backendConfig);

  if (!loginKey || !globalDisplayName) {
    return c.json({ error: "kind, loginKey and globalDisplayName are required" }, 400);
  }

  if (kind === "agent" && !resolvedBackendType) {
    return c.json({ error: "agent principal requires a supported backendType" }, 400);
  }

  if (kind === "agent" && !backendThreadId) {
    return c.json({ error: "agent principal requires backendThreadId" }, 400);
  }

  if (kind === "agent" && backendConfigError) {
    return c.json({ error: backendConfigError }, 400);
  }

  const existing = db
    .select()
    .from(principals)
    .where(and(eq(principals.kind, kind), eq(principals.loginKey, loginKey)))
    .get() as Principal | undefined;

  if (existing) {
    try {
      const updatedMemberIds = new Set<string>();
      const oldGlobalDisplayName = existing.globalDisplayName;
      const updated = db.transaction((tx) => {
        if (kind === "agent") {
          if (!backendThreadId) {
            throw new Error("backendThreadId is required");
          }
          const conflictingBinding = tx
            .select()
            .from(agentBindings)
            .where(eq(agentBindings.backendThreadId, backendThreadId))
            .get();

          if (conflictingBinding && conflictingBinding.principalId !== existing.id) {
            throw new Error("backendThreadId already bound");
          }
        }

        if (
          existing.globalDisplayName !== globalDisplayName ||
          existing.backendType !== (kind === "agent" ? resolvedBackendType : null) ||
          existing.backendThreadId !== (kind === "agent" ? backendThreadId : null) ||
          (existing.backendConfig ?? null) !== (kind === "agent" ? backendConfig : null)
        ) {
          tx
            .update(principals)
            .set({
              globalDisplayName,
              backendType: kind === "agent" ? resolvedBackendType : null,
              backendThreadId: kind === "agent" ? backendThreadId : null,
              backendConfig: kind === "agent" ? backendConfig : null,
            })
            .where(eq(principals.id, existing.id))
            .run();
        }

        if (oldGlobalDisplayName !== globalDisplayName) {
          const syncedMembers = tx
            .select()
            .from(members)
            .where(and(eq(members.principalId, existing.id), eq(members.displayName, oldGlobalDisplayName)))
            .all();

          if (syncedMembers.length > 0) {
            tx
              .update(members)
              .set({ displayName: globalDisplayName })
              .where(and(eq(members.principalId, existing.id), eq(members.displayName, oldGlobalDisplayName)))
              .run();

            syncedMembers.forEach((member) => updatedMemberIds.add(member.id));
          }
        }

        const refreshed = tx
          .select()
          .from(principals)
          .where(eq(principals.id, existing.id))
          .get() as Principal;

        ensureAgentPrincipalBinding(refreshed, tx);
        return refreshed;
      });

      if (updatedMemberIds.size > 0) {
        const refreshedMembers = db
          .select()
          .from(members)
          .where(eq(members.principalId, existing.id))
          .all()
          .filter((member) => updatedMemberIds.has(member.id));
        const binding = updated.kind === "agent" ? resolveBindingForPrincipal(updated.id) : null;
        const bridge = binding?.bridgeId
          ? db.select().from(localBridges).where(eq(localBridges.id, binding.bridgeId)).get() ?? null
          : null;

        for (const member of refreshedMembers) {
          broadcastToRoom(member.roomId, {
            type: "member.updated",
            roomId: member.roomId,
            timestamp: now(),
            payload: {
              member: toPublicMember(
                member as never,
                resolveMemberRuntimeStatus(member as never, binding, bridge),
              ),
            },
          });
        }
      }

      return c.json({
        principalId: updated.id,
        principalToken: issuePrincipalToken(updated.id),
        kind: updated.kind,
        loginKey: updated.loginKey,
        globalDisplayName: updated.globalDisplayName,
        backendType: updated.backendType ?? null,
        backendThreadId: updated.backendThreadId ?? null,
        backendConfig: toPublicBackendConfig(updated.backendConfig ?? null),
        status: updated.status,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "backendThreadId already bound") {
        return c.json({ error: "backendThreadId already bound" }, 409);
      }

      throw error;
    }
  }

  const principal: Principal = {
    id: createId("prn"),
    kind,
    loginKey,
    globalDisplayName,
    backendType: kind === "agent" ? resolvedBackendType : null,
    backendThreadId: kind === "agent" ? backendThreadId : null,
    backendConfig: kind === "agent" ? backendConfig : null,
    status: "offline",
    createdAt: now(),
  };

  try {
    db.transaction((tx) => {
      if (kind === "agent") {
        if (!backendThreadId) {
          throw new Error("backendThreadId is required");
        }
        const conflictingBinding = tx
          .select()
          .from(agentBindings)
          .where(eq(agentBindings.backendThreadId, backendThreadId))
          .get();

        if (conflictingBinding) {
          throw new Error("backendThreadId already bound");
        }
      }

      tx.insert(principals).values(principal).run();
      ensureAgentPrincipalBinding(principal, tx);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "backendThreadId already bound") {
      return c.json({ error: "backendThreadId already bound" }, 409);
    }

    throw error;
  }

  return c.json({
    principalId: principal.id,
    principalToken: issuePrincipalToken(principal.id),
    kind: principal.kind,
    loginKey: principal.loginKey,
    globalDisplayName: principal.globalDisplayName,
    backendType: principal.backendType ?? null,
    backendThreadId: principal.backendThreadId ?? null,
    backendConfig: toPublicBackendConfig(principal.backendConfig ?? null),
    status: principal.status,
  });
});

principalRoutes.post("/api/principals/:principalId/leave-system", async (c) => {
  const principalId = c.req.param("principalId");
  const principal = db
    .select()
    .from(principals)
    .where(eq(principals.id, principalId))
    .get() as Principal | undefined;

  if (!principal) {
    return c.json({ error: "principal not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const principalToken =
    typeof body?.principalToken === "string" ? body.principalToken.trim() : "";

  if (!principalToken) {
    return c.json({ error: "principalToken is required" }, 400);
  }

  if (!verifyPrincipalToken(principalToken, principalId)) {
    return c.json({ error: "invalid principal token" }, 403);
  }

  const timestamp = now();
  const roomMemberships = db
    .select()
    .from(members)
    .where(eq(members.principalId, principalId))
    .all();

  db.transaction((tx) => {
    tx
      .update(members)
      .set({
        principalId: null,
        presenceStatus: "offline",
        membershipStatus: "left",
        leftAt: timestamp,
      })
      .where(eq(members.principalId, principalId))
      .run();
    tx.update(principals).set({ status: "offline" }).where(eq(principals.id, principalId)).run();
    tx
      .update(agentBindings)
      .set({
        bridgeId: null,
        status: "detached",
        detachedAt: timestamp,
      })
      .where(eq(agentBindings.principalId, principalId))
      .run();
  });

  for (const membership of roomMemberships) {
    revokeWsTokensForMember(membership.id, membership.roomId);
    broadcastToRoom(membership.roomId, {
      type: "member.left",
      roomId: membership.roomId,
      timestamp,
      payload: { memberId: membership.id },
    });
  }

  revokePrincipalTokensForPrincipal(principalId);

  return c.json({
    principalId,
    leftSystem: true,
    removedRoomCount: roomMemberships.length,
    removedMemberIds: roomMemberships.map((membership) => membership.id),
  });
});

principalRoutes.get("/api/presence/lobby", (c) => {
  const allPrincipals = db
    .select()
    .from(principals)
    .all();

  return c.json({
    principals: allPrincipals
      .map((principal) => {
        const binding = principal.kind === "agent"
          ? resolveBindingForPrincipal(principal.id)
          : null;
        const bridge = binding?.bridgeId
          ? db.select().from(localBridges).where(eq(localBridges.id, binding.bridgeId)).get() ?? null
          : null;
        const runtimeStatus = principal.kind === "agent"
          ? resolveMemberRuntimeStatus(
              {
                type: "agent",
                adapterType: principal.backendType ?? null,
              },
              binding,
              bridge,
            )
          : null;
        const visibleInLobby = principal.kind === "human"
          ? principal.status === "online"
          : Boolean(
              binding &&
              (binding.status === "active" || binding.status === "pending_bridge"),
            );

        return {
          visibleInLobby,
          principal: {
            principalId: principal.id,
            id: principal.id,
            kind: principal.kind,
            loginKey: principal.loginKey,
            globalDisplayName: principal.globalDisplayName,
            backendType: principal.backendType ?? null,
            backendThreadId: principal.backendThreadId ?? null,
            backendConfig: toPublicBackendConfig(principal.backendConfig ?? null),
            status: visibleInLobby ? "online" : principal.status,
            createdAt: principal.createdAt,
            runtimeStatus,
          },
        };
      })
      .filter((entry) => entry.visibleInLobby)
      .map((entry) => entry.principal),
  });
});

export { principalRoutes };
