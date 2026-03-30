import type { PublicMember, PublicMessage, Room, RoomSecretaryMode, RoomSummary } from "@agent-tavern/shared";

import { request } from "./client";

export type JoinResult = {
  memberId: string;
  roomId: string;
  displayName: string;
  wsToken: string;
};

export type DirectRoomResult = {
  room: Room;
  reused: boolean;
  join: JoinResult;
};

export type JoinedRoomRecord = {
  id: string;
  name: string;
  inviteToken: string;
  secretaryMemberId: string | null;
  secretaryMode: RoomSecretaryMode;
  createdAt: string;
};

export type RoomInviteRecord = {
  id: string;
  name: string;
  inviteToken: string;
  secretaryMemberId?: string | null;
  secretaryMode?: RoomSecretaryMode;
  inviteUrl: string;
};

export type RoomSummaryResponse = {
  summary: RoomSummary | null;
};

export type UpdateRoomSecretaryParams = {
  roomId: string;
  actorMemberId: string;
  wsToken: string;
  secretaryMode: RoomSecretaryMode;
  secretaryMemberId?: string | null;
};

async function getRoom(roomId: string): Promise<Room> {
  return request<Room>(`/api/rooms/${roomId}`);
}

async function getRoomSummary(roomId: string): Promise<RoomSummaryResponse> {
  return request<RoomSummaryResponse>(`/api/rooms/${roomId}/summary`);
}

async function createRoom(name: string): Promise<{
  id: string;
  name: string;
  inviteToken: string;
  secretaryMemberId: string | null;
  secretaryMode: RoomSecretaryMode;
}> {
  return request("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

async function getRoomInvite(inviteToken: string): Promise<RoomInviteRecord> {
  return request<RoomInviteRecord>(`/api/invites/${inviteToken}`);
}

async function joinRoom(
  inviteToken: string,
  principalId: string,
  principalToken: string,
): Promise<JoinResult> {
  return request<JoinResult>(`/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ principalId, principalToken }),
  });
}

async function joinExistingRoom(
  roomId: string,
  principalId: string,
  principalToken: string,
): Promise<JoinResult> {
  return request<JoinResult>(`/api/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ principalId, principalToken }),
  });
}

async function createDirectRoom(params: {
  actorPrincipalId: string;
  actorPrincipalToken: string;
  peerPrincipalId: string;
}): Promise<DirectRoomResult> {
  return request<DirectRoomResult>("/api/direct-rooms", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function pullPrincipal(
  roomId: string,
  actorMemberId: string,
  wsToken: string,
  targetPrincipalId: string,
): Promise<JoinResult> {
  return request<JoinResult>(`/api/rooms/${roomId}/pull`, {
    method: "POST",
    body: JSON.stringify({ actorMemberId, wsToken, targetPrincipalId }),
  });
}

async function getRoomMembers(roomId: string): Promise<PublicMember[]> {
  return request<PublicMember[]>(`/api/rooms/${roomId}/members`);
}

async function getRoomMessages(roomId: string): Promise<PublicMessage[]> {
  return request<PublicMessage[]>(`/api/rooms/${roomId}/messages`);
}

async function getJoinedRooms(
  principalId: string,
  principalToken: string,
): Promise<{ rooms: JoinedRoomRecord[] }> {
  return request<{ rooms: JoinedRoomRecord[] }>(
    `/api/me/rooms?principalId=${principalId}&principalToken=${principalToken}`,
  );
}

async function updateRoomSecretary(params: UpdateRoomSecretaryParams): Promise<Room> {
  return request<Room>(`/api/rooms/${params.roomId}/secretary`, {
    method: "PATCH",
    body: JSON.stringify(params),
  });
}

export {
  getRoom,
  getRoomSummary,
  getRoomInvite,
  createRoom,
  joinRoom,
  joinExistingRoom,
  createDirectRoom,
  pullPrincipal,
  getRoomMembers,
  getRoomMessages,
  getJoinedRooms,
  updateRoomSecretary,
};
