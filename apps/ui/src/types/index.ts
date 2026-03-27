import type { AgentSession, PublicMessage } from "@agent-tavern/shared";

export type SessionStream = PublicMessage & {
  sessionId: string;
  agentMemberId: string;
};

export type SessionActor = {
  agentMemberId: string;
};

export type SessionSnapshot = AgentSession & {
  lastError?: string | null;
  outputMessageId?: string | null;
};

export type RecentRoomRecord = {
  roomId: string;
  name: string;
  inviteToken: string;
  visitedAt: string;
  lastReadAt?: string | null;
  lastMessageAt?: string | null;
};
