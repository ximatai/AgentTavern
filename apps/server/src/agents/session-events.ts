import { eq } from "drizzle-orm";

import type { AgentSession, Message, RealtimeEvent, SystemMessageData } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentSessions, messages } from "../db/schema";
import { insertMessage } from "../lib/message-records";
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
  replyToMessageId: string;
}): AgentSession {
  const committedMessage: Message = {
    id: params.messageId,
    roomId: params.session.roomId,
    senderMemberId: params.session.agentMemberId,
    messageType: "agent_text",
    content: params.content,
    attachments: [],
    replyToMessageId: params.replyToMessageId,
    createdAt: now(),
  };

  db.insert(messages).values({
    id: committedMessage.id,
    roomId: committedMessage.roomId,
    senderMemberId: committedMessage.senderMemberId,
    messageType: committedMessage.messageType,
    content: committedMessage.content,
    systemData: null,
    replyToMessageId: committedMessage.replyToMessageId,
    createdAt: committedMessage.createdAt,
  }).run();
  broadcastToRoom(
    params.session.roomId,
    createMessageCommittedEvent(params.session.roomId, params.session.id, committedMessage),
  );
  broadcastToRoom(
    params.session.roomId,
    createMessageCreatedEvent(params.session.roomId, committedMessage),
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

  return completedSession;
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
