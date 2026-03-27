import { create } from "zustand";

export type ConnectionStatus = "connected" | "disconnected" | "none";

interface ConnectionState {
  status: ConnectionStatus;
}

interface ConnectionActions {
  setStatus: (status: ConnectionStatus) => void;
  reset: () => void;
}

export type ConnectionStore = ConnectionState & ConnectionActions;

export const useConnectionStore = create<ConnectionStore>()((set) => ({
  status: "none",

  setStatus: (status) => set({ status }),

  reset: () => set({ status: "none" }),
}));
