export type RoomStatus = "active" | "archived";

export type PrincipalKind = "human" | "agent";

export type MemberType = "human" | "agent";

export type AgentRoleKind = "none" | "independent" | "assistant";

export type PresenceStatus = "online" | "offline";

export type MessageType =
  | "user_text"
  | "agent_text"
  | "system_notice"
  | "approval_request"
  | "approval_result";

export type SystemMessageStatus = "info" | "success" | "warning" | "error";

export type SystemMessageKind =
  | "agent_failed"
  | "bridge_waiting"
  | "approval_required"
  | "approval_granted"
  | "approval_rejected"
  | "approval_expired"
  | "approval_owner_offline";

export type SystemMessageData = {
  kind: SystemMessageKind;
  status: SystemMessageStatus;
  title: string;
  detail: string;
  agentMemberId?: string | null;
  ownerMemberId?: string | null;
  requesterMemberId?: string | null;
  approvalId?: string | null;
  grantDuration?: ApprovalGrantDuration | null;
};

export type MessageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
};

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

export type ApprovalGrantDuration =
  | "once"
  | "10_minutes"
  | "30_minutes"
  | "1_hour"
  | "forever";

export type AgentBackendType = "local_process" | "codex_cli";

export type AssistantInviteStatus =
  | "pending"
  | "accepted"
  | "expired"
  | "revoked";

export type PrivateAssistantInviteStatus =
  | "pending"
  | "accepted"
  | "expired"
  | "revoked";

export type AgentBindingStatus =
  | "pending_bridge"
  | "active"
  | "detached"
  | "failed";

export type BridgeStatus = "online" | "offline";

export type BridgeTaskStatus =
  | "pending"
  | "assigned"
  | "accepted"
  | "completed"
  | "failed";

export type Principal = {
  id: string;
  kind: PrincipalKind;
  loginKey: string;
  globalDisplayName: string;
  backendType?: AgentBackendType | null;
  backendThreadId?: string | null;
  status: PresenceStatus;
  createdAt: string;
};

export type PrivateAssistant = {
  id: string;
  ownerPrincipalId: string;
  name: string;
  backendType: AgentBackendType;
  backendThreadId: string | null;
  status: AgentBindingStatus;
  createdAt: string;
};

export type PrivateAssistantInvite = {
  id: string;
  ownerPrincipalId: string;
  name: string;
  backendType: AgentBackendType;
  inviteToken: string;
  status: PrivateAssistantInviteStatus;
  acceptedPrivateAssistantId: string | null;
  createdAt: string;
  expiresAt: string | null;
  acceptedAt: string | null;
};

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
  principalId: string | null;
  type: MemberType;
  roleKind: AgentRoleKind;
  displayName: string;
  ownerMemberId: string | null;
  sourcePrivateAssistantId: string | null;
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
  attachments: MessageAttachment[];
  systemData?: SystemMessageData | null;
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
  grantDuration: ApprovalGrantDuration;
  createdAt: string;
  resolvedAt: string | null;
};

export type AgentAuthorization = {
  id: string;
  roomId: string;
  ownerMemberId: string;
  requesterMemberId: string;
  agentMemberId: string;
  grantDuration: ApprovalGrantDuration;
  remainingUses: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
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

export type AssistantInvite = {
  id: string;
  roomId: string;
  ownerMemberId: string;
  presetDisplayName: string | null;
  backendType: AgentBackendType;
  inviteToken: string;
  status: AssistantInviteStatus;
  acceptedMemberId: string | null;
  createdAt: string;
  expiresAt: string | null;
  acceptedAt: string | null;
};

export type AgentBinding = {
  id: string;
  memberId: string;
  bridgeId: string | null;
  backendType: AgentBackendType;
  backendThreadId: string;
  cwd: string | null;
  status: AgentBindingStatus;
  attachedAt: string;
  detachedAt: string | null;
};

export type BridgeTask = {
  id: string;
  bridgeId: string;
  sessionId: string;
  roomId: string;
  agentMemberId: string;
  requesterMemberId: string;
  backendType: AgentBackendType;
  backendThreadId: string;
  cwd: string | null;
  outputMessageId: string;
  prompt: string;
  contextPayload: string | null;
  status: BridgeTaskStatus;
  createdAt: string;
  assignedAt: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
};
