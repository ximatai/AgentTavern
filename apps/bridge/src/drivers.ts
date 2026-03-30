import type { AgentBackendType, BridgeTaskKind } from "@agent-tavern/shared";
import {
  createClaudeCodeAdapter,
  createCodexCliAdapter,
  createOpenAICompatibleAdapter,
  createOpenCodeAdapter,
  type AgentRunInput,
  type AgentStreamEvent,
} from "@agent-tavern/agent-sdk";
import type { OpenAICompatibleBackendConfig } from "@agent-tavern/shared";

export type BridgeTask = {
  id: string;
  sessionId: string;
  roomId: string;
  agentMemberId: string;
  requesterMemberId: string;
  kind: BridgeTaskKind;
  backendType: AgentBackendType;
  backendThreadId: string;
  backendConfig: string | null;
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

function createOpenCodeBridgeDriver(): BridgeDriver {
  return {
    backendType: "opencode",
    run(task: BridgeTask) {
      const adapter = createOpenCodeAdapter({
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

function parseOpenAICompatibleConfig(raw: string | null): OpenAICompatibleBackendConfig | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.baseUrl !== "string" || typeof parsed.model !== "string") {
      return null;
    }

    const headers = parsed.headers && typeof parsed.headers === "object" && !Array.isArray(parsed.headers)
      ? Object.fromEntries(
          Object.entries(parsed.headers).flatMap(([key, value]) =>
            typeof value === "string" ? [[key, value]] : [],
          ),
        )
      : undefined;

    return {
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      ...(typeof parsed.apiKey === "string" ? { apiKey: parsed.apiKey } : {}),
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      ...(typeof parsed.temperature === "number" ? { temperature: parsed.temperature } : {}),
      ...(typeof parsed.maxTokens === "number" ? { maxTokens: parsed.maxTokens } : {}),
    };
  } catch {
    return null;
  }
}

function createOpenAICompatibleBridgeDriver(): BridgeDriver {
  return {
    backendType: "openai_compatible",
    async *run(task: BridgeTask) {
      const config = parseOpenAICompatibleConfig(task.backendConfig);
      if (!config) {
        yield {
          type: "failed",
          error: "openai_compatible backend is missing a valid backendConfig",
        };
        return;
      }

      const adapter = createOpenAICompatibleAdapter(config);

      yield* adapter.run({
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
    createOpenCodeBridgeDriver(),
    createOpenAICompatibleBridgeDriver(),
  ];
  return new Map(drivers.map((driver) => [driver.backendType, driver]));
}
