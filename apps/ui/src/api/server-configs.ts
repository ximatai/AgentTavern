import type { AgentBackendType, OpenAICompatibleBackendConfig } from "@agent-tavern/shared";

import { request } from "./client";

export type ServerConfigRecord = {
  id: string;
  ownerPrincipalId: string;
  name: string;
  backendType: AgentBackendType;
  visibility: "private" | "shared";
  createdAt: string;
  updatedAt: string;
  config: OpenAICompatibleBackendConfig;
};

export type SharedServerConfigRecord = {
  id: string;
  ownerPrincipalId: string;
  name: string;
  backendType: AgentBackendType;
  visibility: "private" | "shared";
  createdAt: string;
  updatedAt: string;
  config: Omit<OpenAICompatibleBackendConfig, "apiKey" | "headers">;
  hasAuth: boolean;
};

async function getMyServerConfigs(principalId: string, principalToken: string): Promise<ServerConfigRecord[]> {
  return request<ServerConfigRecord[]>(
    `/api/me/server-configs?principalId=${principalId}&principalToken=${principalToken}`,
  );
}

async function getSharedServerConfigs(
  principalId: string,
  principalToken: string,
): Promise<SharedServerConfigRecord[]> {
  return request<SharedServerConfigRecord[]>(
    `/api/server-configs/shared?principalId=${principalId}&principalToken=${principalToken}`,
  );
}

async function createServerConfig(params: {
  principalId: string;
  principalToken: string;
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

async function updateServerConfig(params: {
  configId: string;
  principalId: string;
  principalToken: string;
  name?: string;
  visibility?: "private" | "shared";
  config?: OpenAICompatibleBackendConfig;
}): Promise<ServerConfigRecord> {
  return request<ServerConfigRecord>(`/api/me/server-configs/${params.configId}`, {
    method: "PATCH",
    body: JSON.stringify({
      principalId: params.principalId,
      principalToken: params.principalToken,
      ...(params.name ? { name: params.name } : {}),
      ...(params.visibility ? { visibility: params.visibility } : {}),
      ...(params.config ? { config: params.config } : {}),
    }),
  });
}

async function removeServerConfig(
  configId: string,
  principalId: string,
  principalToken: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/me/server-configs/${configId}?principalId=${principalId}&principalToken=${principalToken}`,
    {
      method: "DELETE",
    },
  );
}

export {
  getMyServerConfigs,
  getSharedServerConfigs,
  createServerConfig,
  updateServerConfig,
  removeServerConfig,
};
