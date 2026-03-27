import type { AgentBackendType } from "@agent-tavern/shared";
import {
  createClaudeCodeAdapter,
  createCodexCliAdapter,
  type AgentRunInput,
  type AgentStreamEvent,
} from "@agent-tavern/agent-sdk";

export type BridgeTask = {
  id: string;
  sessionId: string;
  roomId: string;
  agentMemberId: string;
  requesterMemberId: string;
  backendType: AgentBackendType;
  backendThreadId: string;
  cwd: string | null;
  outputMessageId: string;
  prompt: string;
  contextPayload: string | null;
  status: string;
  createdAt: string;
  assignedAt: string | null;
  assignedInstanceId?: string | null;
  acceptedAt?: string | null;
  acceptedInstanceId?: string | null;
};

export interface BridgeDriver {
  readonly backendType: AgentBackendType;
  run(task: BridgeTask): AsyncIterable<AgentStreamEvent>;
}

function parseContextPayload(
  raw: string | null,
): AgentRunInput["contextMessages"] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const senderName = "senderName" in item && typeof item.senderName === "string"
        ? item.senderName
        : "unknown";
      const content = "content" in item && typeof item.content === "string"
        ? item.content
        : "";
      const createdAt = "createdAt" in item && typeof item.createdAt === "string"
        ? item.createdAt
        : new Date().toISOString();

      return [{ senderName, content, createdAt }];
    });
  } catch {
    return [];
  }
}

function createCodexBridgeDriver(): BridgeDriver {
  return {
    backendType: "codex_cli",
    run(task: BridgeTask) {
      const adapter = createCodexCliAdapter({
        threadId: task.backendThreadId,
        cwd: task.cwd ?? undefined,
      });

      return adapter.run({
        roomId: task.roomId,
        agentMemberId: task.agentMemberId,
        agentDisplayName: task.agentMemberId,
        requesterMemberId: task.requesterMemberId,
        requesterDisplayName: task.requesterMemberId,
        triggerMessageId: task.sessionId,
        prompt: task.prompt,
        contextMessages: parseContextPayload(task.contextPayload),
      });
    },
  };
}

function createClaudeCodeBridgeDriver(): BridgeDriver {
  return {
    backendType: "claude_code",
    run(task: BridgeTask) {
      const adapter = createClaudeCodeAdapter({
        sessionId: task.backendThreadId,
        cwd: task.cwd ?? undefined,
      });

      return adapter.run({
        roomId: task.roomId,
        agentMemberId: task.agentMemberId,
        agentDisplayName: task.agentMemberId,
        requesterMemberId: task.requesterMemberId,
        requesterDisplayName: task.requesterMemberId,
        triggerMessageId: task.sessionId,
        prompt: task.prompt,
        contextMessages: parseContextPayload(task.contextPayload),
      });
    },
  };
}

export function createDriverRegistry(): Map<AgentBackendType, BridgeDriver> {
  const drivers: BridgeDriver[] = [
    createCodexBridgeDriver(),
    createClaudeCodeBridgeDriver(),
  ];
  return new Map(drivers.map((driver) => [driver.backendType, driver]));
}
