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
  ownerMemberId: string | null;
  secretaryMemberId: string | null;
  secretaryMode: RoomSecretaryMode;
  createdAt: string;
};

export type RoomInviteRecord = {
  id: string;
  name: string;
  inviteToken: string;
  ownerMemberId?: string | null;
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

export type DisbandRoomResult = {
  roomId: string;
  status: "archived";
  disbandedAt: string;
  disbandedByMemberId: string;
};

export type TransferRoomOwnershipResult = Room;

export type CreateRoomResult = {
  room: {
    id: string;
    name: string;
    inviteToken: string;
    ownerMemberId: string | null;
    secretaryMemberId: string | null;
    secretaryMode: RoomSecretaryMode;
    inviteUrl: string;
  };
  join: JoinResult;
};

async function getRoom(roomId: string): Promise<Room> {
  return request<Room>(`/api/rooms/${roomId}`);
}

async function getRoomSummary(roomId: string): Promise<RoomSummaryResponse> {
  return request<RoomSummaryResponse>(`/api/rooms/${roomId}/summary`);
}

async function createRoom(
  name: string,
  citizenId: string,
  citizenToken: string,
): Promise<CreateRoomResult> {
  return request("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name, citizenId, citizenToken }),
  });
}

async function getRoomInvite(inviteToken: string): Promise<RoomInviteRecord> {
  return request<RoomInviteRecord>(`/api/invites/${inviteToken}`);
}

async function joinRoom(
  inviteToken: string,
  citizenId: string,
  citizenToken: string,
): Promise<JoinResult> {
  return request<JoinResult>(`/api/invites/${inviteToken}/join`, {
    method: "POST",
    body: JSON.stringify({ citizenId, citizenToken }),
  });
}

async function joinExistingRoom(
  roomId: string,
  citizenId: string,
  citizenToken: string,
): Promise<JoinResult> {
  return request<JoinResult>(`/api/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ citizenId, citizenToken }),
  });
}

async function createDirectRoom(params: {
  actorCitizenId: string;
  actorCitizenToken: string;
  peerCitizenId: string;
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
  targetCitizenId: string,
): Promise<JoinResult> {
  return request<JoinResult>(`/api/rooms/${roomId}/pull`, {
    method: "POST",
    body: JSON.stringify({ actorMemberId, wsToken, targetCitizenId }),
  });
}

async function getRoomMembers(roomId: string): Promise<PublicMember[]> {
  return request<PublicMember[]>(`/api/rooms/${roomId}/members`);
}

async function getRoomMessages(roomId: string): Promise<PublicMessage[]> {
  return request<PublicMessage[]>(`/api/rooms/${roomId}/messages`);
}

async function getJoinedRooms(
  citizenId: string,
  citizenToken: string,
): Promise<{ rooms: JoinedRoomRecord[] }> {
  return request<{ rooms: JoinedRoomRecord[] }>(
    `/api/me/rooms?citizenId=${citizenId}&citizenToken=${citizenToken}`,
  );
}

async function updateRoomSecretary(params: UpdateRoomSecretaryParams): Promise<Room> {
  return request<Room>(`/api/rooms/${params.roomId}/secretary`, {
    method: "PATCH",
    body: JSON.stringify(params),
  });
}

async function disbandRoom(
  roomId: string,
  actorMemberId: string,
  wsToken: string,
): Promise<DisbandRoomResult> {
  return request<DisbandRoomResult>(`/api/rooms/${roomId}/disband`, {
    method: "POST",
    body: JSON.stringify({ actorMemberId, wsToken }),
  });
}

async function transferRoomOwnership(
  roomId: string,
  actorMemberId: string,
  wsToken: string,
  nextOwnerMemberId: string,
): Promise<TransferRoomOwnershipResult> {
  return request<TransferRoomOwnershipResult>(`/api/rooms/${roomId}/ownership/transfer`, {
    method: "POST",
    body: JSON.stringify({ actorMemberId, wsToken, nextOwnerMemberId }),
  });
}

async function leaveRoom(
  roomId: string,
  citizenId: string,
  citizenToken: string,
): Promise<{ left: boolean; roomId: string; citizenId: string; memberId: string | null }> {
  return request(`/api/rooms/${roomId}/leave`, {
    method: "POST",
    body: JSON.stringify({ citizenId, citizenToken }),
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
  disbandRoom,
  transferRoomOwnership,
  leaveRoom,
};
