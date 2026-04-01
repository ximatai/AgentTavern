import type { AgentBackendType, OpenAICompatibleBackendConfig } from "@agent-tavern/shared";

import { request } from "./client";

export type ServerConfigRecord = {
  id: string;
  ownerCitizenId: string;
  name: string;
  backendType: AgentBackendType;
  visibility: "private" | "shared";
  createdAt: string;
  updatedAt: string;
  config: OpenAICompatibleBackendConfig;
};

export type SharedServerConfigRecord = {
  id: string;
  ownerCitizenId: string;
  name: string;
  backendType: AgentBackendType;
  visibility: "private" | "shared";
  createdAt: string;
  updatedAt: string;
  config: Omit<OpenAICompatibleBackendConfig, "apiKey" | "headers">;
  hasAuth: boolean;
};

async function getMyServerConfigs(citizenId: string, citizenToken: string): Promise<ServerConfigRecord[]> {
  return request<ServerConfigRecord[]>(
    `/api/me/server-configs?citizenId=${citizenId}&citizenToken=${citizenToken}`,
  );
}

async function getSharedServerConfigs(
  citizenId: string,
  citizenToken: string,
): Promise<SharedServerConfigRecord[]> {
  return request<SharedServerConfigRecord[]>(
    `/api/server-configs/shared?citizenId=${citizenId}&citizenToken=${citizenToken}`,
  );
}

async function createServerConfig(params: {
  citizenId: string;
  citizenToken: string;
  name: string;
  backendType: AgentBackendType;
  visibility?: "private" | "shared";
  config: OpenAICompatibleBackendConfig;
}): Promise<ServerConfigRecord> {
  return request<ServerConfigRecord>("/api/me/server-configs", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function testServerConfig(params: {
  citizenId: string;
  citizenToken: string;
  backendType: AgentBackendType;
  config: OpenAICompatibleBackendConfig;
}): Promise<{ ok: true }> {
  return request<{ ok: true }>("/api/me/server-configs/test", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function updateServerConfig(params: {
  configId: string;
  citizenId: string;
  citizenToken: string;
  name?: string;
  visibility?: "private" | "shared";
  config?: OpenAICompatibleBackendConfig;
}): Promise<ServerConfigRecord> {
  return request<ServerConfigRecord>(`/api/me/server-configs/${params.configId}`, {
    method: "PATCH",
    body: JSON.stringify({
      citizenId: params.citizenId,
      citizenToken: params.citizenToken,
      ...(params.name ? { name: params.name } : {}),
      ...(params.visibility ? { visibility: params.visibility } : {}),
      ...(params.config ? { config: params.config } : {}),
    }),
  });
}

async function removeServerConfig(
  configId: string,
  citizenId: string,
  citizenToken: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/me/server-configs/${configId}?citizenId=${citizenId}&citizenToken=${citizenToken}`,
    {
      method: "DELETE",
    },
  );
}

export {
  getMyServerConfigs,
  getSharedServerConfigs,
  createServerConfig,
  testServerConfig,
  updateServerConfig,
  removeServerConfig,
};
