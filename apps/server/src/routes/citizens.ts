import { and, eq, inArray, ne, or } from "drizzle-orm";
import { Hono } from "hono";

import type { OpenAICompatibleBackendConfig, Citizen, CitizenKind } from "@agent-tavern/shared";

import { db } from "../db/client";
import {
  agentBindings,
  agentSessions,
  localBridges,
  members,
  citizens,
  serverConfigs,
} from "../db/schema";
import { resolveBindingForCitizen } from "../lib/agent-binding-resolution";
import { removeCitizenAsset } from "../lib/agent-assets";
import { createId } from "../lib/id";
import { resolveMemberRuntimeStatus } from "../lib/member-runtime";
import { toPublicMember } from "../lib/public";
import {
  broadcastToRoom,
  issueCitizenToken,
  revokeCitizenTokensForCitizen,
  revokeWsTokensForMember,
  verifyCitizenToken,
} from "../realtime";
import {
  isSupportedAgentBackendType,
  normalizeAgentBackendConfig,
  normalizeAgentBackendThreadId,
  now,
} from "./support";

const citizenRoutes = new Hono();
type DbExecutor = Pick<typeof db, "select" | "insert" | "update" | "delete">;

function isCitizenKind(value: unknown): value is CitizenKind {
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

function toPublicReusableBackendConfig(raw: string | null): Record<string, unknown> | null {
  const parsed = toPublicBackendConfig(raw) as OpenAICompatibleBackendConfig | null;

  if (!parsed) {
    return null;
  }

  return {
    baseUrl: parsed.baseUrl,
    model: parsed.model,
    ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
    ...(parsed.maxTokens !== undefined ? { maxTokens: parsed.maxTokens } : {}),
  };
}

function toCitizenSessionPayload(citizen: Citizen) {
  const backendConfig = citizen.sourceServerConfigId
    ? toPublicReusableBackendConfig(citizen.backendConfig ?? null)
    : toPublicBackendConfig(citizen.backendConfig ?? null);

  return {
    citizenId: citizen.id,
    citizenToken: issueCitizenToken(citizen.id),
    kind: citizen.kind,
    ownerCitizenId: citizen.ownerCitizenId ?? null,
    loginKey: citizen.loginKey,
    globalDisplayName: citizen.globalDisplayName,
    roleSummary: citizen.roleSummary ?? null,
    instructions: citizen.instructions ?? null,
    sourceServerConfigId: citizen.sourceServerConfigId ?? null,
    backendType: citizen.backendType ?? null,
    backendThreadId: citizen.backendThreadId ?? null,
    backendConfig,
    status: citizen.status,
    updatedAt: citizen.updatedAt,
  };
}

function toManagedAgentCitizenPayload(citizen: Citizen) {
  return {
    id: citizen.id,
    kind: citizen.kind,
    ownerCitizenId: citizen.ownerCitizenId ?? null,
    loginKey: citizen.loginKey,
    globalDisplayName: citizen.globalDisplayName,
    roleSummary: citizen.roleSummary ?? null,
    instructions: citizen.instructions ?? null,
    sourceServerConfigId: citizen.sourceServerConfigId ?? null,
    backendType: citizen.backendType ?? null,
    backendThreadId: citizen.backendThreadId ?? null,
    status: citizen.status,
    createdAt: citizen.createdAt,
    updatedAt: citizen.updatedAt,
  };
}

function parseActor(body: unknown): { actorCitizenId: string; actorCitizenToken: string } {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return {
    actorCitizenId: typeof record.actorCitizenId === "string" ? record.actorCitizenId.trim() : "",
    actorCitizenToken: typeof record.actorCitizenToken === "string" ? record.actorCitizenToken.trim() : "",
  };
}

function validateActor(actorCitizenId: string, actorCitizenToken: string): Citizen | null {
  if (!actorCitizenId || !actorCitizenToken || !verifyCitizenToken(actorCitizenToken, actorCitizenId)) {
    return null;
  }

  return db
    .select()
    .from(citizens)
    .where(eq(citizens.id, actorCitizenId))
    .get() as Citizen | undefined ?? null;
}

function ensureAgentCitizenManageable(target: Citizen, actor: Citizen): { ok: true } | { error: string; status: number } {
  if (target.kind !== "agent") {
    return { error: "agent citizen not found", status: 404 };
  }

  if (target.ownerCitizenId && target.ownerCitizenId !== actor.id) {
    return { error: "agent citizen is not manageable by this citizen", status: 403 };
  }

  if (!target.sourceServerConfigId) {
    return { ok: true };
  }

  const currentServerConfig = db
    .select()
    .from(serverConfigs)
    .where(eq(serverConfigs.id, target.sourceServerConfigId))
    .get();

  if (currentServerConfig && currentServerConfig.ownerCitizenId !== actor.id && currentServerConfig.visibility !== "shared") {
    return { error: "agent citizen is not manageable by this citizen", status: 403 };
  }

  return { ok: true };
}

function ensureAgentCitizenBinding(citizen: Citizen, database: DbExecutor = db): void {
  if (citizen.kind !== "agent" || !citizen.backendThreadId) {
    return;
  }

  const existingByOwner = database
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.citizenId, citizen.id))
    .get();

  const existingByThread = database
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.backendThreadId, citizen.backendThreadId))
    .get();

  if (existingByThread && existingByThread.citizenId !== citizen.id) {
    throw new Error("backendThreadId already bound");
  }

  const timestamp = now();

  if (existingByOwner) {
    database
      .update(agentBindings)
      .set({
        backendType: citizen.backendType!,
        backendThreadId: citizen.backendThreadId,
        status: existingByOwner.bridgeId ? existingByOwner.status : "pending_bridge",
        detachedAt: existingByOwner.detachedAt,
      })
      .where(eq(agentBindings.id, existingByOwner.id))
      .run();
    return;
  }

  database.insert(agentBindings).values({
    id: createId("agb"),
    citizenId: citizen.id,
    privateAssistantId: null,
    bridgeId: null,
    backendType: citizen.backendType!,
    backendThreadId: citizen.backendThreadId,
    cwd: null,
    status: "pending_bridge",
    attachedAt: timestamp,
    detachedAt: null,
  }).run();
}

citizenRoutes.post("/api/citizens/bootstrap", async (c) => {
  const body = await c.req.json().catch(() => null);
  const kind = isCitizenKind(body?.kind) ? body.kind : "human";
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
  const { backendConfig, error: backendConfigError } = normalizeAgentBackendConfig(resolvedBackendType, body?.backendConfig);

  if (!loginKey || !globalDisplayName) {
    return c.json({ error: "kind, loginKey and globalDisplayName are required" }, 400);
  }

  if (kind === "agent" && !resolvedBackendType) {
    return c.json({ error: "agent citizen requires a supported backendType" }, 400);
  }

  if (kind === "agent" && !backendThreadId) {
    return c.json({ error: "agent citizen requires backendThreadId" }, 400);
  }

  if (kind === "agent" && backendConfigError) {
    return c.json({ error: backendConfigError }, 400);
  }

  const existing = db
    .select()
    .from(citizens)
    .where(and(eq(citizens.kind, kind), eq(citizens.loginKey, loginKey)))
    .get() as Citizen | undefined;

  if (existing) {
    try {
      const updatedMemberIds = new Set<string>();
      const oldGlobalDisplayName = existing.globalDisplayName;
      const timestamp = now();
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

          if (conflictingBinding && conflictingBinding.citizenId !== existing.id) {
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
            .update(citizens)
            .set({
              globalDisplayName,
              backendType: kind === "agent" ? resolvedBackendType : null,
              backendThreadId: kind === "agent" ? backendThreadId : null,
              backendConfig: kind === "agent" ? backendConfig : null,
              sourceServerConfigId: null,
              updatedAt: timestamp,
            })
            .where(eq(citizens.id, existing.id))
            .run();
        }

        if (oldGlobalDisplayName !== globalDisplayName) {
          const syncedMembers = tx
            .select()
            .from(members)
            .where(and(eq(members.citizenId, existing.id), eq(members.displayName, oldGlobalDisplayName)))
            .all();

          if (syncedMembers.length > 0) {
            tx
              .update(members)
              .set({ displayName: globalDisplayName })
              .where(and(eq(members.citizenId, existing.id), eq(members.displayName, oldGlobalDisplayName)))
              .run();

            syncedMembers.forEach((member) => updatedMemberIds.add(member.id));
          }
        }

        const refreshed = tx
          .select()
          .from(citizens)
          .where(eq(citizens.id, existing.id))
          .get() as Citizen;

        ensureAgentCitizenBinding(refreshed, tx);
        return refreshed;
      });

      if (updatedMemberIds.size > 0) {
        const refreshedMembers = db
          .select()
          .from(members)
          .where(eq(members.citizenId, existing.id))
          .all()
          .filter((member) => updatedMemberIds.has(member.id));
        const binding = updated.kind === "agent" ? resolveBindingForCitizen(updated.id) : null;
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

      return c.json(toCitizenSessionPayload(updated));
    } catch (error) {
      if (error instanceof Error && error.message === "backendThreadId already bound") {
        return c.json({ error: "backendThreadId already bound" }, 409);
      }

      throw error;
    }
  }

  const timestamp = now();
  const principal: Citizen = {
    id: createId("prn"),
    kind,
    ownerCitizenId: kind === "agent" ? null : null,
    loginKey,
    globalDisplayName,
    roleSummary: null,
    instructions: null,
    backendType: kind === "agent" ? resolvedBackendType : null,
    backendThreadId: kind === "agent" ? backendThreadId : null,
    backendConfig: kind === "agent" ? backendConfig : null,
    sourceServerConfigId: null,
    status: "offline",
    createdAt: timestamp,
    updatedAt: timestamp,
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

      tx.insert(citizens).values(principal).run();
      ensureAgentCitizenBinding(principal, tx);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "backendThreadId already bound") {
      return c.json({ error: "backendThreadId already bound" }, 409);
    }

    throw error;
  }

  return c.json(toCitizenSessionPayload(principal));
});

citizenRoutes.post("/api/me/agent-citizens", async (c) => {
  const body = await c.req.json().catch(() => null);
  const { actorCitizenId, actorCitizenToken } = parseActor(body);
  const loginKey = typeof body?.loginKey === "string" ? body.loginKey.trim() : "";
  const globalDisplayName =
    typeof body?.globalDisplayName === "string" ? body.globalDisplayName.trim() : "";
  const requestedServerConfigId =
    typeof body?.serverConfigId === "string" ? body.serverConfigId.trim() : "";
  const roleSummary = typeof body?.roleSummary === "string" ? body.roleSummary.trim() : "";
  const instructions = typeof body?.instructions === "string" ? body.instructions.trim() : "";

  if (!actorCitizenId || !actorCitizenToken || !loginKey || !globalDisplayName || !requestedServerConfigId) {
    return c.json(
      { error: "actorCitizenId, actorCitizenToken, loginKey, globalDisplayName and serverConfigId are required" },
      400,
    );
  }

  const actor = validateActor(actorCitizenId, actorCitizenToken);
  if (!actor) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const serverConfig = db
    .select()
    .from(serverConfigs)
    .where(eq(serverConfigs.id, requestedServerConfigId))
    .get();

  if (!serverConfig) {
    return c.json({ error: "server config not found" }, 404);
  }

  if (serverConfig.ownerCitizenId !== actorCitizenId && serverConfig.visibility !== "shared") {
    return c.json({ error: "server config is not available to this citizen" }, 403);
  }

  const backendType = isSupportedAgentBackendType(serverConfig.backendType)
    ? serverConfig.backendType
    : null;
  const backendThreadId = normalizeAgentBackendThreadId(backendType, "");

  if (backendType !== "openai_compatible") {
    return c.json({ error: "only openai_compatible backend supports agent citizen web creation" }, 400);
  }

  if (!backendThreadId) {
    return c.json({ error: "backendThreadId is required" }, 400);
  }

  const existing = db
    .select()
    .from(citizens)
    .where(and(eq(citizens.kind, "agent"), eq(citizens.loginKey, loginKey)))
    .get();

  if (existing) {
    return c.json({ error: "agent citizen loginKey already exists" }, 409);
  }

  const timestamp = now();
  const principal: Citizen = {
    id: createId("prn"),
    kind: "agent",
    ownerCitizenId: actor.id,
    loginKey,
    globalDisplayName,
    roleSummary: roleSummary || null,
    instructions: instructions || null,
    backendType,
    backendThreadId,
    backendConfig: serverConfig.configPayload,
    sourceServerConfigId: requestedServerConfigId,
    status: "online",
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  try {
    db.transaction((tx) => {
      const conflictingBinding = tx
        .select()
        .from(agentBindings)
        .where(eq(agentBindings.backendThreadId, backendThreadId))
        .get();

      if (conflictingBinding) {
        throw new Error("backendThreadId already bound");
      }

      tx.insert(citizens).values(principal).run();
      ensureAgentCitizenBinding(principal, tx);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "backendThreadId already bound") {
      return c.json({ error: "backendThreadId already bound" }, 409);
    }

    throw error;
  }

  return c.json(toCitizenSessionPayload(principal), 201);
});

citizenRoutes.get("/api/me/agent-citizens", async (c) => {
  const actorCitizenId = c.req.query("actorCitizenId")?.trim() ?? "";
  const actorCitizenToken = c.req.query("actorCitizenToken")?.trim() ?? "";

  if (!actorCitizenId || !actorCitizenToken) {
    return c.json({ error: "actorCitizenId and actorCitizenToken are required" }, 400);
  }

  const actor = validateActor(actorCitizenId, actorCitizenToken);
  if (!actor) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const agentCitizens = db
    .select()
    .from(citizens)
    .where(
      eq(citizens.kind, "agent"),
    )
    .all()
    .filter((citizen) =>
      citizen.ownerCitizenId === actor.id ||
      (
        !citizen.ownerCitizenId &&
        citizen.sourceServerConfigId !== null &&
        db
          .select()
          .from(serverConfigs)
          .where(eq(serverConfigs.id, citizen.sourceServerConfigId))
          .get()?.ownerCitizenId === actor.id
      ),
    ) as Citizen[];

  return c.json(
    agentCitizens
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toManagedAgentCitizenPayload),
  );
});

citizenRoutes.patch("/api/me/agent-citizens/:citizenId", async (c) => {
  const citizenId = c.req.param("citizenId");
  const body = await c.req.json().catch(() => null);
  const { actorCitizenId, actorCitizenToken } = parseActor(body);
  const loginKey = typeof body?.loginKey === "string" ? body.loginKey.trim() : null;
  const globalDisplayName =
    typeof body?.globalDisplayName === "string" ? body.globalDisplayName.trim() : null;
  const requestedServerConfigId =
    typeof body?.serverConfigId === "string" ? body.serverConfigId.trim() : null;
  const roleSummary = typeof body?.roleSummary === "string" ? body.roleSummary.trim() : null;
  const instructions = typeof body?.instructions === "string" ? body.instructions.trim() : null;

  const actor = validateActor(actorCitizenId, actorCitizenToken);
  if (!actor) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const target = db
    .select()
    .from(citizens)
    .where(and(eq(citizens.id, citizenId), eq(citizens.kind, "agent")))
    .get() as Citizen | undefined;

  if (!target) {
    return c.json({ error: "agent citizen not found" }, 404);
  }

  const manageable = ensureAgentCitizenManageable(target, actor);
  if ("error" in manageable) {
    return c.json({ error: manageable.error }, { status: manageable.status as 403 | 404 });
  }

  let sourceServerConfigId = target.sourceServerConfigId ?? null;
  let backendConfig = target.backendConfig ?? null;

  if (requestedServerConfigId && requestedServerConfigId !== target.sourceServerConfigId) {
    const serverConfig = db
      .select()
      .from(serverConfigs)
      .where(eq(serverConfigs.id, requestedServerConfigId))
      .get();

    if (!serverConfig) {
      return c.json({ error: "server config not found" }, 404);
    }

    if (serverConfig.ownerCitizenId !== actor.id && serverConfig.visibility !== "shared") {
      return c.json({ error: "server config is not available to this citizen" }, 403);
    }

    sourceServerConfigId = serverConfig.id;
    backendConfig = serverConfig.configPayload;
  }

  if (loginKey && loginKey !== target.loginKey) {
    const existing = db
      .select()
      .from(citizens)
      .where(and(eq(citizens.kind, "agent"), eq(citizens.loginKey, loginKey), ne(citizens.id, target.id)))
      .get();
    if (existing) {
      return c.json({ error: "agent citizen loginKey already exists" }, 409);
    }
  }

  const timestamp = now();
  db
    .update(citizens)
    .set({
      loginKey: loginKey ?? target.loginKey,
      globalDisplayName: globalDisplayName ?? target.globalDisplayName,
      sourceServerConfigId,
      backendConfig,
      roleSummary,
      instructions,
      updatedAt: timestamp,
    })
    .where(eq(citizens.id, target.id))
    .run();

  const updated = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, target.id))
    .get() as Citizen;

  return c.json(toManagedAgentCitizenPayload(updated));
});

citizenRoutes.post("/api/me/agent-citizens/:citizenId/pause", async (c) => {
  const citizenId = c.req.param("citizenId");
  const body = await c.req.json().catch(() => null);
  const { actorCitizenId, actorCitizenToken } = parseActor(body);

  const actor = validateActor(actorCitizenId, actorCitizenToken);
  if (!actor) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const target = db
    .select()
    .from(citizens)
    .where(and(eq(citizens.id, citizenId), eq(citizens.kind, "agent")))
    .get() as Citizen | undefined;

  if (!target) {
    return c.json({ error: "agent citizen not found" }, 404);
  }

  const manageable = ensureAgentCitizenManageable(target, actor);
  if ("error" in manageable) {
    return c.json({ error: manageable.error }, { status: manageable.status as 403 | 404 });
  }

  db
    .update(citizens)
    .set({ status: "offline", updatedAt: now() })
    .where(eq(citizens.id, target.id))
    .run();

  const updated = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, target.id))
    .get() as Citizen;

  return c.json(toManagedAgentCitizenPayload(updated));
});

citizenRoutes.post("/api/me/agent-citizens/:citizenId/resume", async (c) => {
  const citizenId = c.req.param("citizenId");
  const body = await c.req.json().catch(() => null);
  const { actorCitizenId, actorCitizenToken } = parseActor(body);

  const actor = validateActor(actorCitizenId, actorCitizenToken);
  if (!actor) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const target = db
    .select()
    .from(citizens)
    .where(and(eq(citizens.id, citizenId), eq(citizens.kind, "agent")))
    .get() as Citizen | undefined;

  if (!target) {
    return c.json({ error: "agent citizen not found" }, 404);
  }

  const manageable = ensureAgentCitizenManageable(target, actor);
  if ("error" in manageable) {
    return c.json({ error: manageable.error }, { status: manageable.status as 403 | 404 });
  }

  const binding = resolveBindingForCitizen(target.id);
  db
    .update(citizens)
    .set({
      status: binding && (binding.status === "active" || binding.status === "pending_bridge") ? "online" : "offline",
      updatedAt: now(),
    })
    .where(eq(citizens.id, target.id))
    .run();

  const updated = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, target.id))
    .get() as Citizen;

  return c.json(toManagedAgentCitizenPayload(updated));
});

citizenRoutes.delete("/api/me/agent-citizens/:citizenId", async (c) => {
  const citizenId = c.req.param("citizenId");
  const actorCitizenId = c.req.query("actorCitizenId")?.trim() ?? "";
  const actorCitizenToken = c.req.query("actorCitizenToken")?.trim() ?? "";

  const actor = validateActor(actorCitizenId, actorCitizenToken);
  if (!actor) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const target = db
    .select()
    .from(citizens)
    .where(and(eq(citizens.id, citizenId), eq(citizens.kind, "agent")))
    .get() as Citizen | undefined;

  if (!target) {
    return c.json({ error: "agent citizen not found" }, 404);
  }

  const manageable = ensureAgentCitizenManageable(target, actor);
  if ("error" in manageable) {
    return c.json({ error: manageable.error }, { status: manageable.status as 403 | 404 });
  }

  const activeMemberIds = db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.citizenId, target.id))
    .all()
    .map((member) => member.id);

  if (activeMemberIds.length > 0) {
    const activeSession = db
      .select()
      .from(agentSessions)
      .where(
        and(
          inArray(agentSessions.agentMemberId, activeMemberIds),
          or(
            eq(agentSessions.status, "pending"),
            eq(agentSessions.status, "waiting_approval"),
            eq(agentSessions.status, "running"),
          ),
        ),
      )
      .get();

    if (activeSession) {
      return c.json({ error: "agent citizen has an active session" }, 409);
    }
  }

  const timestamp = now();
  const roomMemberships = removeCitizenAsset(target.id, timestamp);

  for (const membership of roomMemberships) {
    revokeWsTokensForMember(membership.id, membership.roomId);
    broadcastToRoom(membership.roomId, {
      type: "member.left",
      roomId: membership.roomId,
      timestamp,
      payload: { memberId: membership.id },
    });
  }

  revokeCitizenTokensForCitizen(target.id);

  return c.json({ ok: true });
});

citizenRoutes.post("/api/citizens/:citizenId/leave-system", async (c) => {
  const citizenId = c.req.param("citizenId");
  const principal = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, citizenId))
    .get() as Citizen | undefined;

  if (!principal) {
    return c.json({ error: "citizen not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const citizenToken =
    typeof body?.citizenToken === "string" ? body.citizenToken.trim() : "";

  if (!citizenToken) {
    return c.json({ error: "citizenToken is required" }, 400);
  }

  if (!verifyCitizenToken(citizenToken, citizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const timestamp = now();
  const roomMemberships = db
    .select()
    .from(members)
    .where(eq(members.citizenId, citizenId))
    .all();

  db.transaction((tx) => {
    tx
      .update(members)
      .set({
        citizenId: null,
        presenceStatus: "offline",
        membershipStatus: "left",
        leftAt: timestamp,
      })
      .where(eq(members.citizenId, citizenId))
      .run();
    tx.update(citizens).set({ status: "offline", updatedAt: timestamp }).where(eq(citizens.id, citizenId)).run();
    tx
      .update(agentBindings)
      .set({
        bridgeId: null,
        status: "detached",
        detachedAt: timestamp,
      })
      .where(eq(agentBindings.citizenId, citizenId))
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

  revokeCitizenTokensForCitizen(citizenId);

  return c.json({
    citizenId,
    leftSystem: true,
    removedRoomCount: roomMemberships.length,
    removedMemberIds: roomMemberships.map((membership) => membership.id),
  });
});

citizenRoutes.get("/api/presence/lobby", (c) => {
  const allCitizens = db
    .select()
    .from(citizens)
    .all();

  return c.json({
    citizens: allCitizens
      .map((principal) => {
        const binding = principal.kind === "agent"
          ? resolveBindingForCitizen(principal.id)
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
              (binding.status === "active" || binding.status === "pending_bridge") &&
              (principal.ownerCitizenId ? principal.status === "online" : true),
            );

        return {
          visibleInLobby,
          principal: {
            citizenId: principal.id,
            id: principal.id,
            kind: principal.kind,
            loginKey: principal.loginKey,
            globalDisplayName: principal.globalDisplayName,
            roleSummary: principal.roleSummary ?? null,
            instructions: principal.instructions ?? null,
            sourceServerConfigId: principal.sourceServerConfigId ?? null,
            backendType: principal.backendType ?? null,
            backendThreadId: principal.backendThreadId ?? null,
            backendConfig: principal.sourceServerConfigId
              ? toPublicReusableBackendConfig(principal.backendConfig ?? null)
              : toPublicBackendConfig(principal.backendConfig ?? null),
            status: visibleInLobby ? "online" : principal.status,
            createdAt: principal.createdAt,
            updatedAt: principal.updatedAt,
            runtimeStatus,
          },
        };
      })
      .filter((entry) => entry.visibleInLobby)
      .map((entry) => entry.principal),
  });
});

export { citizenRoutes };
