import type {
  Approval,
  Member,
  Message,
  PublicApproval,
  PublicMember,
  PublicMessage,
} from "@agent-tavern/shared";

export function toPublicMember(member: Member): PublicMember {
  return {
    id: member.id,
    roomId: member.roomId,
    type: member.type,
    roleKind: member.roleKind,
    displayName: member.displayName,
    ownerMemberId: member.ownerMemberId,
    presenceStatus: member.presenceStatus,
    createdAt: member.createdAt,
  };
}

export function toPublicMessage(message: Message): PublicMessage {
  return {
    id: message.id,
    roomId: message.roomId,
    senderMemberId: message.senderMemberId,
    messageType: message.messageType,
    content: message.content,
    replyToMessageId: message.replyToMessageId,
    createdAt: message.createdAt,
  };
}

export function toPublicApproval(approval: Approval): PublicApproval {
  return {
    id: approval.id,
    roomId: approval.roomId,
    requesterMemberId: approval.requesterMemberId,
    ownerMemberId: approval.ownerMemberId,
    agentMemberId: approval.agentMemberId,
    triggerMessageId: approval.triggerMessageId,
    status: approval.status,
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt,
  };
}
