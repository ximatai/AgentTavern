import { create } from "zustand";
import type { PublicMember, Room, RoomSummary } from "@agent-tavern/shared";

import {
  createRoom as createRoomAPI,
  createDirectRoom as createDirectRoomAPI,
  disbandRoom as disbandRoomAPI,
  getJoinedRooms as getJoinedRoomsAPI,
  getRoom,
  getRoomSummary as getRoomSummaryAPI,
  getRoomMembers,
  getRoomMessages,
  joinExistingRoom as joinExistingRoomAPI,
  joinRoom as joinRoomAPI,
  leaveRoom as leaveRoomAPI,
  pullPrincipal as pullPrincipalAPI,
  removeRoomMember as removeRoomMemberAPI,
  stopAgentSession as stopAgentSessionAPI,
  transferRoomOwnership as transferRoomOwnershipAPI,
  updateRoomSecretary as updateRoomSecretaryAPI,
} from "../api/rooms";
import { getLobbyPresence } from "../api/citizens";
import type { JoinResult } from "../api/rooms";
import type { LobbyCitizen } from "../api/citizens";
import type { RecentRoomRecord } from "../types";
import { useCitizenStore } from "./citizen";
import { useMessageStore } from "./message";
import { useSessionStore } from "./session";
import { useApprovalStore } from "./approval";

const MAX_RECENT_ROOMS = 6;

function sortRecentRooms(items: RecentRoomRecord[]): RecentRoomRecord[] {
  return [...items].sort((a, b) => b.visitedAt.localeCompare(a.visitedAt));
}

function mergeRecentRoom(
  items: RecentRoomRecord[],
  next: Pick<RecentRoomRecord, "roomId" | "name" | "inviteToken">,
): RecentRoomRecord[] {
  const existing = items.find((item) => item.roomId === next.roomId);
  const filtered = items.filter((item) => item.roomId !== next.roomId);
  filtered.unshift({
    ...existing,
    ...next,
    visitedAt: new Date().toISOString(),
  });
  return sortRecentRooms(filtered).slice(0, MAX_RECENT_ROOMS);
}

function recentRoomsStorageKey(
  principal: Pick<{ kind: string; loginKey: string }, "kind" | "loginKey">,
): string {
  return `agent-tavern-recent-rooms:${principal.kind}:${principal.loginKey}`;
}

interface RoomState {
  room: Room | null;
  roomSummary: RoomSummary | null;
  self: JoinResult | null;
  members: PublicMember[];
  lobbyCitizens: LobbyCitizen[];
  recentRooms: RecentRoomRecord[];
}

interface RoomActions {
  hydrateRoom: (roomId: string) => Promise<void>;
  createRoom: (name: string) => Promise<JoinResult>;
  joinRoom: (inviteToken: string) => Promise<JoinResult>;
  joinExistingRoom: (roomId: string) => Promise<JoinResult>;
  openRecentRoom: (roomId: string) => Promise<JoinResult>;
  startDirectRoom: (targetCitizenId: string) => Promise<JoinResult>;
  pullPrincipal: (
    roomId: string,
    actorMemberId: string,
    wsToken: string,
    targetCitizenId: string,
  ) => Promise<JoinResult>;
  updateRoomSecretary: (params: {
    secretaryMode: Room["secretaryMode"];
    secretaryMemberId?: string | null;
  }) => Promise<void>;
  transferRoomOwnership: (nextOwnerMemberId: string) => Promise<void>;
  removeRoomMember: (targetMemberId: string) => Promise<void>;
  stopAgentSession: (sessionId: string) => Promise<void>;
  disbandRoom: () => Promise<void>;
  leaveRoom: () => Promise<void>;
  clearCurrentRoom: (roomId?: string) => void;
  refreshRoomSummary: () => Promise<void>;
  refreshMembers: () => Promise<void>;
  setRoom: (room: Room) => void;
  addOrUpdateMember: (member: PublicMember) => void;
  removeMember: (memberId: string) => void;
  refreshLobbyPresence: () => Promise<void>;
  refreshJoinedRooms: () => Promise<void>;
  syncUnreadMarks: () => Promise<void>;
  markRoomRead: (roomId: string, readAt?: string) => void;
  restoreRecentRooms: () => void;
  persistRecentRooms: () => void;
  reset: () => void;
}

type RoomStore = RoomState & RoomActions;

function rememberRoom(
  current: RecentRoomRecord[],
  room: Pick<Room, "id" | "name" | "inviteToken"> | null,
): RecentRoomRecord[] {
  if (!room) {
    return current;
  }

  return mergeRecentRoom(current, {
    roomId: room.id,
    name: room.name,
    inviteToken: room.inviteToken,
  });
}

function mergeJoinedRooms(
  current: RecentRoomRecord[],
  joinedRooms: Array<{ id: string; name: string; inviteToken: string; createdAt: string }>,
): RecentRoomRecord[] {
  const joinedRoomIds = new Set(joinedRooms.map((room) => room.id));
  const next = current.filter((item) => joinedRoomIds.has(item.roomId));
  for (const room of joinedRooms) {
    if (next.some((item) => item.roomId === room.id)) continue;
    next.push({
      roomId: room.id,
      name: room.name,
      inviteToken: room.inviteToken,
      visitedAt: room.createdAt,
      lastReadAt: null,
      lastMessageAt: null,
    });
  }
  return sortRecentRooms(next).slice(0, MAX_RECENT_ROOMS);
}

export const useRoomStore = create<RoomStore>()((set, get) => ({
  room: null,
  roomSummary: null,
  self: null,
  members: [],
  lobbyCitizens: [],
  recentRooms: [],

  hydrateRoom: async (roomId: string) => {
    const [roomData, summaryData, membersData, messagesData] = await Promise.all([
      getRoom(roomId),
      getRoomSummaryAPI(roomId),
      getRoomMembers(roomId),
      getRoomMessages(roomId),
    ]);
    set({ room: roomData, roomSummary: summaryData.summary, members: membersData });
    useMessageStore.getState().setMessages(messagesData);
    get().markRoomRead(roomId, messagesData.at(-1)?.createdAt ?? new Date().toISOString());
    useSessionStore.getState().reset();
  },

  createRoom: async (name: string) => {
    const principal = useCitizenStore.getState().principal;
    if (!principal) throw new Error("Not authenticated");

    const created = await createRoomAPI(name, principal.citizenId, principal.citizenToken);
    const joinResult = created.join;
    await get().hydrateRoom(joinResult.roomId);
    set({ self: joinResult });

    set((state) => ({
      recentRooms: mergeRecentRoom(state.recentRooms, {
        roomId: created.room.id,
        name: created.room.name,
        inviteToken: created.room.inviteToken,
      }),
    }));
    get().persistRecentRooms();

    return joinResult;
  },

  joinRoom: async (inviteToken: string) => {
    const principal = useCitizenStore.getState().principal;
    if (!principal) throw new Error("Not authenticated");

    const joinResult = await joinRoomAPI(
      inviteToken,
      principal.citizenId,
      principal.citizenToken,
    );

    await get().hydrateRoom(joinResult.roomId);
    set({ self: joinResult });
    set((state) => ({
      recentRooms: rememberRoom(state.recentRooms, get().room),
    }));
    get().persistRecentRooms();

    return joinResult;
  },

  joinExistingRoom: async (roomId: string) => {
    const principal = useCitizenStore.getState().principal;
    if (!principal) throw new Error("Not authenticated");

    const joinResult = await joinExistingRoomAPI(
      roomId,
      principal.citizenId,
      principal.citizenToken,
    );

    await get().hydrateRoom(joinResult.roomId);
    set({ self: joinResult });

    return joinResult;
  },

  openRecentRoom: async (roomId: string) => {
    return get().joinExistingRoom(roomId);
  },

  startDirectRoom: async (targetCitizenId: string) => {
    const principal = useCitizenStore.getState().principal;
    if (!principal) throw new Error("Not authenticated");

    const result = await createDirectRoomAPI({
      actorCitizenId: principal.citizenId,
      actorCitizenToken: principal.citizenToken,
      peerCitizenId: targetCitizenId,
    });

    await get().hydrateRoom(result.room.id);
    set({ self: result.join });

    set((state) => ({
      recentRooms: mergeRecentRoom(state.recentRooms, {
        roomId: result.room.id,
        name: result.room.name,
        inviteToken: result.room.inviteToken,
      }),
    }));
    get().persistRecentRooms();

    return result.join;
  },

  pullPrincipal: async (
    roomId: string,
    actorMemberId: string,
    wsToken: string,
    targetCitizenId: string,
  ) => {
    return pullPrincipalAPI(roomId, actorMemberId, wsToken, targetCitizenId);
  },

  updateRoomSecretary: async ({ secretaryMode, secretaryMemberId }) => {
    const room = get().room;
    const self = get().self;
    if (!room || !self) throw new Error("Room not ready");

    const updatedRoom = await updateRoomSecretaryAPI({
      roomId: room.id,
      actorMemberId: self.memberId,
      wsToken: self.wsToken,
      secretaryMode,
      secretaryMemberId: secretaryMemberId ?? null,
    });

    set({ room: updatedRoom });
  },

  transferRoomOwnership: async (nextOwnerMemberId) => {
    const room = get().room;
    const self = get().self;
    if (!room || !self) throw new Error("Room not ready");

    const updatedRoom = await transferRoomOwnershipAPI(
      room.id,
      self.memberId,
      self.wsToken,
      nextOwnerMemberId,
    );
    set({ room: updatedRoom });
  },

  removeRoomMember: async (targetMemberId) => {
    const room = get().room;
    const self = get().self;
    if (!room || !self) throw new Error("Room not ready");

    await removeRoomMemberAPI(
      room.id,
      self.memberId,
      self.wsToken,
      targetMemberId,
    );
  },

  stopAgentSession: async (sessionId) => {
    const room = get().room;
    const self = get().self;
    if (!room || !self) throw new Error("Room not ready");

    await stopAgentSessionAPI(
      room.id,
      sessionId,
      self.memberId,
      self.wsToken,
    );
  },

  clearCurrentRoom: (roomId) => {
    const currentRoom = get().room;
    if (roomId && currentRoom && currentRoom.id !== roomId) {
      return;
    }

    set((state) => ({
      room: null,
      roomSummary: null,
      self: null,
      members: [],
      recentRooms: currentRoom
        ? state.recentRooms.filter((item) => item.roomId !== currentRoom.id)
        : state.recentRooms,
    }));
    useMessageStore.getState().reset();
    useSessionStore.getState().reset();
    useApprovalStore.getState().reset();
    get().persistRecentRooms();
  },

  disbandRoom: async () => {
    const room = get().room;
    const self = get().self;
    if (!room || !self) throw new Error("Room not ready");

    await disbandRoomAPI(room.id, self.memberId, self.wsToken);
    await get().refreshJoinedRooms();
    get().clearCurrentRoom(room.id);
  },

  leaveRoom: async () => {
    const room = get().room;
    const principal = useCitizenStore.getState().principal;
    if (!room || !principal) throw new Error("Room not ready");

    await leaveRoomAPI(room.id, principal.citizenId, principal.citizenToken);
    await get().refreshJoinedRooms();
    get().clearCurrentRoom(room.id);
  },

  setRoom: (room) => {
    set({ room });
  },

  refreshRoomSummary: async () => {
    const room = get().room;
    if (!room) return;
    try {
      const summaryData = await getRoomSummaryAPI(room.id);
      set({ roomSummary: summaryData.summary });
    } catch {
      // Ignore transient failures.
    }
  },

  refreshMembers: async () => {
    const { room } = get();
    if (!room) return;
    try {
      const members = await getRoomMembers(room.id);
      set({ members });
    } catch {
      // Ignore transient failures.
    }
  },

  addOrUpdateMember: (member: PublicMember) => {
    set((state) => ({
      members: [...state.members.filter((m) => m.id !== member.id), member],
    }));
  },

  removeMember: (memberId: string) => {
    set((state) => ({
      members: state.members.filter((m) => m.id !== memberId),
    }));
  },

  refreshLobbyPresence: async () => {
    try {
      const payload = await getLobbyPresence();
      set({ lobbyCitizens: payload.citizens });
    } catch {
      set({ lobbyCitizens: [] });
    }
  },

  refreshJoinedRooms: async () => {
    const principal = useCitizenStore.getState().principal;
    if (!principal) {
      set({ recentRooms: [] });
      return;
    }

    try {
      const payload = await getJoinedRoomsAPI(principal.citizenId, principal.citizenToken);
      set((state) => ({
        recentRooms: mergeJoinedRooms(state.recentRooms, payload.rooms),
      }));
      get().persistRecentRooms();
    } catch {
      // Ignore transient failures.
    }
  },

  syncUnreadMarks: async () => {
    const { recentRooms, room } = get();
    if (recentRooms.length === 0) {
      return;
    }

    try {
      const snapshots = await Promise.all(
        recentRooms.map(async (item) => {
          const messages = await getRoomMessages(item.roomId);
          return {
            roomId: item.roomId,
            lastMessageAt: messages.at(-1)?.createdAt ?? null,
          };
        }),
      );

      const latestByRoomId = new Map(
        snapshots.map((item) => [item.roomId, item.lastMessageAt]),
      );

      set((state) => ({
        recentRooms: state.recentRooms.map((item) => {
          const lastMessageAt = latestByRoomId.get(item.roomId) ?? item.lastMessageAt ?? null;
          if (item.roomId === room?.id) {
            return {
              ...item,
              lastMessageAt,
              lastReadAt: lastMessageAt ?? item.lastReadAt ?? new Date().toISOString(),
            };
          }
          return {
            ...item,
            lastMessageAt,
          };
        }),
      }));
      get().persistRecentRooms();
    } catch {
      // Ignore transient failures.
    }
  },

  markRoomRead: (roomId: string, readAt?: string) => {
    set((state) => ({
      recentRooms: state.recentRooms.map((item) =>
        item.roomId === roomId
          ? {
              ...item,
              lastReadAt: readAt ?? item.lastMessageAt ?? new Date().toISOString(),
            }
          : item,
      ),
    }));
    get().persistRecentRooms();
  },

  restoreRecentRooms: () => {
    const principal = useCitizenStore.getState().principal;
    if (!principal) {
      set({ recentRooms: [] });
      return;
    }

    const storageKey = recentRoomsStorageKey(principal);
    const cached = localStorage.getItem(storageKey);
    if (!cached) {
      set({ recentRooms: [] });
      return;
    }

    try {
      const parsed = JSON.parse(cached) as RecentRoomRecord[];
      set({
        recentRooms: sortRecentRooms(
          parsed.map((item) => ({
            ...item,
            lastReadAt: item.lastReadAt ?? null,
            lastMessageAt: item.lastMessageAt ?? null,
          })),
        ),
      });
    } catch {
      localStorage.removeItem(storageKey);
      set({ recentRooms: [] });
    }
  },

  persistRecentRooms: () => {
    const principal = useCitizenStore.getState().principal;
    const { recentRooms } = get();
    if (!principal) return;

    const storageKey = recentRoomsStorageKey(principal);
    localStorage.setItem(storageKey, JSON.stringify(recentRooms));
  },

  reset: () => {
    set({
      room: null,
      roomSummary: null,
      self: null,
      members: [],
      lobbyCitizens: [],
    });
  },
}));
