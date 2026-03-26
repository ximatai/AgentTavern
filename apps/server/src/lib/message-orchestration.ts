import { and, eq } from "drizzle-orm";

import type {
  AgentSession,
  Approval,
  Member,
  Message,
  MessageAttachment,
} from "@agent-tavern/shared";

import { queueAgentSession } from "../agents/runtime";
import { db } from "../db/client";
import { agentSessions, approvals, members, mentions, messages } from "../db/schema";
import { createId } from "./id";
import {
  broadcastToRoom,
  isMemberOnline,
} from "../realtime";
import {
  consumeAuthorization,
  createApprovalRequestedEvent,
  createApprovalResolvedEvent,
  createMessageCreatedEvent,
  extractMentionNames,
  findActiveAuthorization,
  markMentionStatus,
  now,
  scheduleApprovalTimeout,
} from "../routes/support";

function createPendingSession(params: {
  roomId: string;
  agentMemberId: string;
  triggerMessageId: string;
  requesterMemberId: string;
  approvalId: string | null;
  approvalRequired: boolean;
}): AgentSession {
  return {
    id: createId("as"),
    roomId: params.roomId,
    agentMemberId: params.agentMemberId,
    triggerMessageId: params.triggerMessageId,
    requesterMemberId: params.requesterMemberId,
    approvalId: params.approvalId,
    approvalRequired: params.approvalRequired,
    status: params.approvalRequired ? "waiting_approval" : "pending",
    startedAt: null,
    endedAt: null,
  };
}

function createResolvedSession(params: {
  roomId: string;
  agentMemberId: string;
  triggerMessageId: string;
  requesterMemberId: string;
  approvalId: string;
  resolvedAt: string;
}): AgentSession {
  return {
    id: createId("as"),
    roomId: params.roomId,
    agentMemberId: params.agentMemberId,
    triggerMessageId: params.triggerMessageId,
    requesterMemberId: params.requesterMemberId,
    approvalId: params.approvalId,
    approvalRequired: true,
    status: "rejected",
    startedAt: null,
    endedAt: params.resolvedAt,
  };
}

function queuePendingSession(session: AgentSession): void {
  db.insert(agentSessions).values(session).run();
  if (!session.approvalRequired) {
    queueAgentSession(session.id);
  }
}

function createWorkflowMessage(params: {
  roomId: string;
  senderMemberId: string;
  messageType: Message["messageType"];
  content: string;
  replyToMessageId: string;
  createdAt: string;
}): Message {
  return {
    id: createId("msg"),
    roomId: params.roomId,
    senderMemberId: params.senderMemberId,
    messageType: params.messageType,
    content: params.content,
    attachments: [],
    replyToMessageId: params.replyToMessageId,
    createdAt: params.createdAt,
  };
}

function createMentionRecord(params: {
  messageId: string;
  targetMemberId: string;
  triggerText: string;
  status: string;
  createdAt: string;
}): void {
  db.insert(mentions).values({
    id: createId("men"),
    messageId: params.messageId,
    targetMemberId: params.targetMemberId,
    triggerText: params.triggerText,
    status: params.status,
    createdAt: params.createdAt,
  }).run();
}

function handleIndependentAgentMention(params: {
  roomId: string;
  senderMemberId: string;
  messageId: string;
  target: Member;
}): void {
  markMentionStatus({
    messageId: params.messageId,
    targetMemberId: params.target.id,
    status: "triggered",
  });

  queuePendingSession(
    createPendingSession({
      roomId: params.roomId,
      agentMemberId: params.target.id,
      triggerMessageId: params.messageId,
      requesterMemberId: params.senderMemberId,
      approvalId: null,
      approvalRequired: false,
    }),
  );
}

function handleAssistantMention(params: {
  roomId: string;
  senderMemberId: string;
  message: Message;
  target: Member;
}): void {
  if (!params.target.ownerMemberId) {
    return;
  }

  const ownerMemberId = params.target.ownerMemberId;
  const activeAuthorization =
    ownerMemberId === params.senderMemberId
      ? null
      : findActiveAuthorization({
          roomId: params.roomId,
          ownerMemberId,
          requesterMemberId: params.senderMemberId,
          agentMemberId: params.target.id,
        });

  if (ownerMemberId === params.senderMemberId) {
    markMentionStatus({
      messageId: params.message.id,
      targetMemberId: params.target.id,
      status: "triggered",
    });

    queuePendingSession(
      createPendingSession({
        roomId: params.roomId,
        agentMemberId: params.target.id,
        triggerMessageId: params.message.id,
        requesterMemberId: params.senderMemberId,
        approvalId: null,
        approvalRequired: false,
      }),
    );
    return;
  }

  if (activeAuthorization) {
    const consumedAuthorization = consumeAuthorization(activeAuthorization);

    if (!consumedAuthorization && activeAuthorization.remainingUses !== null) {
      return;
    }

    markMentionStatus({
      messageId: params.message.id,
      targetMemberId: params.target.id,
      status: "approved",
    });

    queuePendingSession(
      createPendingSession({
        roomId: params.roomId,
        agentMemberId: params.target.id,
        triggerMessageId: params.message.id,
        requesterMemberId: params.senderMemberId,
        approvalId: null,
        approvalRequired: false,
      }),
    );
    return;
  }

  const ownerOnline = isMemberOnline(ownerMemberId, params.roomId);

  if (!ownerOnline) {
    markMentionStatus({
      messageId: params.message.id,
      targetMemberId: params.target.id,
      status: "expired",
    });

    const resolvedAt = now();
    const offlineApproval: Approval = {
      id: createId("apr"),
      roomId: params.roomId,
      requesterMemberId: params.senderMemberId,
      ownerMemberId,
      agentMemberId: params.target.id,
      triggerMessageId: params.message.id,
      status: "expired",
      grantDuration: "once",
      createdAt: resolvedAt,
      resolvedAt,
    };

    db.insert(approvals).values(offlineApproval).run();
    db.insert(agentSessions).values(
      createResolvedSession({
        roomId: params.roomId,
        agentMemberId: params.target.id,
        triggerMessageId: params.message.id,
        requesterMemberId: params.senderMemberId,
        approvalId: offlineApproval.id,
        resolvedAt,
      }),
    ).run();
    broadcastToRoom(params.roomId, createApprovalResolvedEvent(params.roomId, offlineApproval));

    const offlineMessage = createWorkflowMessage({
      roomId: params.roomId,
      senderMemberId: params.target.id,
      messageType: "approval_result",
      content: `${params.target.displayName} cannot start because the owner is offline.`,
      replyToMessageId: params.message.id,
      createdAt: resolvedAt,
    });

    db.insert(messages).values(offlineMessage).run();
    broadcastToRoom(params.roomId, createMessageCreatedEvent(params.roomId, offlineMessage));
    return;
  }

  const approval: Approval = {
    id: createId("apr"),
    roomId: params.roomId,
    requesterMemberId: params.senderMemberId,
    ownerMemberId,
    agentMemberId: params.target.id,
    triggerMessageId: params.message.id,
    status: "pending",
    grantDuration: "once",
    createdAt: now(),
    resolvedAt: null,
  };

  db.insert(approvals).values(approval).run();
  scheduleApprovalTimeout(approval);
  queuePendingSession(
    createPendingSession({
      roomId: params.roomId,
      agentMemberId: params.target.id,
      triggerMessageId: params.message.id,
      requesterMemberId: params.senderMemberId,
      approvalId: approval.id,
      approvalRequired: true,
    }),
  );
  broadcastToRoom(params.roomId, createApprovalRequestedEvent(params.roomId, approval));

  const approvalMessage = createWorkflowMessage({
    roomId: params.roomId,
    senderMemberId: params.target.id,
    messageType: "approval_request",
    content: `${params.target.displayName} is waiting for owner approval.`,
    replyToMessageId: params.message.id,
    createdAt: now(),
  });

  db.insert(messages).values(approvalMessage).run();
  broadcastToRoom(params.roomId, createMessageCreatedEvent(params.roomId, approvalMessage));
}

export function submitMessage(params: {
  roomId: string;
  sender: Member;
  content: string;
  attachments: MessageAttachment[];
}): Message {
  const message: Message = {
    id: createId("msg"),
    roomId: params.roomId,
    senderMemberId: params.sender.id,
    messageType: params.sender.type === "agent" ? "agent_text" : "user_text",
    content: params.content,
    attachments: params.attachments,
    replyToMessageId: null,
    createdAt: now(),
  };

  db.insert(messages).values(message).run();
  broadcastToRoom(params.roomId, createMessageCreatedEvent(params.roomId, message));

  const mentionNames = extractMentionNames(params.content);

  for (const mentionName of mentionNames) {
    const target = db
      .select()
      .from(members)
      .where(and(eq(members.roomId, params.roomId), eq(members.displayName, mentionName)))
      .get() as Member | undefined;

    if (!target) {
      continue;
    }

    createMentionRecord({
      messageId: message.id,
      targetMemberId: target.id,
      triggerText: `@${mentionName}`,
      status:
        target.type === "agent" && target.roleKind === "assistant"
          ? "pending_approval"
          : "triggered",
      createdAt: now(),
    });

    if (target.type === "agent" && target.roleKind === "independent") {
      handleIndependentAgentMention({
        roomId: params.roomId,
        senderMemberId: params.sender.id,
        messageId: message.id,
        target,
      });
      continue;
    }

    if (target.type === "agent" && target.roleKind === "assistant") {
      handleAssistantMention({
        roomId: params.roomId,
        senderMemberId: params.sender.id,
        message,
        target,
      });
    }
  }

  return message;
}
