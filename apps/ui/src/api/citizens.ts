import type { AgentBackendType, OpenAICompatibleBackendConfig } from "@agent-tavern/shared";

import { request } from "./client";

export type CitizenSession = {
  citizenId: string;
  citizenToken: string;
  kind: "human" | "agent";
  loginKey: string;
  globalDisplayName: string;
  roleSummary: string | null;
  instructions: string | null;
  sourceServerConfigId: string | null;
  backendType: AgentBackendType | null;
  backendThreadId: string | null;
  backendConfig: OpenAICompatibleBackendConfig | null;
  status: "online" | "offline";
  updatedAt: string;
};

export type LobbyCitizen = CitizenSession & {
  id: string;
  createdAt: string;
  runtimeStatus: "ready" | "pending_bridge" | "waiting_bridge" | null;
};

export type ManagedAgentCitizen = {
  id: string;
  kind: "agent";
  loginKey: string;
  globalDisplayName: string;
  roleSummary: string | null;
  instructions: string | null;
  sourceServerConfigId: string | null;
  backendType: AgentBackendType | null;
  backendThreadId: string | null;
  status: "online" | "offline";
  createdAt: string;
  updatedAt: string;
};

async function bootstrapCitizen(params: {
  kind: "human" | "agent";
  loginKey: string;
  globalDisplayName: string;
  backendType: AgentBackendType | null;
  backendThreadId: string | null;
  backendConfig?: OpenAICompatibleBackendConfig | null;
}): Promise<CitizenSession> {
  return request<CitizenSession>("/api/citizens/bootstrap", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function createAgentCitizen(params: {
  actorCitizenId: string;
  actorCitizenToken: string;
  loginKey: string;
  globalDisplayName: string;
  serverConfigId: string;
  roleSummary?: string;
  instructions?: string;
}): Promise<CitizenSession> {
  return request<CitizenSession>("/api/me/agent-citizens", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function getManagedAgentCitizens(
  actorCitizenId: string,
  actorCitizenToken: string,
): Promise<ManagedAgentCitizen[]> {
  return request<ManagedAgentCitizen[]>(
    `/api/me/agent-citizens?actorCitizenId=${actorCitizenId}&actorCitizenToken=${actorCitizenToken}`,
  );
}

async function updateAgentCitizen(params: {
  citizenId: string;
  actorCitizenId: string;
  actorCitizenToken: string;
  loginKey: string;
  globalDisplayName: string;
  serverConfigId: string;
  roleSummary: string;
  instructions: string;
}): Promise<ManagedAgentCitizen> {
  return request<ManagedAgentCitizen>(`/api/me/agent-citizens/${params.citizenId}`, {
    method: "PATCH",
    body: JSON.stringify(params),
  });
}

async function pauseAgentCitizen(
  citizenId: string,
  actorCitizenId: string,
  actorCitizenToken: string,
): Promise<ManagedAgentCitizen> {
  return request<ManagedAgentCitizen>(`/api/me/agent-citizens/${citizenId}/pause`, {
    method: "POST",
    body: JSON.stringify({ actorCitizenId, actorCitizenToken }),
  });
}

async function resumeAgentCitizen(
  citizenId: string,
  actorCitizenId: string,
  actorCitizenToken: string,
): Promise<ManagedAgentCitizen> {
  return request<ManagedAgentCitizen>(`/api/me/agent-citizens/${citizenId}/resume`, {
    method: "POST",
    body: JSON.stringify({ actorCitizenId, actorCitizenToken }),
  });
}

async function removeAgentCitizen(
  citizenId: string,
  actorCitizenId: string,
  actorCitizenToken: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/me/agent-citizens/${citizenId}?actorCitizenId=${actorCitizenId}&actorCitizenToken=${actorCitizenToken}`,
    { method: "DELETE" },
  );
}

async function getLobbyPresence(): Promise<{ citizens: LobbyCitizen[] }> {
  return request<{ citizens: LobbyCitizen[] }>("/api/presence/lobby");
}

export {
  bootstrapCitizen,
  createAgentCitizen,
  getManagedAgentCitizens,
  updateAgentCitizen,
  pauseAgentCitizen,
  resumeAgentCitizen,
  removeAgentCitizen,
  getLobbyPresence,
};
