import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { Principal, PrincipalKind } from "@agent-tavern/shared";

import { db } from "../db/client";
import { principals } from "../db/schema";
import { createId } from "../lib/id";
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

  if (!loginKey || !globalDisplayName) {
    return c.json({ error: "kind, loginKey and globalDisplayName are required" }, 400);
  }

  const existing = db
    .select()
    .from(principals)
    .where(and(eq(principals.kind, kind), eq(principals.loginKey, loginKey)))
    .get() as Principal | undefined;

  if (existing) {
    if (existing.globalDisplayName !== globalDisplayName || existing.status !== "online") {
      db
        .update(principals)
        .set({
          globalDisplayName,
          status: "online",
        })
        .where(eq(principals.id, existing.id))
        .run();
    }

    return c.json({
      principalId: existing.id,
      principalToken: issuePrincipalToken(existing.id),
      kind,
      loginKey,
      globalDisplayName,
      status: "online",
    });
  }

  const principal: Principal = {
    id: createId("prn"),
    kind,
    loginKey,
    globalDisplayName,
    status: "online",
    createdAt: now(),
  };

  db.insert(principals).values(principal).run();

  return c.json({
    principalId: principal.id,
    principalToken: issuePrincipalToken(principal.id),
    kind: principal.kind,
    loginKey: principal.loginKey,
    globalDisplayName: principal.globalDisplayName,
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
      id: principal.id,
      kind: principal.kind,
      loginKey: principal.loginKey,
      globalDisplayName: principal.globalDisplayName,
      status: principal.status,
      createdAt: principal.createdAt,
    })),
  });
});

export { principalRoutes };
