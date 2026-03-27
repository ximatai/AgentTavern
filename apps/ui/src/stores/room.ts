import { create } from "zustand";
import type { PublicMember, Room } from "@agent-tavern/shared";

import {
  createRoom as createRoomAPI,
  createDirectRoom as createDirectRoomAPI,
  getRoom,
  getRoomMembers,
  getRoomMessages,
  joinExistingRoom as joinExistingRoomAPI,
  joinRoom as joinRoomAPI,
  pullPrincipal as pullPrincipalAPI,
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
  const filtered = items.filter((item) => item.roomId !== next.roomId);
  filtered.unshift({ ...next, visitedAt: new Date().toISOString() });
  return sortRecentRooms(filtered).slice(0, MAX_RECENT_ROOMS);
}

function recentRoomsStorageKey(
  principal: Pick<{ kind: string; loginKey: string }, "kind" | "loginKey">,
): string {
  return `agent-tavern-recent-rooms:${principal.kind}:${principal.loginKey}`;
}

interface RoomState {
  room: Room | null;
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
    memberId: string,
    wsToken: string,
    targetPrincipalId: string,
  ) => Promise<JoinResult>;
  refreshMembers: () => Promise<void>;
  addOrUpdateMember: (member: PublicMember) => void;
  removeMember: (memberId: string) => void;
  refreshLobbyPresence: () => Promise<void>;
  restoreRecentRooms: () => void;
  persistRecentRooms: () => void;
  reset: () => void;
}

type RoomStore = RoomState & RoomActions;

export const useRoomStore = create<RoomStore>()((set, get) => ({
  room: null,
  self: null,
  members: [],
  lobbyPrincipals: [],
  recentRooms: [],

  hydrateRoom: async (roomId: string) => {
    const [roomData, membersData, messagesData] = await Promise.all([
      getRoom(roomId),
      getRoomMembers(roomId),
      getRoomMessages(roomId),
    ]);
    set({ room: roomData, members: membersData });
    useMessageStore.getState().setMessages(messagesData);
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
      principalId: principal.principalId,
      principalToken: principal.principalToken,
      targetPrincipalId,
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
    memberId: string,
    wsToken: string,
    targetPrincipalId: string,
  ) => {
    return pullPrincipalAPI(roomId, memberId, wsToken, targetPrincipalId);
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
      set({ recentRooms: sortRecentRooms(parsed) });
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
      self: null,
      members: [],
      lobbyPrincipals: [],
    });
  },
}));
