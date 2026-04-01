import type { AgentSession, AgentSessionKind, PublicMessage } from "@agent-tavern/shared";

export type SessionStream = PublicMessage & {
  sessionId: string;
  agentMemberId: string;
  reasoningContent?: string;
};

export type SessionActor = {
  agentMemberId: string;
};

export type SessionSnapshot = Omit<AgentSession, "kind"> & {
  kind: AgentSessionKind | "unknown";
  kindIsProvisional?: boolean;
  lastError?: string | null;
  outputMessageId?: string | null;
  reasoningText?: string;
};

export type RecentRoomRecord = {
  roomId: string;
  name: string;
  inviteToken: string;
  visitedAt: string;
  lastReadAt?: string | null;
  lastMessageAt?: string | null;
};
