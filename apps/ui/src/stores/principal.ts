import type { AgentBackendType, OpenAICompatibleBackendConfig } from "@agent-tavern/shared";

import { create } from "zustand";

import { bootstrapPrincipal as bootstrapAPI } from "../api/principals";
import type { PrincipalSession } from "../api/principals";

const STORAGE_KEY = "agent-tavern-principal";

interface PrincipalState {
  principal: PrincipalSession | null;
  loginKey: string;
  globalDisplayName: string;
  privateAssetsVersion: number;
  restoreReady: boolean;
}

interface PrincipalActions {
  bootstrap: (params: {
    kind: "human" | "agent";
    loginKey: string;
    globalDisplayName: string;
    backendType: AgentBackendType | null;
    backendThreadId: string | null;
    backendConfig?: OpenAICompatibleBackendConfig | null;
  }) => Promise<PrincipalSession>;
  logout: () => void;
  restoreFromStorage: () => Promise<void>;
  persistToStorage: () => void;
  markPrivateAssetsChanged: () => void;
}

export type PrincipalStore = PrincipalState & PrincipalActions;

export const usePrincipalStore = create<PrincipalStore>()((set, get) => ({
  principal: null,
  loginKey: "",
  globalDisplayName: "",
  privateAssetsVersion: 0,
  restoreReady: false,

  bootstrap: async (params) => {
    const session = await bootstrapAPI(params);
    set({
      principal: session,
      loginKey: session.loginKey,
      globalDisplayName: session.globalDisplayName,
      restoreReady: true,
    });
    get().persistToStorage();
    return session;
  },

  logout: () => {
    set({
      principal: null,
      loginKey: "",
      globalDisplayName: "",
      privateAssetsVersion: 0,
      restoreReady: true,
    });
    localStorage.removeItem(STORAGE_KEY);
  },

  restoreFromStorage: async () => {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (!cached) {
      set({ restoreReady: true });
      return;
    }

    try {
      const parsed = JSON.parse(cached) as PrincipalSession;
      if (parsed.kind !== "human" && parsed.kind !== "agent") {
        localStorage.removeItem(STORAGE_KEY);
        set({ restoreReady: true });
        return;
      }
      const refreshed = await bootstrapAPI({
        kind: parsed.kind,
        loginKey: parsed.loginKey,
        globalDisplayName: parsed.globalDisplayName,
        backendType: parsed.backendType,
        backendThreadId: parsed.backendThreadId,
        backendConfig: parsed.backendConfig,
      });
      set({
        principal: refreshed,
        loginKey: refreshed.loginKey,
        globalDisplayName: refreshed.globalDisplayName,
        restoreReady: true,
      });
      get().persistToStorage();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      set({
        principal: null,
        loginKey: "",
        globalDisplayName: "",
        privateAssetsVersion: 0,
        restoreReady: true,
      });
    }
  },

  persistToStorage: () => {
    const { principal } = get();
    if (!principal) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(principal));
  },

  markPrivateAssetsChanged: () => {
    set((state) => ({ privateAssetsVersion: state.privateAssetsVersion + 1 }));
  },
}));
