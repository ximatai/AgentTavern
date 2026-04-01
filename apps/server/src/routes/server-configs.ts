import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";

import type { AgentBackendType, OpenAICompatibleBackendConfig, ServerConfigVisibility } from "@agent-tavern/shared";

import { db } from "../db/client";
import { principals, serverConfigs } from "../db/schema";
import { createId } from "../lib/id";
import { verifyPrincipalToken } from "../realtime";
import { isSupportedAgentBackendType, normalizeAgentBackendConfig, now } from "./support";

const serverConfigRoutes = new Hono();

type StoredServerConfig = {
  id: string;
  ownerPrincipalId: string;
  name: string;
  backendType: AgentBackendType;
  configPayload: string;
  visibility: ServerConfigVisibility;
  createdAt: string;
  updatedAt: string;
};

function isServerConfigVisibility(value: unknown): value is ServerConfigVisibility {
  return value === "private" || value === "shared";
}

function toOwnerPayload(item: StoredServerConfig) {
  return {
    ...item,
    config: JSON.parse(item.configPayload) as OpenAICompatibleBackendConfig,
  };
}

function hasSensitiveHeaders(headers: OpenAICompatibleBackendConfig["headers"]): boolean {
  if (!headers) {
    return false;
  }

  return Object.keys(headers).some((key) => {
    const normalizedKey = key.trim().toLowerCase();
    return normalizedKey === "authorization" || normalizedKey === "x-api-key" || normalizedKey === "api-key";
  });
}

function toSharedPayload(item: StoredServerConfig) {
  const parsed = JSON.parse(item.configPayload) as OpenAICompatibleBackendConfig;

  return {
    id: item.id,
    ownerPrincipalId: item.ownerPrincipalId,
    name: item.name,
    backendType: item.backendType,
    visibility: item.visibility,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    config: {
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
      ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
    },
    hasAuth: Boolean(parsed.apiKey) || hasSensitiveHeaders(parsed.headers),
  };
}

function requirePrincipalAuth(params: { principalId: string; principalToken: string }) {
  if (!params.principalId || !params.principalToken) {
    return { error: { error: "principalId and principalToken are required" }, status: 400 as const };
  }

  if (!verifyPrincipalToken(params.principalToken, params.principalId)) {
    return { error: { error: "invalid principal token" }, status: 403 as const };
  }

  const principal = db
    .select()
    .from(principals)
    .where(eq(principals.id, params.principalId))
    .get();

  if (!principal) {
    return { error: { error: "principal not found" }, status: 404 as const };
  }

  return { principal };
}

serverConfigRoutes.get("/api/me/server-configs", (c) => {
  const principalId = c.req.query("principalId")?.trim() ?? "";
  const principalToken = c.req.query("principalToken")?.trim() ?? "";
  const auth = requirePrincipalAuth({ principalId, principalToken });

  if ("error" in auth) {
    return c.json(auth.error, auth.status);
  }

  const items = db
    .select()
    .from(serverConfigs)
    .where(eq(serverConfigs.ownerPrincipalId, principalId))
    .all() as StoredServerConfig[];

  return c.json(items.map(toOwnerPayload));
});

serverConfigRoutes.get("/api/server-configs/shared", (c) => {
  const principalId = c.req.query("principalId")?.trim() ?? "";
  const principalToken = c.req.query("principalToken")?.trim() ?? "";
  const auth = requirePrincipalAuth({ principalId, principalToken });

  if ("error" in auth) {
    return c.json(auth.error, auth.status);
  }

  const items = db
    .select()
    .from(serverConfigs)
    .where(and(eq(serverConfigs.visibility, "shared"), ne(serverConfigs.ownerPrincipalId, principalId)))
    .all() as StoredServerConfig[];

  return c.json(items.map(toSharedPayload));
});

serverConfigRoutes.post("/api/me/server-configs", async (c) => {
  const body = await c.req.json().catch(() => null);
  const principalId = typeof body?.principalId === "string" ? body.principalId.trim() : "";
  const principalToken = typeof body?.principalToken === "string" ? body.principalToken.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const visibility = isServerConfigVisibility(body?.visibility) ? body.visibility : "private";
  const backendType = isSupportedAgentBackendType(body?.backendType) ? body.backendType : null;
  const auth = requirePrincipalAuth({ principalId, principalToken });

  if ("error" in auth) {
    return c.json(auth.error, auth.status);
  }

  if (!name || !backendType) {
    return c.json({ error: "name and backendType are required" }, 400);
  }

  if (backendType !== "openai_compatible") {
    return c.json({ error: "only openai_compatible backend supports server configs" }, 400);
  }

  const { backendConfig, error } = normalizeAgentBackendConfig(backendType, body?.config);

  if (error || !backendConfig) {
    return c.json({ error: error ?? "server config requires config" }, 400);
  }

  const existing = db
    .select()
    .from(serverConfigs)
    .where(and(eq(serverConfigs.ownerPrincipalId, principalId), eq(serverConfigs.name, name)))
    .get();

  if (existing) {
    return c.json({ error: "server config name already exists for this principal" }, 409);
  }

  const timestamp = now();
  const record = {
    id: createId("scf"),
    ownerPrincipalId: principalId,
    name,
    backendType,
    configPayload: backendConfig,
    visibility,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  db.insert(serverConfigs).values(record).run();

  return c.json(toOwnerPayload(record), 201);
});

serverConfigRoutes.patch("/api/me/server-configs/:configId", async (c) => {
  const configId = c.req.param("configId");
  const body = await c.req.json().catch(() => null);
  const principalId = typeof body?.principalId === "string" ? body.principalId.trim() : "";
  const principalToken = typeof body?.principalToken === "string" ? body.principalToken.trim() : "";
  const auth = requirePrincipalAuth({ principalId, principalToken });

  if ("error" in auth) {
    return c.json(auth.error, auth.status);
  }

  const current = db
    .select()
    .from(serverConfigs)
    .where(eq(serverConfigs.id, configId))
    .get() as StoredServerConfig | undefined;

  if (!current) {
    return c.json({ error: "server config not found" }, 404);
  }

  if (current.ownerPrincipalId !== principalId) {
    return c.json({ error: "server config does not belong to actor principal" }, 403);
  }

  const nextName = typeof body?.name === "string" ? body.name.trim() : current.name;
  const nextVisibility = isServerConfigVisibility(body?.visibility) ? body.visibility : current.visibility;
  let nextConfigPayload = current.configPayload;

  if (Object.prototype.hasOwnProperty.call(body ?? {}, "config")) {
    const { backendConfig, error } = normalizeAgentBackendConfig(current.backendType, body?.config);
    if (error || !backendConfig) {
      return c.json({ error: error ?? "server config requires config" }, 400);
    }
    nextConfigPayload = backendConfig;
  }

  const conflicting = db
    .select()
    .from(serverConfigs)
    .where(
      and(
        eq(serverConfigs.ownerPrincipalId, principalId),
        eq(serverConfigs.name, nextName),
        ne(serverConfigs.id, configId),
      ),
    )
    .get();

  if (conflicting) {
    return c.json({ error: "server config name already exists for this principal" }, 409);
  }

  db
    .update(serverConfigs)
    .set({
      name: nextName,
      visibility: nextVisibility,
      configPayload: nextConfigPayload,
      updatedAt: now(),
    })
    .where(eq(serverConfigs.id, configId))
    .run();

  const updated = db
    .select()
    .from(serverConfigs)
    .where(eq(serverConfigs.id, configId))
    .get() as StoredServerConfig;

  return c.json(toOwnerPayload(updated));
});

serverConfigRoutes.delete("/api/me/server-configs/:configId", (c) => {
  const configId = c.req.param("configId");
  const principalId = c.req.query("principalId")?.trim() ?? "";
  const principalToken = c.req.query("principalToken")?.trim() ?? "";
  const auth = requirePrincipalAuth({ principalId, principalToken });

  if ("error" in auth) {
    return c.json(auth.error, auth.status);
  }

  const current = db
    .select()
    .from(serverConfigs)
    .where(eq(serverConfigs.id, configId))
    .get() as StoredServerConfig | undefined;

  if (!current) {
    return c.json({ error: "server config not found" }, 404);
  }

  if (current.ownerPrincipalId !== principalId) {
    return c.json({ error: "server config does not belong to actor principal" }, 403);
  }

  db.delete(serverConfigs).where(eq(serverConfigs.id, configId)).run();
  return c.json({ ok: true });
});

export { serverConfigRoutes };
