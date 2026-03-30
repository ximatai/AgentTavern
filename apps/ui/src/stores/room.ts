import { create } from "zustand";
import type { PublicMember, Room, RoomSummary } from "@agent-tavern/shared";

import {
  createRoom as createRoomAPI,
  createDirectRoom as createDirectRoomAPI,
  getJoinedRooms as getJoinedRoomsAPI,
  getRoom,
  getRoomSummary as getRoomSummaryAPI,
  getRoomMembers,
  getRoomMessages,
  joinExistingRoom as joinExistingRoomAPI,
  joinRoom as joinRoomAPI,
  pullPrincipal as pullPrincipalAPI,
  updateRoomSecretary as updateRoomSecretaryAPI,
} from "../api/rooms";
import { getLobbyPresence } from "../api/principals";
import type { JoinResult } from "../api/rooms";
import type { LobbyPrincipal } from "../api/principals";
import type { RecentRoomRecord } from "../types";
import { usePrincipalStore } from "./principal";
import { useMessageStore } from "./message";
import { useSessionStore } from "./session";

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
  lobbyPrincipals: LobbyPrincipal[];
  recentRooms: RecentRoomRecord[];
}

interface RoomActions {
  hydrateRoom: (roomId: string) => Promise<void>;
  createRoom: (name: string) => Promise<JoinResult>;
  joinRoom: (inviteToken: string) => Promise<JoinResult>;
  joinExistingRoom: (roomId: string) => Promise<JoinResult>;
  openRecentRoom: (roomId: string) => Promise<JoinResult>;
  startDirectRoom: (targetPrincipalId: string) => Promise<JoinResult>;
  pullPrincipal: (
    roomId: string,
    actorMemberId: string,
    wsToken: string,
    targetPrincipalId: string,
  ) => Promise<JoinResult>;
  updateRoomSecretary: (params: {
    secretaryMode: Room["secretaryMode"];
    secretaryMemberId?: string | null;
  }) => Promise<void>;
  refreshRoomSummary: () => Promise<void>;
  refreshMembers: () => Promise<void>;
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
  const next = [...current];
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
  lobbyPrincipals: [],
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
    const principal = usePrincipalStore.getState().principal;
    if (!principal) throw new Error("Not authenticated");

    const createdRoom = await createRoomAPI(name);
    const joinResult = await joinRoomAPI(
      createdRoom.inviteToken,
      principal.principalId,
      principal.principalToken,
    );

    await get().hydrateRoom(joinResult.roomId);
    set({ self: joinResult });

    set((state) => ({
      recentRooms: mergeRecentRoom(state.recentRooms, {
        roomId: createdRoom.id,
        name: createdRoom.name,
        inviteToken: createdRoom.inviteToken,
      }),
    }));
    get().persistRecentRooms();

    return joinResult;
  },

  joinRoom: async (inviteToken: string) => {
    const principal = usePrincipalStore.getState().principal;
    if (!principal) throw new Error("Not authenticated");

    const joinResult = await joinRoomAPI(
      inviteToken,
      principal.principalId,
      principal.principalToken,
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
    const principal = usePrincipalStore.getState().principal;
    if (!principal) throw new Error("Not authenticated");

    const joinResult = await joinExistingRoomAPI(
      roomId,
      principal.principalId,
      principal.principalToken,
    );

    await get().hydrateRoom(joinResult.roomId);
    set({ self: joinResult });

    return joinResult;
  },

  openRecentRoom: async (roomId: string) => {
    return get().joinExistingRoom(roomId);
  },

  startDirectRoom: async (targetPrincipalId: string) => {
    const principal = usePrincipalStore.getState().principal;
    if (!principal) throw new Error("Not authenticated");

    const result = await createDirectRoomAPI({
      actorPrincipalId: principal.principalId,
      actorPrincipalToken: principal.principalToken,
      peerPrincipalId: targetPrincipalId,
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
    targetPrincipalId: string,
  ) => {
    return pullPrincipalAPI(roomId, actorMemberId, wsToken, targetPrincipalId);
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
      set({ lobbyPrincipals: payload.principals });
    } catch {
      set({ lobbyPrincipals: [] });
    }
  },

  refreshJoinedRooms: async () => {
    const principal = usePrincipalStore.getState().principal;
    if (!principal) {
      set({ recentRooms: [] });
      return;
    }

    try {
      const payload = await getJoinedRoomsAPI(principal.principalId, principal.principalToken);
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
    const principal = usePrincipalStore.getState().principal;
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
    const principal = usePrincipalStore.getState().principal;
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
      lobbyPrincipals: [],
    });
  },
}));
