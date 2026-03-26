import type {
  ApprovalGrantDuration,
  AgentRoleKind,
  ApprovalStatus,
  MessageAttachment,
  MemberType,
  MessageType,
  PresenceStatus,
  SystemMessageData,
} from "./domain";

export type PublicMemberRuntimeStatus = "ready" | "pending_bridge" | "waiting_bridge" | null;

export type PublicMember = {
  id: string;
  roomId: string;
  type: MemberType;
  roleKind: AgentRoleKind;
  displayName: string;
  ownerMemberId: string | null;
  presenceStatus: PresenceStatus;
  runtimeStatus: PublicMemberRuntimeStatus;
  createdAt: string;
};

export type PublicMessage = {
  id: string;
  roomId: string;
  senderMemberId: string;
  messageType: MessageType;
  content: string;
  attachments: MessageAttachment[];
  systemData: SystemMessageData | null;
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
  grantDuration: ApprovalGrantDuration;
  createdAt: string;
  resolvedAt: string | null;
};
