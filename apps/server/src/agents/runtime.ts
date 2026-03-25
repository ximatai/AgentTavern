import { desc, eq, inArray } from "drizzle-orm";

import {
  createLocalProcessAdapter,
  type AgentAdapter,
  type AgentRunInput,
  type LocalProcessAdapterConfig,
} from "@agent-tavern/agent-sdk";
import type {
  AgentBinding,
  AgentSession,
  BridgeTask,
  Member,
  Message,
  Room,
} from "@agent-tavern/shared";

import { db } from "../db/client";
import {
  agentBindings,
  agentSessions,
  bridgeTasks,
  localBridges,
  members,
  messages,
  rooms,
} from "../db/schema";
import { createId } from "../lib/id";
import { toPublicMessage } from "../lib/public";
import { broadcastToRoom } from "../realtime";
import {
  commitSessionMessage,
  createStreamDeltaEvent,
  failSession,
  markSessionRunning,
  now,
} from "./session-events";

const agentRunQueue = new Map<string, Promise<void>>();
const CONTEXT_MESSAGE_LIMIT = Number(process.env.AGENT_CONTEXT_MESSAGE_LIMIT ?? 20);
const BRIDGE_STALE_AFTER_MS = Number(process.env.AGENT_TAVERN_BRIDGE_STALE_AFTER_MS ?? 20_000);

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

function toAgentBinding(row: {
  id: string;
  memberId: string;
  bridgeId: string | null;
  backendType: string;
  backendThreadId: string;
  cwd: string | null;
  status: string;
  attachedAt: string;
  detachedAt: string | null;
}): AgentBinding {
  return row as AgentBinding;
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
  return {
    ...row,
    attachments: [],
  } as Message;
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

function resolveLocalAdapter(agent: Member): AgentAdapter | null {
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

function enqueueBridgeTask(params: {
  session: AgentSession;
  binding: AgentBinding;
  prompt: string;
  contextPayload: string;
  outputMessageId: string;
}): BridgeTask {
  const task: BridgeTask = {
    id: createId("btsk"),
    bridgeId: params.binding.bridgeId as string,
    sessionId: params.session.id,
    roomId: params.session.roomId,
    agentMemberId: params.session.agentMemberId,
    requesterMemberId: params.session.requesterMemberId,
    backendType: params.binding.backendType,
    backendThreadId: params.binding.backendThreadId,
    cwd: params.binding.cwd,
    outputMessageId: params.outputMessageId,
    prompt: params.prompt,
    contextPayload: params.contextPayload,
    status: "pending",
    createdAt: now(),
    assignedAt: null,
    acceptedAt: null,
    completedAt: null,
    failedAt: null,
  };

  db.insert(bridgeTasks).values(task).run();
  return task;
}

function isBridgeAvailable(bridgeId: string): boolean {
  const bridge = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, bridgeId))
    .get();

  if (!bridge || bridge.status !== "online") {
    return false;
  }

  return Date.now() - new Date(bridge.lastSeenAt).getTime() <= BRIDGE_STALE_AFTER_MS;
}

function createBridgePendingMessage(params: {
  roomId: string;
  agentMemberId: string;
  agentDisplayName: string;
  triggerMessageId: string;
}): Message {
  return {
    id: createId("msg"),
    roomId: params.roomId,
    senderMemberId: params.agentMemberId,
    messageType: "system_notice",
    content: `${params.agentDisplayName} is waiting for its local bridge to reconnect.`,
    attachments: [],
    replyToMessageId: params.triggerMessageId,
    createdAt: now(),
  };
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
    .where(inArray(members.id, [session.agentMemberId, session.requesterMemberId]))
    .all();
  const agent = roomMembers.find((member) => member.id === session.agentMemberId);
  const requester = roomMembers.find((member) => member.id === session.requesterMemberId);
  const triggerMessage = db
    .select()
    .from(messages)
    .where(eq(messages.id, session.triggerMessageId))
    .get();

  if (!room || !agent || !requester || !triggerMessage) {
    failSession(toAgentSession(session), "Agent session dependencies are missing.");
    return;
  }

  const typedSession = toAgentSession(session);
  const typedRoom = toRoom(room);
  const typedAgent = toMember(agent);
  const typedRequester = toMember(requester);
  const typedTriggerMessage = toMessage(triggerMessage);
  const bindingRow = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.memberId, typedAgent.id))
    .get();
  const typedBinding = bindingRow ? toAgentBinding(bindingRow) : null;

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

  if (typedBinding?.backendType === "codex_cli") {
    if (!typedBinding.bridgeId || typedBinding.status !== "active") {
      failSession(
        typedSession,
        `${typedAgent.displayName} is waiting for a local bridge to attach.`,
      );
      return;
    }

    enqueueBridgeTask({
      session: typedSession,
      binding: typedBinding,
      prompt: input.prompt,
      contextPayload: JSON.stringify(input.contextMessages),
      outputMessageId,
    });

    if (!isBridgeAvailable(typedBinding.bridgeId)) {
      const waitingMessage = createBridgePendingMessage({
        roomId: typedSession.roomId,
        agentMemberId: typedAgent.id,
        agentDisplayName: typedAgent.displayName,
        triggerMessageId: typedTriggerMessage.id,
      });

      db.insert(messages).values(waitingMessage).run();
      broadcastToRoom(typedSession.roomId, {
        type: "message.created",
        roomId: typedSession.roomId,
        timestamp: now(),
        payload: { message: toPublicMessage(waitingMessage) },
      });
    }

    return;
  }

  const adapter = resolveLocalAdapter(typedAgent);

  if (!adapter) {
    failSession(
      typedSession,
      `${typedAgent.displayName} does not have a valid local agent adapter configuration.`,
    );
    return;
  }

  const runningSession = markSessionRunning(typedSession);
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
    failSession(runningSession, failedError);
    return;
  }

  const committedText = finalText.trim();

  if (!committedText) {
    failSession(runningSession, `${typedAgent.displayName} returned an empty response.`);
    return;
  }

  commitSessionMessage({
    session: runningSession,
    messageId: outputMessageId,
    content: committedText,
    replyToMessageId: typedTriggerMessage.id,
  });
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
