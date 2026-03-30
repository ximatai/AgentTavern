import { eq } from "drizzle-orm";

import type {
  AgentSession,
  Message,
  MessageAttachment,
  RealtimeEvent,
  SystemMessageData,
} from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentSessions, rooms } from "../db/schema";
import { insertMessage } from "../lib/message-records";
import { normalizeRoomSummaryOutput, upsertRoomSummary } from "../lib/room-summary";
import { submitMessageInternal } from "../lib/message-submission";
import {
  createAgentFailedSystemData,
  createStructuredSystemMessage,
} from "../lib/system-messages";
import { toPublicMessage } from "../lib/public";
import { broadcastToRoom } from "../realtime";

export function now(): string {
  return new Date().toISOString();
}

export function createSessionStartedEvent(roomId: string, session: AgentSession): RealtimeEvent {
  return {
    type: "agent.session.started",
    roomId,
    timestamp: now(),
    payload: { session },
  };
}

export function createSessionCompletedEvent(roomId: string, session: AgentSession): RealtimeEvent {
  return {
    type: "agent.session.completed",
    roomId,
    timestamp: now(),
    payload: { session },
  };
}

export function createSessionFailedEvent(
  roomId: string,
  session: AgentSession,
  error: string,
): RealtimeEvent {
  return {
    type: "agent.session.failed",
    roomId,
    timestamp: now(),
    payload: { session, error },
  };
}

export function createStreamDeltaEvent(
  roomId: string,
  sessionId: string,
  messageId: string,
  delta: string,
): RealtimeEvent {
  return {
    type: "agent.stream.delta",
    roomId,
    timestamp: now(),
    payload: {
      sessionId,
      messageId,
      delta,
    },
  };
}

export function createMessageCreatedEvent(roomId: string, message: Message): RealtimeEvent {
  return {
    type: "message.created",
    roomId,
    timestamp: now(),
    payload: { message: toPublicMessage(message) },
  };
}

export function createMessageCommittedEvent(
  roomId: string,
  sessionId: string,
  message: Message,
): RealtimeEvent {
  return {
    type: "agent.message.committed",
    roomId,
    timestamp: now(),
    payload: {
      sessionId,
      message: toPublicMessage(message),
    },
  };
}

function createFailureMessage(
  roomId: string,
  agentMemberId: string,
  triggerMessageId: string,
  failure: string | SystemMessageData,
): Message {
  return createStructuredSystemMessage({
    roomId,
    senderMemberId: agentMemberId,
    messageType: "system_notice",
    systemData:
      typeof failure === "string" ? createAgentFailedSystemData(failure) : failure,
    replyToMessageId: triggerMessageId,
    createdAt: now(),
  });
}

export function markSessionRunning(session: AgentSession): AgentSession {
  const runningSession: AgentSession = {
    ...session,
    status: "running",
    startedAt: now(),
    endedAt: null,
  };

  db
    .update(agentSessions)
    .set({
      status: runningSession.status,
      startedAt: runningSession.startedAt,
      endedAt: runningSession.endedAt,
    })
    .where(eq(agentSessions.id, session.id))
    .run();

  broadcastToRoom(
    session.roomId,
    createSessionStartedEvent(session.roomId, runningSession),
  );

  return runningSession;
}

export function commitSessionMessage(params: {
  session: AgentSession;
  messageId: string;
  content: string;
  summaryText?: string | null;
  attachments?: MessageAttachment[];
  replyToMessageId: string;
}): { session: AgentSession; queuedSessionIds: string[] } {
  const room = db.select().from(rooms).where(eq(rooms.id, params.session.roomId)).get();
  const summaryEligible =
    room?.secretaryMemberId === params.session.agentMemberId &&
    room.secretaryMode === "coordinate_and_summarize";
  const parsedContent = summaryEligible
    ? normalizeRoomSummaryOutput({
        visibleContent: params.content,
        summaryText: params.summaryText,
      })
    : { visibleContent: params.content.trim(), summaryText: null };

  const { message: committedMessage, queuedSessionIds } = submitMessageInternal({
    roomId: params.session.roomId,
    sender: {
      id: params.session.agentMemberId,
      roomId: params.session.roomId,
      principalId: null,
      type: "agent",
      roleKind: "independent",
      displayName: "",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt: now(),
    },
    content: parsedContent.visibleContent,
    attachments: params.attachments ?? [],
    replyToMessageId: params.replyToMessageId,
    messageId: params.messageId,
    draftAttachmentIds: params.attachments?.map((attachment) => attachment.id) ?? [],
    attachmentUploaderMemberId: params.session.agentMemberId,
  });

  if (summaryEligible && parsedContent.summaryText) {
    upsertRoomSummary({
      roomId: params.session.roomId,
      summaryText: parsedContent.summaryText,
      generatedByMemberId: params.session.agentMemberId,
      sourceMessageId: committedMessage.id,
      createdAt: committedMessage.createdAt,
    });
  }
  broadcastToRoom(
    params.session.roomId,
    createMessageCommittedEvent(params.session.roomId, params.session.id, committedMessage),
  );

  const completedSession: AgentSession = {
    ...params.session,
    status: "completed",
    endedAt: now(),
  };

  db
    .update(agentSessions)
    .set({
      status: completedSession.status,
      endedAt: completedSession.endedAt,
    })
    .where(eq(agentSessions.id, params.session.id))
    .run();

  broadcastToRoom(
    params.session.roomId,
    createSessionCompletedEvent(params.session.roomId, completedSession),
  );

  return { session: completedSession, queuedSessionIds };
}

export function completeSessionSilently(session: AgentSession): AgentSession {
  const completedSession: AgentSession = {
    ...session,
    status: "completed",
    endedAt: now(),
  };

  db
    .update(agentSessions)
    .set({
      status: completedSession.status,
      endedAt: completedSession.endedAt,
    })
    .where(eq(agentSessions.id, session.id))
    .run();

  broadcastToRoom(
    session.roomId,
    createSessionCompletedEvent(session.roomId, completedSession),
  );

  return completedSession;
}

export function completeSessionWithSummary(params: {
  session: AgentSession;
  summaryText: string;
}): AgentSession {
  upsertRoomSummary({
    roomId: params.session.roomId,
    summaryText: params.summaryText,
    generatedByMemberId: params.session.agentMemberId,
    sourceMessageId: null,
    createdAt: now(),
  });

  return completeSessionSilently(params.session);
}

export function failSession(
  session: AgentSession,
  failure: string | SystemMessageData,
): AgentSession {
  const endedAt = now();
  const failedSession: AgentSession = {
    ...session,
    status: "failed",
    endedAt,
  };

  db
    .update(agentSessions)
    .set({
      status: failedSession.status,
      endedAt: failedSession.endedAt,
    })
    .where(eq(agentSessions.id, session.id))
    .run();

  broadcastToRoom(
    session.roomId,
    createSessionFailedEvent(
      session.roomId,
      failedSession,
      typeof failure === "string" ? failure : failure.detail,
    ),
  );

  const failureMessage = createFailureMessage(
    session.roomId,
    session.agentMemberId,
    session.triggerMessageId,
    failure,
  );

  insertMessage(failureMessage);
  broadcastToRoom(session.roomId, createMessageCreatedEvent(session.roomId, failureMessage));

  return failedSession;
}
