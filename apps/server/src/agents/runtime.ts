import { desc, eq, inArray } from "drizzle-orm";

import {
  createLocalProcessAdapter,
  type AgentAdapter,
  type AgentRunInput,
  type LocalProcessAdapterConfig,
} from "@agent-tavern/agent-sdk";
import type {
  AgentSession,
  Member,
  Message,
  RealtimeEvent,
  Room,
} from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentSessions, members, messages, rooms } from "../db/schema";
import { createId } from "../lib/id";
import { toPublicMessage } from "../lib/public";
import { broadcastToRoom } from "../realtime";

const agentRunQueue = new Map<string, Promise<void>>();
const CONTEXT_MESSAGE_LIMIT = Number(process.env.AGENT_CONTEXT_MESSAGE_LIMIT ?? 20);

function now(): string {
  return new Date().toISOString();
}

function createSessionStartedEvent(roomId: string, session: AgentSession): RealtimeEvent {
  return {
    type: "agent.session.started",
    roomId,
    timestamp: now(),
    payload: { session },
  };
}

function createSessionCompletedEvent(roomId: string, session: AgentSession): RealtimeEvent {
  return {
    type: "agent.session.completed",
    roomId,
    timestamp: now(),
    payload: { session },
  };
}

function createSessionFailedEvent(
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

function createStreamDeltaEvent(
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

function createMessageCreatedEvent(roomId: string, message: Message): RealtimeEvent {
  return {
    type: "message.created",
    roomId,
    timestamp: now(),
    payload: { message: toPublicMessage(message) },
  };
}

function createMessageCommittedEvent(
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

function parseLocalProcessConfig(raw: string | null): LocalProcessAdapterConfig | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (typeof parsed.command !== "string" || !parsed.command.trim()) {
      return null;
    }

    const args = Array.isArray(parsed.args)
      ? parsed.args.filter((item): item is string => typeof item === "string")
      : undefined;
    const cwd = typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd : undefined;
    const env =
      parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)
        ? Object.fromEntries(
            Object.entries(parsed.env).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined;
    const inputFormat =
      parsed.inputFormat === "json" || parsed.inputFormat === "text"
        ? parsed.inputFormat
        : undefined;
    const maxRuntimeMs =
      typeof parsed.maxRuntimeMs === "number" && parsed.maxRuntimeMs > 0
        ? parsed.maxRuntimeMs
        : undefined;
    const gracefulShutdownMs =
      typeof parsed.gracefulShutdownMs === "number" && parsed.gracefulShutdownMs > 0
        ? parsed.gracefulShutdownMs
        : undefined;

    return {
      command: parsed.command.trim(),
      args,
      cwd,
      env,
      inputFormat,
      maxRuntimeMs,
      gracefulShutdownMs,
    };
  } catch {
    return null;
  }
}

function resolveAgentAdapter(agent: Member): AgentAdapter | null {
  if (agent.adapterType !== "local_process") {
    return null;
  }

  const config = parseLocalProcessConfig(agent.adapterConfig);

  if (!config) {
    return null;
  }

  return createLocalProcessAdapter(config);
}

function buildPrompt(input: {
  room: Room;
  agent: Member;
  requester: Member;
  triggerMessage: Message;
  contextMessages: AgentRunInput["contextMessages"];
}): string {
  const context = input.contextMessages
    .map((message) => `[${message.createdAt}] ${message.senderName}: ${message.content}`)
    .join("\n");

  return [
    `You are ${input.agent.displayName}, a member in the room "${input.room.name}".`,
    `Requester: ${input.requester.displayName}.`,
    "Reply as a chat participant in plain text.",
    "Recent room context:",
    context || "(no context)",
    "Current trigger message:",
    `${input.requester.displayName}: ${input.triggerMessage.content}`,
  ].join("\n");
}

function createFailureMessage(
  roomId: string,
  agentMemberId: string,
  triggerMessageId: string,
  content: string,
): Message {
  return {
    id: createId("msg"),
    roomId,
    senderMemberId: agentMemberId,
    messageType: "system_notice",
    content,
    replyToMessageId: triggerMessageId,
    createdAt: now(),
  };
}

function toRoom(row: {
  id: string;
  name: string;
  inviteToken: string;
  status: string;
  createdAt: string;
}): Room {
  return row as Room;
}

function toMember(row: {
  id: string;
  roomId: string;
  type: string;
  roleKind: string;
  displayName: string;
  ownerMemberId: string | null;
  adapterType: string | null;
  adapterConfig: string | null;
  presenceStatus: string;
  createdAt: string;
}): Member {
  return row as Member;
}

function toMessage(row: {
  id: string;
  roomId: string;
  senderMemberId: string;
  messageType: string;
  content: string;
  replyToMessageId: string | null;
  createdAt: string;
}): Message {
  return row as Message;
}

function toAgentSession(row: {
  id: string;
  roomId: string;
  agentMemberId: string;
  triggerMessageId: string;
  requesterMemberId: string;
  approvalId: string | null;
  approvalRequired: boolean;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
}): AgentSession {
  return row as AgentSession;
}

function failAgentSession(session: AgentSession, error: string): void {
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
    createSessionFailedEvent(session.roomId, failedSession, error),
  );

  const failureMessage = createFailureMessage(
    session.roomId,
    session.agentMemberId,
    session.triggerMessageId,
    error,
  );

  db.insert(messages).values(failureMessage).run();
  broadcastToRoom(session.roomId, createMessageCreatedEvent(session.roomId, failureMessage));
}

async function runAgentSession(sessionId: string): Promise<void> {
  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();

  if (!session || session.status === "completed" || session.status === "failed") {
    return;
  }

  const room = db.select().from(rooms).where(eq(rooms.id, session.roomId)).get();
  const roomMembers = db
    .select()
    .from(members)
    .where(
      inArray(members.id, [session.agentMemberId, session.requesterMemberId]),
    )
    .all();
  const agent = roomMembers.find((member) => member.id === session.agentMemberId);
  const requester = roomMembers.find((member) => member.id === session.requesterMemberId);
  const triggerMessage = db
    .select()
    .from(messages)
    .where(eq(messages.id, session.triggerMessageId))
    .get();

  if (!room || !agent || !requester || !triggerMessage) {
    failAgentSession(toAgentSession(session), "Agent session dependencies are missing.");
    return;
  }

  const typedSession = toAgentSession(session);
  const typedRoom = toRoom(room);
  const typedAgent = toMember(agent);
  const typedRequester = toMember(requester);
  const typedTriggerMessage = toMessage(triggerMessage);
  const adapter = resolveAgentAdapter(typedAgent);

  if (!adapter) {
    failAgentSession(
      typedSession,
      `${typedAgent.displayName} does not have a valid local agent adapter configuration.`,
    );
    return;
  }

  const recentMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, session.roomId))
    .orderBy(desc(messages.createdAt))
    .limit(CONTEXT_MESSAGE_LIMIT)
    .all()
    .reverse();

  const senderIds = [...new Set(recentMessages.map((message) => message.senderMemberId))];
  const contextMembers = senderIds.length
    ? db.select().from(members).where(inArray(members.id, senderIds)).all()
    : [];
  const memberNameMap = new Map(
    contextMembers.map((member) => [member.id, member.displayName]),
  );
  const contextMessages = recentMessages.map((message) => ({
    senderName: memberNameMap.get(message.senderMemberId) ?? message.senderMemberId,
    content: message.content,
    createdAt: message.createdAt,
  }));

  const startedAt = now();
  const runningSession: AgentSession = {
    ...typedSession,
    status: "running",
    startedAt,
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

  const outputMessageId = createId("msg");
  const input: AgentRunInput = {
    roomId: session.roomId,
    agentMemberId: typedAgent.id,
    agentDisplayName: typedAgent.displayName,
    requesterMemberId: typedRequester.id,
    requesterDisplayName: typedRequester.displayName,
    triggerMessageId: typedTriggerMessage.id,
    prompt: buildPrompt({
      room: typedRoom,
      agent: typedAgent,
      requester: typedRequester,
      triggerMessage: typedTriggerMessage,
      contextMessages,
    }),
    contextMessages,
  };

  let finalText = "";
  let failedError: string | null = null;

  try {
    for await (const event of adapter.run(input)) {
      if (event.type === "delta") {
        finalText += event.text;
        broadcastToRoom(
          session.roomId,
          createStreamDeltaEvent(session.roomId, session.id, outputMessageId, event.text),
        );
        continue;
      }

      if (event.type === "failed") {
        failedError = event.error;
        break;
      }

      if (event.type === "completed" && event.finalText) {
        finalText += event.finalText;
      }
    }
  } catch (error) {
    failedError = error instanceof Error ? error.message : "Agent execution failed.";
  }

  if (failedError) {
    failAgentSession(runningSession, failedError);
    return;
  }

  const committedText = finalText.trim();

  if (!committedText) {
    failAgentSession(runningSession, `${typedAgent.displayName} returned an empty response.`);
    return;
  }

  const committedMessage: Message = {
    id: outputMessageId,
    roomId: session.roomId,
    senderMemberId: typedAgent.id,
    messageType: "agent_text",
    content: committedText,
    replyToMessageId: typedTriggerMessage.id,
    createdAt: now(),
  };

  db.insert(messages).values(committedMessage).run();
  broadcastToRoom(
    session.roomId,
    createMessageCommittedEvent(session.roomId, session.id, committedMessage),
  );
  broadcastToRoom(
    session.roomId,
    createMessageCreatedEvent(session.roomId, committedMessage),
  );

  const completedSession: AgentSession = {
    ...runningSession,
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
}

export function queueAgentSession(sessionId: string): void {
  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();

  if (!session) {
    return;
  }

  const queueKey = `${session.roomId}:${session.agentMemberId}`;
  const previous = agentRunQueue.get(queueKey) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => runAgentSession(sessionId))
    .finally(() => {
      if (agentRunQueue.get(queueKey) === current) {
        agentRunQueue.delete(queueKey);
      }
    });

  agentRunQueue.set(queueKey, current);
}
