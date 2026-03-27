import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { Principal, PrincipalKind } from "@agent-tavern/shared";

import { db } from "../db/client";
import { localBridges, members, principals } from "../db/schema";
import { resolveBindingForMember } from "../lib/agent-binding-resolution";
import { createId } from "../lib/id";
import { resolveMemberRuntimeStatus } from "../lib/member-runtime";
import { issuePrincipalToken } from "../realtime";
import { now } from "./support";

const principalRoutes = new Hono();

function isPrincipalKind(value: unknown): value is PrincipalKind {
  return value === "human" || value === "agent";
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

  if (kind === "agent" && backendType !== "codex_cli") {
    return c.json({ error: "agent principal currently requires backendType=codex_cli" }, 400);
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
    if (
      existing.globalDisplayName !== globalDisplayName ||
      existing.backendType !== (kind === "agent" ? backendType : null) ||
      existing.backendThreadId !== (kind === "agent" ? backendThreadId : null)
    ) {
      db
        .update(principals)
        .set({
          globalDisplayName,
          backendType: kind === "agent" ? backendType : null,
          backendThreadId: kind === "agent" ? backendThreadId : null,
        })
        .where(eq(principals.id, existing.id))
        .run();
    }

    const updated = db
      .select()
      .from(principals)
      .where(eq(principals.id, existing.id))
      .get() as Principal;

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

  db.insert(principals).values(principal).run();

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

              const agentProjection = db
                .select()
                .from(members)
                .where(eq(members.principalId, principal.id))
                .all()
                .find((member) => member.type === "agent");
              const binding = agentProjection
                ? resolveBindingForMember({
                    id: agentProjection.id,
                    principalId: agentProjection.principalId,
                    sourcePrivateAssistantId: agentProjection.sourcePrivateAssistantId,
                  })
                : null;
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
