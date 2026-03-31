import type { ApprovalGrantDuration, Message, SystemMessageData } from "@agent-tavern/shared";

import { createId } from "./id";

export function createStructuredSystemMessage(params: {
  roomId: string;
  senderMemberId: string;
  messageType: "system_notice" | "approval_request" | "approval_result";
  systemData: SystemMessageData;
  replyToMessageId: string | null;
  createdAt: string;
}): Message {
  return {
    id: createId("msg"),
    roomId: params.roomId,
    senderMemberId: params.senderMemberId,
    messageType: params.messageType,
    content: params.systemData.detail,
    attachments: [],
    systemData: params.systemData,
    replyToMessageId: params.replyToMessageId,
    createdAt: params.createdAt,
  };
}

export function createAgentFailedSystemData(error: string): SystemMessageData {
  return {
    kind: "agent_failed",
    status: "error",
    title: "Agent run failed",
    detail: error,
  };
}

export function createAgentBusySystemData(
  agentDisplayName: string,
  agentMemberId?: string | null,
): SystemMessageData {
  return {
    kind: "agent_busy",
    status: "warning",
    title: "Agent is busy",
    detail: `${agentDisplayName} is already handling another request in a different room.`,
    agentMemberId: agentMemberId ?? null,
  };
}

export function createAgentUnavailableSystemData(
  agentDisplayName: string,
  detail: string,
  agentMemberId?: string | null,
): SystemMessageData {
  return {
    kind: "agent_unavailable",
    status: "warning",
    title: "Agent is unavailable",
    detail: detail || `${agentDisplayName} is currently unavailable.`,
    agentMemberId: agentMemberId ?? null,
  };
}

export function createBridgeAttachRequiredSystemData(
  agentDisplayName: string,
  agentMemberId?: string | null,
): SystemMessageData {
  return {
    kind: "bridge_attach_required",
    status: "warning",
    title: "Bridge attachment required",
    detail: `${agentDisplayName} is waiting for a local bridge to attach.`,
    agentMemberId: agentMemberId ?? null,
  };
}

export function createBridgeWaitingSystemData(agentDisplayName: string): SystemMessageData {
  return {
    kind: "bridge_waiting",
    status: "warning",
    title: "Waiting for local bridge",
    detail: `${agentDisplayName} is waiting for its local bridge to reconnect.`,
  };
}

export function createApprovalRequiredSystemData(params: {
  approvalId: string;
  agentMemberId: string;
  ownerMemberId: string;
  requesterMemberId: string;
  agentDisplayName: string;
}): SystemMessageData {
  return {
    kind: "approval_required",
    status: "warning",
    title: "Owner approval required",
    detail: `${params.agentDisplayName} is waiting for owner approval.`,
    approvalId: params.approvalId,
    agentMemberId: params.agentMemberId,
    ownerMemberId: params.ownerMemberId,
    requesterMemberId: params.requesterMemberId,
  };
}

export function createApprovalResultSystemData(params: {
  kind: "approval_granted" | "approval_rejected" | "approval_expired" | "approval_owner_offline";
  detail: string;
  approvalId?: string | null;
  agentMemberId: string;
  ownerMemberId?: string | null;
  requesterMemberId?: string | null;
  grantDuration?: ApprovalGrantDuration | null;
}): SystemMessageData {
  return {
    kind: params.kind,
    status:
      params.kind === "approval_granted"
        ? "success"
        : params.kind === "approval_rejected"
          ? "error"
          : "warning",
    title:
      params.kind === "approval_granted"
        ? "Approval granted"
        : params.kind === "approval_rejected"
          ? "Approval rejected"
          : params.kind === "approval_owner_offline"
            ? "Owner unavailable"
            : "Approval expired",
    detail: params.detail,
    approvalId: params.approvalId ?? null,
    agentMemberId: params.agentMemberId,
    ownerMemberId: params.ownerMemberId ?? null,
    requesterMemberId: params.requesterMemberId ?? null,
    grantDuration: params.grantDuration ?? null,
  };
}
