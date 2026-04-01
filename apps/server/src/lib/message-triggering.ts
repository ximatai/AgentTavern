import { and, desc, eq, or } from "drizzle-orm";

import type {
  AgentSession,
  AgentSessionKind,
  Approval,
  Member,
  Message,
} from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentSessions, approvals, members, mentions, messages, privateAssistants, rooms } from "../db/schema";
import { createId } from "./id";
import { insertMessage } from "./message-records";
import {
  createAgentUnavailableSystemData,
  createApprovalRequiredSystemData,
  createApprovalResultSystemData,
  createStructuredSystemMessage,
} from "./system-messages";
import {
  broadcastToRoom,
  isMemberOnline,
  isCitizenOnline,
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

const ROOM_SECRETARY_COOLDOWN_MS = Number(
  process.env.AGENT_TAVERN_ROOM_SECRETARY_COOLDOWN_MS ?? 15_000,
);

function createPendingSession(params: {
  roomId: string;
  agentMemberId: string;
  kind: AgentSessionKind;
  triggerMessageId: string;
  requesterMemberId: string;
  approvalId: string | null;
  approvalRequired: boolean;
}): AgentSession {
  return {
    id: createId("as"),
    roomId: params.roomId,
    agentMemberId: params.agentMemberId,
    kind: params.kind,
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
  kind: AgentSessionKind;
  triggerMessageId: string;
  requesterMemberId: string;
  approvalId: string;
  resolvedAt: string;
}): AgentSession {
  return {
    id: createId("as"),
    roomId: params.roomId,
    agentMemberId: params.agentMemberId,
    kind: params.kind,
    triggerMessageId: params.triggerMessageId,
    requesterMemberId: params.requesterMemberId,
    approvalId: params.approvalId,
    approvalRequired: true,
    status: "rejected",
    startedAt: null,
    endedAt: params.resolvedAt,
  };
}

function insertPendingSession(session: AgentSession): string[] {
  db.insert(agentSessions).values(session).run();
  return session.approvalRequired ? [] : [session.id];
}

function createWorkflowMessage(params: {
  roomId: string;
  senderMemberId: string;
  messageType: Message["messageType"];
  systemData: NonNullable<Message["systemData"]>;
  replyToMessageId: string;
  createdAt: string;
}): Message {
  return createStructuredSystemMessage({
    roomId: params.roomId,
    senderMemberId: params.senderMemberId,
    messageType: params.messageType as "system_notice" | "approval_request" | "approval_result",
    systemData: params.systemData,
    replyToMessageId: params.replyToMessageId,
    createdAt: params.createdAt,
  });
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
}): string[] {
  markMentionStatus({
    messageId: params.messageId,
    targetMemberId: params.target.id,
    status: "triggered",
  });

  return insertPendingSession(
    createPendingSession({
      roomId: params.roomId,
      agentMemberId: params.target.id,
      kind: "message_reply",
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
}): string[] {
  if (!params.target.ownerMemberId) {
    return [];
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

    return insertPendingSession(
      createPendingSession({
        roomId: params.roomId,
        agentMemberId: params.target.id,
        kind: "message_reply",
        triggerMessageId: params.message.id,
        requesterMemberId: params.senderMemberId,
        approvalId: null,
        approvalRequired: false,
      }),
    );
  }

  if (activeAuthorization) {
    const consumedAuthorization = consumeAuthorization(activeAuthorization);

    if (!consumedAuthorization && activeAuthorization.remainingUses !== null) {
      return [];
    }

    markMentionStatus({
      messageId: params.message.id,
      targetMemberId: params.target.id,
      status: "approved",
    });

    return insertPendingSession(
      createPendingSession({
        roomId: params.roomId,
        agentMemberId: params.target.id,
        kind: "message_reply",
        triggerMessageId: params.message.id,
        requesterMemberId: params.senderMemberId,
        approvalId: null,
        approvalRequired: false,
      }),
    );
  }

  const ownerMember = db
    .select()
    .from(members)
    .where(and(eq(members.id, ownerMemberId), eq(members.roomId, params.roomId)))
    .get() as Member | undefined;
  const ownerOnline = Boolean(
    ownerMember &&
      (isMemberOnline(ownerMemberId, params.roomId) ||
        (ownerMember.citizenId ? isCitizenOnline(ownerMember.citizenId) : false)),
  );

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
        kind: "message_reply",
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
      systemData: createApprovalResultSystemData({
        kind: "approval_owner_offline",
        detail: `${params.target.displayName} cannot start because the owner is offline.`,
        approvalId: offlineApproval.id,
        agentMemberId: params.target.id,
        ownerMemberId,
        requesterMemberId: params.senderMemberId,
      }),
      replyToMessageId: params.message.id,
      createdAt: resolvedAt,
    });

    insertMessage(offlineMessage);
    broadcastToRoom(params.roomId, createMessageCreatedEvent(params.roomId, offlineMessage));
    return [];
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
  const queuedSessionIds = insertPendingSession(
    createPendingSession({
        roomId: params.roomId,
        agentMemberId: params.target.id,
        kind: "message_reply",
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
    systemData: createApprovalRequiredSystemData({
      approvalId: approval.id,
      agentMemberId: params.target.id,
      ownerMemberId,
      requesterMemberId: params.senderMemberId,
      agentDisplayName: params.target.displayName,
    }),
    replyToMessageId: params.message.id,
    createdAt: now(),
  });

  insertMessage(approvalMessage);
  broadcastToRoom(params.roomId, createMessageCreatedEvent(params.roomId, approvalMessage));
  return queuedSessionIds;
}

function handleUnavailableAgentMention(params: {
  roomId: string;
  message: Message;
  target: Member;
  detail: string;
}): void {
  markMentionStatus({
    messageId: params.message.id,
    targetMemberId: params.target.id,
    status: "expired",
  });

  const unavailableMessage = createWorkflowMessage({
    roomId: params.roomId,
    senderMemberId: params.target.id,
    messageType: "system_notice",
    systemData: createAgentUnavailableSystemData(
      params.target.displayName,
      params.detail,
      params.target.id,
    ),
    replyToMessageId: params.message.id,
    createdAt: now(),
  });

  insertMessage(unavailableMessage);
  broadcastToRoom(params.roomId, createMessageCreatedEvent(params.roomId, unavailableMessage));
}

function shouldQueueSecretaryObservation(params: {
  roomId: string;
  sender: Member;
  message: Message;
  explicitMentionNames: Set<string>;
  hasOtherAgentTrigger: boolean;
}): Member | null {
  if (params.sender.type !== "human" || params.message.messageType !== "user_text") {
    return null;
  }

  if (params.explicitMentionNames.size > 0 || params.hasOtherAgentTrigger) {
    return null;
  }

  const room = db
    .select()
    .from(rooms)
    .where(eq(rooms.id, params.roomId))
    .get() as { secretaryMemberId: string | null; secretaryMode: string } | undefined;

  if (!room?.secretaryMemberId || room.secretaryMode === "off") {
    return null;
  }

  const secretary = db
    .select()
    .from(members)
    .where(and(eq(members.id, room.secretaryMemberId), eq(members.roomId, params.roomId)))
    .get() as Member | undefined;

  if (
    !secretary ||
    (secretary.membershipStatus ?? "active") !== "active" ||
    secretary.type !== "agent" ||
    secretary.roleKind !== "independent" ||
    secretary.id === params.sender.id ||
    params.explicitMentionNames.has(secretary.displayName)
  ) {
    return null;
  }

  const openSession = db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.roomId, params.roomId),
        eq(agentSessions.agentMemberId, secretary.id),
        or(
          eq(agentSessions.status, "pending"),
          eq(agentSessions.status, "waiting_approval"),
          eq(agentSessions.status, "running"),
        ),
      ),
    )
    .get();

  if (openSession) {
    return null;
  }

  const latestSecretaryMessage = db
    .select()
    .from(messages)
    .where(and(eq(messages.roomId, params.roomId), eq(messages.senderMemberId, secretary.id)))
    .orderBy(desc(messages.createdAt))
    .get();

  if (latestSecretaryMessage) {
    const elapsedMs =
      new Date(params.message.createdAt).getTime() - new Date(latestSecretaryMessage.createdAt).getTime();
    if (elapsedMs >= 0 && elapsedMs < ROOM_SECRETARY_COOLDOWN_MS) {
      return null;
    }
  }

  return secretary;
}

export function processMessageTriggers(params: {
  roomId: string;
  sender: Member;
  message: Message;
  explicitMentionNames?: string[];
}): string[] {
  const queuedSessionIds: string[] = [];
  const mentionNames = [
    ...extractMentionNames(params.message.content),
    ...(params.explicitMentionNames ?? []).map((value) => value.trim()).filter(Boolean),
  ];
  const explicitMentionNames = new Set(mentionNames);

  if (explicitMentionNames.size === 0 && params.message.replyToMessageId) {
    const replyTargetMessage = db
      .select()
      .from(messages)
      .where(and(eq(messages.id, params.message.replyToMessageId), eq(messages.roomId, params.roomId)))
      .get() as Message | undefined;

    if (replyTargetMessage) {
      const replyTargetSender = db
        .select()
        .from(members)
        .where(and(eq(members.id, replyTargetMessage.senderMemberId), eq(members.roomId, params.roomId)))
        .get() as Member | undefined;

      if (
        replyTargetSender &&
        replyTargetSender.type === "agent" &&
        (replyTargetSender.roleKind === "assistant" || replyTargetSender.roleKind === "independent")
      ) {
        mentionNames.push(replyTargetSender.displayName);
      }
    }
  }

  for (const mentionName of mentionNames) {
    const target = db
      .select()
      .from(members)
      .where(and(eq(members.roomId, params.roomId), eq(members.displayName, mentionName)))
      .get() as Member | undefined;

    if (!target || target.id === params.sender.id) {
      continue;
    }

    const pausedAssistant =
      target.type === "agent" &&
      target.presenceStatus === "offline" &&
      target.sourcePrivateAssistantId
        ? (db
            .select()
            .from(privateAssistants)
            .where(eq(privateAssistants.id, target.sourcePrivateAssistantId))
            .get() as { status: string } | undefined)
        : undefined;

    if (pausedAssistant?.status === "paused") {
      createMentionRecord({
        messageId: params.message.id,
        targetMemberId: target.id,
        triggerText: `@${mentionName}`,
        status: "expired",
        createdAt: now(),
      });
      handleUnavailableAgentMention({
        roomId: params.roomId,
        message: params.message,
        target,
        detail: `${target.displayName} is temporarily offline.`,
      });
      continue;
    }

    createMentionRecord({
      messageId: params.message.id,
      targetMemberId: target.id,
      triggerText: `@${mentionName}`,
      status:
        target.type === "agent" && target.roleKind === "assistant"
          ? "pending_approval"
          : "triggered",
      createdAt: now(),
    });

    if (target.type === "agent" && target.roleKind === "independent") {
      queuedSessionIds.push(
        ...handleIndependentAgentMention({
          roomId: params.roomId,
          senderMemberId: params.sender.id,
          messageId: params.message.id,
          target,
        }),
      );
      continue;
    }

    if (target.type === "agent" && target.roleKind === "assistant") {
      queuedSessionIds.push(
        ...handleAssistantMention({
          roomId: params.roomId,
          senderMemberId: params.sender.id,
          message: params.message,
          target,
        }),
      );
    }
  }

  const secretary = shouldQueueSecretaryObservation({
    roomId: params.roomId,
    sender: params.sender,
    message: params.message,
    explicitMentionNames,
    hasOtherAgentTrigger: queuedSessionIds.length > 0,
  });

  if (secretary) {
    queuedSessionIds.push(
      ...insertPendingSession(
        createPendingSession({
          roomId: params.roomId,
          agentMemberId: secretary.id,
          kind: "room_observe",
          triggerMessageId: params.message.id,
          requesterMemberId: params.sender.id,
          approvalId: null,
          approvalRequired: false,
        }),
      ),
    );
  }

  return queuedSessionIds;
}
