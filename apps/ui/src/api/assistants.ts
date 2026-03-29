import type { AgentBackendType, PublicMember } from "@agent-tavern/shared";

import { request } from "./client";

export type PrivateAssistantRecord = {
  id: string;
  ownerPrincipalId: string;
  name: string;
  backendType: AgentBackendType;
  backendThreadId: string | null;
  status: "pending_bridge" | "active" | "detached" | "failed";
  createdAt: string;
};

export type PrivateAssistantInviteRecord = {
  id: string;
  ownerPrincipalId: string;
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

export type AssistantInviteResult = {
  id: string;
  roomId: string;
  ownerMemberId: string;
  presetDisplayName: string | null;
  backendType: AgentBackendType;
  inviteToken: string;
  inviteUrl: string;
  status: "pending" | "accepted" | "expired" | "revoked";
  expiresAt: string;
  createdAt: string;
};

async function getPrivateAssistants(principalId: string, principalToken: string): Promise<PrivateAssistantRecord[]> {
  return request<PrivateAssistantRecord[]>(
    `/api/me/assistants?principalId=${principalId}&principalToken=${principalToken}`,
  );
}

async function getAssistantInvites(principalId: string, principalToken: string): Promise<PrivateAssistantInviteRecord[]> {
  return request<PrivateAssistantInviteRecord[]>(
    `/api/me/assistants/invites?principalId=${principalId}&principalToken=${principalToken}`,
  );
}

async function createAssistantInvite(
  principalId: string,
  principalToken: string,
  name: string,
  backendType: AgentBackendType,
): Promise<PrivateAssistantInviteRecord> {
  return request<PrivateAssistantInviteRecord>("/api/me/assistants/invites", {
    method: "POST",
    body: JSON.stringify({ principalId, principalToken, name, backendType }),
  });
}

async function removeAssistantInvite(
  inviteId: string,
  principalId: string,
  principalToken: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/me/assistants/invites/${inviteId}?principalId=${principalId}&principalToken=${principalToken}`,
    { method: "DELETE" },
  );
}

async function removePrivateAssistant(
  privateAssistantId: string,
  principalId: string,
  principalToken: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/me/assistants/${privateAssistantId}?principalId=${principalId}&principalToken=${principalToken}`,
    { method: "DELETE" },
  );
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

async function createRoomAssistantInvite(
  roomId: string,
  params: {
    actorMemberId: string;
    wsToken: string;
    backendType: AgentBackendType;
    presetDisplayName?: string;
  },
): Promise<AssistantInviteResult> {
  return request<AssistantInviteResult>(`/api/rooms/${roomId}/assistant-invites`, {
    method: "POST",
    body: JSON.stringify(params),
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
  createAssistantInvite,
  removeAssistantInvite,
  removePrivateAssistant,
  adoptAssistant,
  createRoomAssistantInvite,
  takeAssistantOffline,
};
