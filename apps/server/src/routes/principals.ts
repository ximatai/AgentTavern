import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { Principal, PrincipalKind } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, localBridges, principals } from "../db/schema";
import { resolveBindingForPrincipal } from "../lib/agent-binding-resolution";
import { createId } from "../lib/id";
import { resolveMemberRuntimeStatus } from "../lib/member-runtime";
import { issuePrincipalToken } from "../realtime";
import { isSupportedAgentBackendType, now } from "./support";

const principalRoutes = new Hono();
type DbExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete">;

function isPrincipalKind(value: unknown): value is PrincipalKind {
  return value === "human" || value === "agent";
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
  const backendThreadId =
    typeof body?.backendThreadId === "string" ? body.backendThreadId.trim() : "";

  if (!loginKey || !globalDisplayName) {
    return c.json({ error: "kind, loginKey and globalDisplayName are required" }, 400);
  }

  if (kind === "agent" && !isSupportedAgentBackendType(backendType)) {
    return c.json({ error: "agent principal requires a supported backendType" }, 400);
  }

  if (kind === "agent" && !backendThreadId) {
    return c.json({ error: "agent principal requires backendThreadId" }, 400);
  }

  const existing = db
    .select()
    .from(principals)
    .where(and(eq(principals.kind, kind), eq(principals.loginKey, loginKey)))
    .get() as Principal | undefined;

  if (existing) {
    try {
      const updated = db.transaction((tx) => {
        if (kind === "agent") {
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
          existing.backendType !== (kind === "agent" ? backendType : null) ||
          existing.backendThreadId !== (kind === "agent" ? backendThreadId : null)
        ) {
          tx
            .update(principals)
            .set({
              globalDisplayName,
              backendType: kind === "agent" ? backendType : null,
              backendThreadId: kind === "agent" ? backendThreadId : null,
            })
            .where(eq(principals.id, existing.id))
            .run();
        }

        const refreshed = tx
          .select()
          .from(principals)
          .where(eq(principals.id, existing.id))
          .get() as Principal;

        ensureAgentPrincipalBinding(refreshed, tx);
        return refreshed;
      });

      return c.json({
        principalId: updated.id,
        principalToken: issuePrincipalToken(updated.id),
        kind: updated.kind,
        loginKey: updated.loginKey,
        globalDisplayName: updated.globalDisplayName,
        backendType: updated.backendType ?? null,
        backendThreadId: updated.backendThreadId ?? null,
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
    backendType: kind === "agent" ? backendType : null,
    backendThreadId: kind === "agent" ? backendThreadId : null,
    status: "offline",
    createdAt: now(),
  };

  try {
    db.transaction((tx) => {
      if (kind === "agent") {
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
    status: principal.status,
  });
});

principalRoutes.get("/api/presence/lobby", (c) => {
  const onlinePrincipals = db
    .select()
    .from(principals)
    .where(eq(principals.status, "online"))
    .all();

  return c.json({
    principals: onlinePrincipals.map((principal) => ({
      runtimeStatus:
        principal.kind === "agent"
          ? (() => {
              if (principal.backendType === "local_process") {
                return "ready";
              }

              const binding = resolveBindingForPrincipal(principal.id);
              const bridge = binding?.bridgeId
                ? db.select().from(localBridges).where(eq(localBridges.id, binding.bridgeId)).get() ?? null
                : null;

              return resolveMemberRuntimeStatus(
                {
                  type: "agent",
                  adapterType: principal.backendType ?? null,
                },
                binding,
                bridge,
              );
            })()
          : null,
      principalId: principal.id,
      id: principal.id,
      kind: principal.kind,
      loginKey: principal.loginKey,
      globalDisplayName: principal.globalDisplayName,
      backendType: principal.backendType ?? null,
      status: principal.status,
      createdAt: principal.createdAt,
    })),
  });
});

export { principalRoutes };
