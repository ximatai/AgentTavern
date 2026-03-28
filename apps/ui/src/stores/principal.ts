import { create } from "zustand";

import { bootstrapPrincipal as bootstrapAPI } from "../api/principals";
import type { PrincipalSession } from "../api/principals";

const STORAGE_KEY = "agent-tavern-principal";

interface PrincipalState {
  principal: PrincipalSession | null;
  loginKey: string;
  globalDisplayName: string;
  privateAssetsVersion: number;
}

interface PrincipalActions {
  bootstrap: (params: {
    kind: "human" | "agent";
    loginKey: string;
    globalDisplayName: string;
    backendType: "codex_cli" | "claude_code" | "local_process" | "opencode" | null;
    backendThreadId: string | null;
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

  bootstrap: async (params) => {
    const session = await bootstrapAPI(params);
    set({
      principal: session,
      loginKey: session.loginKey,
      globalDisplayName: session.globalDisplayName,
    });
    get().persistToStorage();
    return session;
  },

  logout: () => {
    set({ principal: null, loginKey: "", globalDisplayName: "", privateAssetsVersion: 0 });
    localStorage.removeItem(STORAGE_KEY);
  },

  restoreFromStorage: async () => {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (!cached) return;

    try {
      const parsed = JSON.parse(cached) as PrincipalSession;
      if (parsed.kind !== "human" && parsed.kind !== "agent") {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      const refreshed = await bootstrapAPI({
        kind: parsed.kind,
        loginKey: parsed.loginKey,
        globalDisplayName: parsed.globalDisplayName,
        backendType: parsed.backendType,
        backendThreadId: parsed.backendThreadId,
      });
      set({
        principal: refreshed,
        loginKey: refreshed.loginKey,
        globalDisplayName: refreshed.globalDisplayName,
      });
      get().persistToStorage();
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      set({ principal: null, loginKey: "", globalDisplayName: "", privateAssetsVersion: 0 });
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
