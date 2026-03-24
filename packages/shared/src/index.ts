export type MemberType = "human" | "agent";

export type AgentRoleKind = "none" | "independent" | "assistant";

export type RealtimeEvent = {
  type: string;
  payload: Record<string, unknown>;
};

