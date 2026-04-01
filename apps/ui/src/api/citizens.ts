import type { AgentBackendType, OpenAICompatibleBackendConfig } from "@agent-tavern/shared";

import { request } from "./client";

export type CitizenSession = {
  citizenId: string;
  citizenToken: string;
  kind: "human" | "agent";
  loginKey: string;
  globalDisplayName: string;
  backendType: AgentBackendType | null;
  backendThreadId: string | null;
  backendConfig: OpenAICompatibleBackendConfig | null;
  status: "online" | "offline";
};

export type LobbyCitizen = CitizenSession & {
  id: string;
  createdAt: string;
  runtimeStatus: "ready" | "pending_bridge" | "waiting_bridge" | null;
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
}): Promise<CitizenSession> {
  return request<CitizenSession>("/api/me/agent-citizens", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function getLobbyPresence(): Promise<{ citizens: LobbyCitizen[] }> {
  return request<{ citizens: LobbyCitizen[] }>("/api/presence/lobby");
}

export { bootstrapCitizen, createAgentCitizen, getLobbyPresence };
