import { and, desc, eq, inArray, ne, or } from "drizzle-orm";

import {
  completedEventToAction,
  createLocalProcessAdapter,
  type AgentAdapter,
  type AgentMessageAction,
  type AgentRunInput,
  type LocalProcessAdapterConfig,
} from "@agent-tavern/agent-sdk";
import type {
  AgentBinding,
  AgentSession,
  AgentSessionKind,
  BridgeTask,
  Member,
  Message,
  MessageAttachment,
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
  citizens,
  privateAssistants,
  rooms,
} from "../db/schema";
import { resolveBindingForMember } from "../lib/agent-binding-resolution";
import { expireStalePendingBridgeTasks } from "../lib/bridge-task-maintenance";
import { createId } from "../lib/id";
import { insertMessage } from "../lib/message-records";
import { getRoomSummary, normalizeRoomSummaryOutput } from "../lib/room-summary";
import { isVisibleRoomMember } from "../lib/member-visibility";
import {
  MAX_MESSAGE_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  createDraftAttachmentFromBuffer,
  deleteDraftAttachment,
} from "../lib/message-attachments";
import {
  createAgentBusySystemData,
  createBridgeAttachRequiredSystemData,
  createBridgeWaitingSystemData,
  createStructuredSystemMessage,
} from "../lib/system-messages";
import { toDomainMessage } from "../lib/message-records";
import { toPublicMessage } from "../lib/public";
import { broadcastToRoom } from "../realtime";
import {
  completeSessionAction,
  createReasoningDeltaEvent,
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
    const outputFormat =
      parsed.outputFormat === "jsonl" || parsed.outputFormat === "text"
        ? parsed.outputFormat
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
      outputFormat,
      maxRuntimeMs,
      gracefulShutdownMs,
    };
  } catch {
    return null;
  }
}

function toAgentBinding(row: {
  id: string;
  citizenId: string | null;
  privateAssistantId: string | null;
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
  secretaryMemberId: string | null;
  secretaryMode: string;
  createdAt: string;
}): Room {
  return row as Room;
}

function toMember(row: {
  id: string;
  roomId: string;
  citizenId: string | null;
  type: string;
  roleKind: string;
  displayName: string;
  ownerMemberId: string | null;
  sourcePrivateAssistantId: string | null;
  adapterType: string | null;
  adapterConfig: string | null;
  presenceStatus: string;
  createdAt: string;
}): Member {
  return row as Member;
}

function toAgentSession(row: {
  id: string;
  roomId: string;
  agentMemberId: string;
  kind: string;
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

function resolveBridgeBackendConfig(agent: Member, binding: AgentBinding): string | null {
  if (binding.backendType !== "openai_compatible") {
    return null;
  }

  if (agent.sourcePrivateAssistantId) {
    const assistant = db
      .select({ backendConfig: privateAssistants.backendConfig })
      .from(privateAssistants)
      .where(eq(privateAssistants.id, agent.sourcePrivateAssistantId))
      .get();
    return assistant?.backendConfig ?? null;
  }

  if (agent.citizenId) {
    const principal = db
      .select({ backendConfig: citizens.backendConfig })
      .from(citizens)
      .where(eq(citizens.id, agent.citizenId))
      .get();
    return principal?.backendConfig ?? null;
  }

  return null;
}

function buildPrompt(input: {
  room: Room;
  agent: Member;
  requester: Member;
  triggerMessage: Message;
  sessionKind: AgentSessionKind;
  contextMessages: AgentRunInput["contextMessages"];
}): string {
  const allRoomMembers = db
    .select()
    .from(members)
    .where(eq(members.roomId, input.room.id))
    .all();
  const assistantIds = [
    ...new Set(
      allRoomMembers
        .map((member) => member.sourcePrivateAssistantId)
        .filter(Boolean),
    ),
  ] as string[];
  const assistantStatusById = new Map(
    (assistantIds.length
      ? db
          .select({ id: privateAssistants.id, status: privateAssistants.status })
          .from(privateAssistants)
          .where(inArray(privateAssistants.id, assistantIds))
          .all()
      : []
    ).map((assistant) => [assistant.id, assistant.status]),
  );
  const roomMembers = allRoomMembers.filter((member) =>
    isVisibleRoomMember({
      ...member,
      assistantStatus: member.sourcePrivateAssistantId
        ? assistantStatusById.get(member.sourcePrivateAssistantId) ?? null
        : null,
    }),
  );
  const context = input.contextMessages
    .map((message) => `[${message.createdAt}] ${message.senderName}: ${message.content}`)
    .join("\n");
  const memberRoster = roomMembers
    .map((member) => {
      const typeLabel =
        member.type === "agent"
          ? member.roleKind === "assistant"
            ? "assistant agent"
            : member.id === input.room.secretaryMemberId
              ? "secretary agent"
              : "independent agent"
          : "human";
      const availabilityLabel =
        member.type === "agent" && member.presenceStatus === "offline"
          ? ", offline"
          : "";
      return `- ${member.displayName} (${typeLabel}${availabilityLabel})`;
    })
    .join("\n");
  const isSecretary = input.room.secretaryMemberId === input.agent.id && input.room.secretaryMode !== "off";
  const currentSummary = getRoomSummary(input.room.id)?.summaryText ?? null;

  return [
    isSecretary
      ? `You are ${input.agent.displayName}, the secretary agent in the room "${input.room.name}".`
      : `You are ${input.agent.displayName}, a member in the room "${input.room.name}".`,
    `Requester: ${input.requester.displayName}.`,
    input.sessionKind === "room_observe"
      ? "Observe the room, decide whether to respond, and only speak when coordination is genuinely helpful."
      : input.sessionKind === "summary_refresh"
        ? "Refresh the room summary artifact and only add a visible chat reply if it is genuinely useful."
        : "Reply as a chat participant in plain text.",
    isSecretary
      ? [
          "Secretary policy:",
          "- Stay silent if the room is already progressing normally.",
          "- Prefer short coordination messages over long answers.",
          "- If another member or agent should act, mention them directly with @Name.",
          "- Do not answer on behalf of a specialist agent when a short handoff is better.",
          "- If no response is necessary, return an empty result.",
        ].join("\n")
      : "You may mention other room members with @Name when collaboration needs it.",
    input.room.secretaryMode === "coordinate_and_summarize" && isSecretary
      ? [
          "Summary artifact policy:",
          "- If the room state changed materially, append a hidden summary block.",
          "- Use exactly this format:",
          "[[ROOM_SUMMARY]]",
          "One concise room summary for future context.",
          "[[/ROOM_SUMMARY]]",
          "- The visible chat message must stay outside that block.",
          "- If only the summary needs updating, you may return just the summary block.",
          "Current saved summary:",
          currentSummary ?? "(none)",
        ].join("\n")
      : null,
    "Active room members:",
    memberRoster || "(unknown members)",
    currentSummary
      ? [
          "Current room summary artifact:",
          currentSummary,
        ].join("\n")
      : null,
    "Recent room context:",
    context || "(no context)",
    "Current trigger message:",
    `${input.requester.displayName}: ${input.triggerMessage.content}`,
  ].join("\n");
}

function isSecretarySession(room: Room, session: AgentSession): boolean {
  return room.secretaryMemberId === session.agentMemberId && room.secretaryMode !== "off";
}

function allowsSilentCompletion(session: AgentSession): boolean {
  return session.kind === "room_observe" || session.kind === "summary_refresh";
}

function createGeneratedAttachments(params: {
  roomId: string;
  uploaderMemberId: string;
  attachments: NonNullable<AgentMessageAction["attachments"]>;
  createdAt: string;
}): MessageAttachment[] {
  if (params.attachments.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`up to ${MAX_MESSAGE_ATTACHMENTS} attachments are allowed`);
  }

  const created: MessageAttachment[] = [];
  let totalBytes = 0;

  try {
    for (const attachment of params.attachments) {
      const content = Buffer.from(attachment.contentBase64, "base64");
      if (content.byteLength === 0) {
        throw new Error("attachment content must not be empty");
      }

      totalBytes += content.byteLength;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        throw new Error(`attachments exceed ${MAX_TOTAL_ATTACHMENT_BYTES} bytes in total`);
      }

      created.push(
        createDraftAttachmentFromBuffer({
          roomId: params.roomId,
          uploaderMemberId: params.uploaderMemberId,
          fileName: attachment.name,
          mimeType: attachment.mimeType,
          content,
          createdAt: params.createdAt,
        }),
      );
    }
  } catch (error) {
    for (const attachment of created) {
      deleteDraftAttachment({
        roomId: params.roomId,
        uploaderMemberId: params.uploaderMemberId,
        attachmentId: attachment.id,
      });
    }
    throw error;
  }

  return created;
}

function enqueueBridgeTask(params: {
  session: AgentSession;
  binding: AgentBinding;
  prompt: string;
  contextPayload: string;
  outputMessageId: string;
  backendConfig: string | null;
}): BridgeTask {
  const task: BridgeTask = {
    id: createId("btsk"),
    bridgeId: params.binding.bridgeId as string,
    sessionId: params.session.id,
    roomId: params.session.roomId,
    agentMemberId: params.session.agentMemberId,
    requesterMemberId: params.session.requesterMemberId,
    kind: params.session.kind,
    backendType: params.binding.backendType,
    backendThreadId: params.binding.backendThreadId,
    backendConfig: params.backendConfig,
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
  const content = `${params.agentDisplayName} is waiting for its local bridge to reconnect.`;
  return createStructuredSystemMessage({
    roomId: params.roomId,
    senderMemberId: params.agentMemberId,
    messageType: "system_notice",
    systemData: createBridgeWaitingSystemData(params.agentDisplayName),
    replyToMessageId: params.triggerMessageId,
    createdAt: now(),
  });
}

async function runAgentSession(sessionId: string): Promise<void> {
  expireStalePendingBridgeTasks();

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
  const typedTriggerMessage = toDomainMessage(triggerMessage);

  if (typedAgent.sourcePrivateAssistantId) {
    const competingSessions = db
      .select()
      .from(agentSessions)
      .where(
        and(
          ne(agentSessions.id, session.id),
          ne(agentSessions.roomId, session.roomId),
          or(
            eq(agentSessions.status, "pending"),
            eq(agentSessions.status, "waiting_approval"),
            eq(agentSessions.status, "running"),
          ),
        ),
      )
      .all();

    if (competingSessions.length > 0) {
      const competingMembers = db
        .select()
        .from(members)
        .where(inArray(members.id, competingSessions.map((item) => item.agentMemberId)))
        .all();

      const hasSameAssistantRunning = competingMembers.some(
        (member) => member.sourcePrivateAssistantId === typedAgent.sourcePrivateAssistantId,
      );

      if (hasSameAssistantRunning) {
        failSession(
          typedSession,
          createAgentBusySystemData(typedAgent.displayName, typedAgent.id),
        );
        return;
      }
    }
  }

  const bindingRow = resolveBindingForMember(typedAgent);
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
      sessionKind: typedSession.kind,
      contextMessages,
    }),
    contextMessages,
  };

  if (typedBinding?.backendType && typedBinding.backendType !== "local_process") {
    if (!typedBinding.bridgeId || typedBinding.status !== "active") {
      failSession(
        typedSession,
        createBridgeAttachRequiredSystemData(typedAgent.displayName, typedAgent.id),
      );
      return;
    }

    const backendConfig = resolveBridgeBackendConfig(typedAgent, typedBinding);
    if (typedBinding.backendType === "openai_compatible" && !backendConfig) {
      failSession(
        typedSession,
        `${typedAgent.displayName} does not have a valid openai-compatible backend configuration.`,
      );
      return;
    }

    enqueueBridgeTask({
      session: typedSession,
      binding: typedBinding,
      prompt: input.prompt,
      contextPayload: JSON.stringify(input.contextMessages),
      outputMessageId,
      backendConfig,
    });

    if (!isBridgeAvailable(typedBinding.bridgeId)) {
      const waitingMessage = createBridgePendingMessage({
        roomId: typedSession.roomId,
        agentMemberId: typedAgent.id,
        agentDisplayName: typedAgent.displayName,
        triggerMessageId: typedTriggerMessage.id,
      });

      insertMessage(waitingMessage);
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
  let reasoningText = "";
  let completedAction: AgentMessageAction | null = null;
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

      if (event.type === "reasoning") {
        reasoningText += event.text;
        broadcastToRoom(
          session.roomId,
          createReasoningDeltaEvent(session.roomId, session.id, outputMessageId, event.text),
        );
        continue;
      }

      if (event.type === "failed") {
        failedError = event.error;
        break;
      }

      if (event.type === "completed") {
        if (event.reasoningText && !reasoningText) {
          reasoningText = event.reasoningText;
          broadcastToRoom(
            session.roomId,
            createReasoningDeltaEvent(session.roomId, session.id, outputMessageId, event.reasoningText),
          );
        }
        completedAction = completedEventToAction({
          event,
          streamedText: finalText,
        });
      }
    }
  } catch (error) {
    failedError = error instanceof Error ? error.message : "Agent execution failed.";
  }

  if (failedError) {
    failSession(runningSession, failedError);
    return;
  }

  const parsedSummary = isSecretarySession(typedRoom, runningSession) &&
      typedRoom.secretaryMode === "coordinate_and_summarize"
    ? normalizeRoomSummaryOutput({
        visibleContent: completedAction?.content ?? finalText,
        summaryText: completedAction?.summaryText ?? null,
      })
    : { visibleContent: (completedAction?.content ?? finalText).trim(), summaryText: null };
  const committedText = parsedSummary.visibleContent.trim();
  const canCompleteSilently = allowsSilentCompletion(runningSession);
  const generatedAttachments = Array.isArray(completedAction?.attachments)
    ? createGeneratedAttachments({
        roomId: typedSession.roomId,
        uploaderMemberId: typedAgent.id,
        attachments: completedAction.attachments,
        createdAt: now(),
      })
    : [];

  if (!committedText && generatedAttachments.length === 0 && !canCompleteSilently) {
    failSession(runningSession, `${typedAgent.displayName} returned an empty response.`);
    return;
  }

  const committed = completeSessionAction({
    session: runningSession,
    action: {
      content: committedText,
      summaryText: parsedSummary.summaryText ?? undefined,
      mentionedDisplayNames: completedAction?.mentionedDisplayNames,
      attachments: generatedAttachments,
    },
    ...(committedText || generatedAttachments.length > 0
      ? {
          messageId: outputMessageId,
          replyToMessageId: typedTriggerMessage.id,
        }
      : {}),
  });
  for (const queuedSessionId of committed.queuedSessionIds) {
    queueAgentSession(queuedSessionId);
  }
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
