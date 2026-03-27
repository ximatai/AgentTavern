import { create } from "zustand";
import type { ApprovalGrantDuration, PublicApproval } from "@agent-tavern/shared";

import { resolveApproval } from "../api/approvals";

interface ApprovalState {
  pendingApprovals: PublicApproval[];
  approvalGrants: Record<string, ApprovalGrantDuration>;
}

interface ApprovalActions {
  addApproval: (approval: PublicApproval) => void;
  removeApproval: (approvalId: string) => void;
  approve: (params: {
    approvalId: string;
    actorMemberId: string;
    wsToken: string;
  }) => Promise<void>;
  reject: (params: {
    approvalId: string;
    actorMemberId: string;
    wsToken: string;
  }) => Promise<void>;
  setGrantDuration: (approvalId: string, duration: ApprovalGrantDuration) => void;
  reset: () => void;
}

export type ApprovalStore = ApprovalState & ApprovalActions;

export const useApprovalStore = create<ApprovalStore>()((set, get) => ({
  pendingApprovals: [],
  approvalGrants: {},

  addApproval: (approval: PublicApproval) => {
    set((state) => ({
      pendingApprovals: [
        ...state.pendingApprovals.filter((a) => a.id !== approval.id),
        approval,
      ],
    }));
  },

  removeApproval: (approvalId: string) => {
    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.id !== approvalId),
    }));
  },

  approve: async (params) => {
    const { approvalId, actorMemberId, wsToken } = params;
    const grantDuration = get().approvalGrants[approvalId];

    await resolveApproval(approvalId, "approve", {
      actorMemberId,
      wsToken,
      grantDuration,
    });

    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.id !== approvalId),
    }));
  },

  reject: async (params) => {
    const { approvalId, actorMemberId, wsToken } = params;

    await resolveApproval(approvalId, "reject", {
      actorMemberId,
      wsToken,
    });

    set((state) => ({
      pendingApprovals: state.pendingApprovals.filter((a) => a.id !== approvalId),
    }));
  },

  setGrantDuration: (approvalId: string, duration: ApprovalGrantDuration) => {
    set((state) => ({
      approvalGrants: { ...state.approvalGrants, [approvalId]: duration },
    }));
  },

  reset: () => {
    set({ pendingApprovals: [], approvalGrants: {} });
  },
}));
