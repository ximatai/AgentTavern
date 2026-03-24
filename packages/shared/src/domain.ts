export type RoomStatus = "active" | "archived";

export type MemberType = "human" | "agent";

export type AgentRoleKind = "none" | "independent" | "assistant";

export type PresenceStatus = "online" | "offline";

export type MessageType =
  | "user_text"
  | "agent_text"
  | "system_notice"
  | "approval_request"
  | "approval_result";

export type MentionStatus =
  | "detected"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "triggered";

export type AgentSessionStatus =
  | "pending"
  | "waiting_approval"
  | "running"
  | "completed"
  | "rejected"
  | "failed"
  | "cancelled";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type Room = {
  id: string;
  name: string;
  inviteToken: string;
  status: RoomStatus;
  createdAt: string;
};

export type Member = {
  id: string;
  roomId: string;
  type: MemberType;
  roleKind: AgentRoleKind;
  displayName: string;
  ownerMemberId: string | null;
  adapterType: string | null;
  adapterConfig: string | null;
  presenceStatus: PresenceStatus;
  createdAt: string;
};

export type Message = {
  id: string;
  roomId: string;
  senderMemberId: string;
  messageType: MessageType;
  content: string;
  replyToMessageId: string | null;
  createdAt: string;
};

export type Mention = {
  id: string;
  messageId: string;
  targetMemberId: string;
  triggerText: string;
  status: MentionStatus;
  createdAt: string;
};

export type Approval = {
  id: string;
  roomId: string;
  requesterMemberId: string;
  ownerMemberId: string;
  agentMemberId: string;
  triggerMessageId: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt: string | null;
};

export type AgentSession = {
  id: string;
  roomId: string;
  agentMemberId: string;
  triggerMessageId: string;
  requesterMemberId: string;
  approvalId: string | null;
  approvalRequired: boolean;
  status: AgentSessionStatus;
  startedAt: string | null;
  endedAt: string | null;
};
