import type { AgentBackendType, OpenAICompatibleBackendConfig } from "@agent-tavern/shared";

import { request } from "./client";

export type PrincipalSession = {
  principalId: string;
  principalToken: string;
  kind: "human" | "agent";
  loginKey: string;
  globalDisplayName: string;
  backendType: AgentBackendType | null;
  backendThreadId: string | null;
  backendConfig: OpenAICompatibleBackendConfig | null;
  status: "online" | "offline";
};

export type LobbyPrincipal = PrincipalSession & {
  id: string;
  createdAt: string;
  runtimeStatus: "ready" | "pending_bridge" | "waiting_bridge" | null;
};

async function bootstrapPrincipal(params: {
  kind: "human" | "agent";
  loginKey: string;
  globalDisplayName: string;
  backendType: AgentBackendType | null;
  backendThreadId: string | null;
  backendConfig?: OpenAICompatibleBackendConfig | null;
}): Promise<PrincipalSession> {
  return request<PrincipalSession>("/api/principals/bootstrap", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function createAgentCitizen(params: {
  actorPrincipalId: string;
  actorPrincipalToken: string;
  loginKey: string;
  globalDisplayName: string;
  serverConfigId: string;
}): Promise<PrincipalSession> {
  return request<PrincipalSession>("/api/me/agent-citizens", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function getLobbyPresence(): Promise<{ principals: LobbyPrincipal[] }> {
  return request<{ principals: LobbyPrincipal[] }>("/api/presence/lobby");
}

export { bootstrapPrincipal, createAgentCitizen, getLobbyPresence };
