import type {
  AgentBackendType,
  OpenAICompatibleBackendConfig,
  PublicMember,
} from "@agent-tavern/shared";

import { request } from "./client";

export type PrivateAssistantRecord = {
  id: string;
  ownerCitizenId: string;
  name: string;
  backendType: AgentBackendType;
  backendThreadId: string | null;
  status: "pending_bridge" | "active" | "detached" | "failed" | "paused";
  createdAt: string;
};

export type PrivateAssistantInviteRecord = {
  id: string;
  ownerCitizenId: string;
  name: string;
  backendType: AgentBackendType;
  inviteToken: string;
  inviteUrl: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  acceptedPrivateAssistantId: string | null;
  createdAt: string;
  expiresAt: string | null;
  acceptedAt: string | null;
  reused?: boolean;
};

async function getPrivateAssistants(citizenId: string, citizenToken: string): Promise<PrivateAssistantRecord[]> {
  return request<PrivateAssistantRecord[]>(
    `/api/me/assistants?citizenId=${citizenId}&citizenToken=${citizenToken}`,
  );
}

async function getAssistantInvites(citizenId: string, citizenToken: string): Promise<PrivateAssistantInviteRecord[]> {
  return request<PrivateAssistantInviteRecord[]>(
    `/api/me/assistants/invites?citizenId=${citizenId}&citizenToken=${citizenToken}`,
  );
}

async function createAssistantInvite(
  citizenId: string,
  citizenToken: string,
  name: string,
  backendType: AgentBackendType,
): Promise<PrivateAssistantInviteRecord> {
  return request<PrivateAssistantInviteRecord>("/api/me/assistants/invites", {
    method: "POST",
    body: JSON.stringify({ citizenId, citizenToken, name, backendType }),
  });
}

async function createManagedAssistant(
  citizenId: string,
  citizenToken: string,
  name: string,
  backendConfigOrParams: OpenAICompatibleBackendConfig | { serverConfigId: string },
): Promise<PrivateAssistantRecord> {
  const body = "serverConfigId" in backendConfigOrParams
    ? {
        citizenId,
        citizenToken,
        name,
        serverConfigId: backendConfigOrParams.serverConfigId,
      }
    : {
        citizenId,
        citizenToken,
        name,
        backendType: "openai_compatible",
        backendConfig: backendConfigOrParams,
      };

  return request<PrivateAssistantRecord>("/api/me/assistants", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function removeAssistantInvite(
  inviteId: string,
  citizenId: string,
  citizenToken: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/me/assistants/invites/${inviteId}?citizenId=${citizenId}&citizenToken=${citizenToken}`,
    { method: "DELETE" },
  );
}

async function removePrivateAssistant(
  privateAssistantId: string,
  citizenId: string,
  citizenToken: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/me/assistants/${privateAssistantId}?citizenId=${citizenId}&citizenToken=${citizenToken}`,
    { method: "DELETE" },
  );
}

async function pausePrivateAssistant(
  privateAssistantId: string,
  citizenId: string,
  citizenToken: string,
): Promise<PrivateAssistantRecord> {
  return request<PrivateAssistantRecord>(`/api/me/assistants/${privateAssistantId}/pause`, {
    method: "POST",
    body: JSON.stringify({ citizenId, citizenToken }),
  });
}

async function resumePrivateAssistant(
  privateAssistantId: string,
  citizenId: string,
  citizenToken: string,
): Promise<PrivateAssistantRecord> {
  return request<PrivateAssistantRecord>(`/api/me/assistants/${privateAssistantId}/resume`, {
    method: "POST",
    body: JSON.stringify({ citizenId, citizenToken }),
  });
}

async function adoptAssistant(
  roomId: string,
  actorMemberId: string,
  wsToken: string,
  privateAssistantId: string,
): Promise<PublicMember> {
  return request<PublicMember>(`/api/rooms/${roomId}/assistants/adopt`, {
    method: "POST",
    body: JSON.stringify({ actorMemberId, wsToken, privateAssistantId }),
  });
}

async function takeAssistantOffline(
  roomId: string,
  params: {
    actorMemberId: string;
    wsToken: string;
    assistantMemberId: string;
  },
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/rooms/${roomId}/assistants/${params.assistantMemberId}/offline`,
    {
      method: "POST",
      body: JSON.stringify({
        actorMemberId: params.actorMemberId,
        wsToken: params.wsToken,
      }),
    },
  );
}

export {
  getPrivateAssistants,
  getAssistantInvites,
  createManagedAssistant,
  createAssistantInvite,
  removeAssistantInvite,
  removePrivateAssistant,
  pausePrivateAssistant,
  resumePrivateAssistant,
  adoptAssistant,
  takeAssistantOffline,
};
