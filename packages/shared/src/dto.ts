import type {
  AgentRoleKind,
  ApprovalStatus,
  MemberType,
  MessageType,
  PresenceStatus,
} from "./domain";

export type PublicMember = {
  id: string;
  roomId: string;
  type: MemberType;
  roleKind: AgentRoleKind;
  displayName: string;
  ownerMemberId: string | null;
  presenceStatus: PresenceStatus;
  createdAt: string;
};

export type PublicMessage = {
  id: string;
  roomId: string;
  senderMemberId: string;
  messageType: MessageType;
  content: string;
  replyToMessageId: string | null;
  createdAt: string;
};

export type PublicApproval = {
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
