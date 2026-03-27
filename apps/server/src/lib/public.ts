import type { Approval, Member, Message, PublicApproval, PublicMember, PublicMessage } from "@agent-tavern/shared";

export function toPublicMember(
  member: Member,
  runtimeStatus: PublicMember["runtimeStatus"] = null,
): PublicMember {
  return {
    id: member.id,
    roomId: member.roomId,
    principalId: member.principalId,
    type: member.type,
    roleKind: member.roleKind,
    displayName: member.displayName,
    ownerMemberId: member.ownerMemberId,
    sourcePrivateAssistantId: member.sourcePrivateAssistantId,
    presenceStatus: member.presenceStatus,
    runtimeStatus,
    createdAt: member.createdAt,
  };
}

export function toPublicMessage(
  message: Message,
  sender: Pick<Member, "displayName" | "type" | "roleKind" | "presenceStatus"> | null = null,
): PublicMessage {
  return {
    id: message.id,
    roomId: message.roomId,
    senderMemberId: message.senderMemberId,
    senderDisplayName: message.senderDisplayName ?? sender?.displayName ?? message.senderMemberId,
    senderType: message.senderType ?? sender?.type ?? null,
    senderRoleKind: message.senderRoleKind ?? sender?.roleKind ?? null,
    senderPresenceStatus: sender?.presenceStatus ?? null,
    messageType: message.messageType,
    content: message.content,
    attachments: message.attachments,
    systemData: message.systemData ?? null,
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
    grantDuration: approval.grantDuration,
    createdAt: approval.createdAt,
    resolvedAt: approval.resolvedAt,
  };
}
