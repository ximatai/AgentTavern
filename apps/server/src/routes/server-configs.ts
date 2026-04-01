import { and, eq, ne } from "drizzle-orm";
import { Hono } from "hono";

import type { AgentBackendType, OpenAICompatibleBackendConfig, ServerConfigVisibility } from "@agent-tavern/shared";

import { db } from "../db/client";
import { citizens, serverConfigs } from "../db/schema";
import { createId } from "../lib/id";
import { verifyCitizenToken } from "../realtime";
import { isSupportedAgentBackendType, normalizeAgentBackendConfig, now } from "./support";

const serverConfigRoutes = new Hono();
const TEST_REQUEST_TIMEOUT_MS = 10_000;

type StoredServerConfig = {
  id: string;
  ownerCitizenId: string;
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
    ownerCitizenId: item.ownerCitizenId,
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

function requireCitizenAuth(params: { citizenId: string; citizenToken: string }) {
  if (!params.citizenId || !params.citizenToken) {
    return { error: { error: "citizenId and citizenToken are required" }, status: 400 as const };
  }

  if (!verifyCitizenToken(params.citizenToken, params.citizenId)) {
    return { error: { error: "invalid citizen token" }, status: 403 as const };
  }

  const citizen = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, params.citizenId))
    .get();

  if (!citizen) {
    return { error: { error: "citizen not found" }, status: 404 as const };
  }

  return { citizen };
}

async function testOpenAICompatibleConfig(config: OpenAICompatibleBackendConfig): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      ...(config.headers ?? {}),
    };

    if (config.apiKey) {
      headers.authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        stream: false,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const trimmed = bodyText.trim();
      return trimmed
        ? `openai-compatible backend request failed (${response.status}): ${trimmed}`
        : `openai-compatible backend request failed (${response.status})`;
    }

    return null;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return "openai-compatible backend request timed out";
    }

    return error instanceof Error ? error.message : "openai-compatible backend request failed";
  } finally {
    clearTimeout(timeout);
  }
}

serverConfigRoutes.get("/api/me/server-configs", (c) => {
  const citizenId = c.req.query("citizenId")?.trim() ?? "";
  const citizenToken = c.req.query("citizenToken")?.trim() ?? "";
  const auth = requireCitizenAuth({ citizenId, citizenToken });

  if ("error" in auth) {
    return c.json(auth.error, auth.status);
  }

  const items = db
    .select()
    .from(serverConfigs)
    .where(eq(serverConfigs.ownerCitizenId, citizenId))
    .all() as StoredServerConfig[];

  return c.json(items.map(toOwnerPayload));
});

serverConfigRoutes.get("/api/server-configs/shared", (c) => {
  const citizenId = c.req.query("citizenId")?.trim() ?? "";
  const citizenToken = c.req.query("citizenToken")?.trim() ?? "";
  const auth = requireCitizenAuth({ citizenId, citizenToken });

  if ("error" in auth) {
    return c.json(auth.error, auth.status);
  }

  const items = db
    .select()
    .from(serverConfigs)
    .where(and(eq(serverConfigs.visibility, "shared"), ne(serverConfigs.ownerCitizenId, citizenId)))
    .all() as StoredServerConfig[];

  return c.json(items.map(toSharedPayload));
});

serverConfigRoutes.post("/api/me/server-configs", async (c) => {
  const body = await c.req.json().catch(() => null);
  const citizenId = typeof body?.citizenId === "string" ? body.citizenId.trim() : "";
  const citizenToken = typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const visibility = isServerConfigVisibility(body?.visibility) ? body.visibility : "private";
  const backendType = isSupportedAgentBackendType(body?.backendType) ? body.backendType : null;
  const auth = requireCitizenAuth({ citizenId, citizenToken });

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
    .where(and(eq(serverConfigs.ownerCitizenId, citizenId), eq(serverConfigs.name, name)))
    .get();

  if (existing) {
    return c.json({ error: "server config name already exists for this citizen" }, 409);
  }

  const timestamp = now();
  const record = {
    id: createId("scf"),
    ownerCitizenId: citizenId,
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

serverConfigRoutes.post("/api/me/server-configs/test", async (c) => {
  const body = await c.req.json().catch(() => null);
  const citizenId = typeof body?.citizenId === "string" ? body.citizenId.trim() : "";
  const citizenToken = typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";
  const backendType = isSupportedAgentBackendType(body?.backendType) ? body.backendType : null;
  const auth = requireCitizenAuth({ citizenId, citizenToken });

  if ("error" in auth) {
    return c.json(auth.error, auth.status);
  }

  if (!backendType) {
    return c.json({ error: "backendType is required" }, 400);
  }

  if (backendType !== "openai_compatible") {
    return c.json({ error: "only openai_compatible backend supports server config testing" }, 400);
  }

  const { backendConfig, error } = normalizeAgentBackendConfig(backendType, body?.config);

  if (error || !backendConfig) {
    return c.json({ error: error ?? "server config requires config" }, 400);
  }

  const normalizedConfig = JSON.parse(backendConfig) as OpenAICompatibleBackendConfig;
  const testError = await testOpenAICompatibleConfig(normalizedConfig);

  if (testError) {
    return c.json({ error: testError }, 400);
  }

  return c.json({ ok: true });
});

serverConfigRoutes.patch("/api/me/server-configs/:configId", async (c) => {
  const configId = c.req.param("configId");
  const body = await c.req.json().catch(() => null);
  const citizenId = typeof body?.citizenId === "string" ? body.citizenId.trim() : "";
  const citizenToken = typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";
  const auth = requireCitizenAuth({ citizenId, citizenToken });

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

  if (current.ownerCitizenId !== citizenId) {
    return c.json({ error: "server config does not belong to actor citizen" }, 403);
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
        eq(serverConfigs.ownerCitizenId, citizenId),
        eq(serverConfigs.name, nextName),
        ne(serverConfigs.id, configId),
      ),
    )
    .get();

  if (conflicting) {
    return c.json({ error: "server config name already exists for this citizen" }, 409);
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
  const citizenId = c.req.query("citizenId")?.trim() ?? "";
  const citizenToken = c.req.query("citizenToken")?.trim() ?? "";
  const auth = requireCitizenAuth({ citizenId, citizenToken });

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

  if (current.ownerCitizenId !== citizenId) {
    return c.json({ error: "server config does not belong to actor citizen" }, 403);
  }

  db.delete(serverConfigs).where(eq(serverConfigs.id, configId)).run();
  return c.json({ ok: true });
});

export { serverConfigRoutes };
