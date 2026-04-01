import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { OpenAICompatibleBackendConfig, Citizen, CitizenKind } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, localBridges, members, citizens, serverConfigs } from "../db/schema";
import { resolveBindingForCitizen } from "../lib/agent-binding-resolution";
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
    loginKey: citizen.loginKey,
    globalDisplayName: citizen.globalDisplayName,
    backendType: citizen.backendType ?? null,
    backendThreadId: citizen.backendThreadId ?? null,
    backendConfig,
    status: citizen.status,
  };
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
  const {
    backendConfig,
    error: backendConfigError,
  } = normalizeAgentBackendConfig(resolvedBackendType, body?.backendConfig);

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

  const principal: Citizen = {
    id: createId("prn"),
    kind,
    loginKey,
    globalDisplayName,
    backendType: kind === "agent" ? resolvedBackendType : null,
    backendThreadId: kind === "agent" ? backendThreadId : null,
    backendConfig: kind === "agent" ? backendConfig : null,
    sourceServerConfigId: null,
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
  const actorCitizenId =
    typeof body?.actorCitizenId === "string" ? body.actorCitizenId.trim() : "";
  const actorCitizenToken =
    typeof body?.actorCitizenToken === "string" ? body.actorCitizenToken.trim() : "";
  const loginKey = typeof body?.loginKey === "string" ? body.loginKey.trim() : "";
  const globalDisplayName =
    typeof body?.globalDisplayName === "string" ? body.globalDisplayName.trim() : "";
  const requestedServerConfigId =
    typeof body?.serverConfigId === "string" ? body.serverConfigId.trim() : "";

  if (!actorCitizenId || !actorCitizenToken || !loginKey || !globalDisplayName || !requestedServerConfigId) {
    return c.json(
      { error: "actorCitizenId, actorCitizenToken, loginKey, globalDisplayName and serverConfigId are required" },
      400,
    );
  }

  if (!verifyCitizenToken(actorCitizenToken, actorCitizenId)) {
    return c.json({ error: "invalid citizen token" }, 403);
  }

  const actor = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, actorCitizenId))
    .get() as Citizen | undefined;

  if (!actor) {
    return c.json({ error: "actor citizen not found" }, 404);
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

  const principal: Citizen = {
    id: createId("prn"),
    kind: "agent",
    loginKey,
    globalDisplayName,
    backendType,
    backendThreadId,
    backendConfig: serverConfig.configPayload,
    sourceServerConfigId: requestedServerConfigId,
    status: "offline",
    createdAt: now(),
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
    tx.update(citizens).set({ status: "offline" }).where(eq(citizens.id, citizenId)).run();
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
              (binding.status === "active" || binding.status === "pending_bridge"),
            );

        return {
          visibleInLobby,
          principal: {
            citizenId: principal.id,
            id: principal.id,
            kind: principal.kind,
            loginKey: principal.loginKey,
            globalDisplayName: principal.globalDisplayName,
            backendType: principal.backendType ?? null,
            backendThreadId: principal.backendThreadId ?? null,
            backendConfig: principal.sourceServerConfigId
              ? toPublicReusableBackendConfig(principal.backendConfig ?? null)
              : toPublicBackendConfig(principal.backendConfig ?? null),
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

export { citizenRoutes };
