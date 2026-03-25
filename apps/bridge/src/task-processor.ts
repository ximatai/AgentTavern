import type { AgentBackendType } from "@agent-tavern/shared";
import type { AgentStreamEvent } from "@agent-tavern/agent-sdk";

import type { BridgeDriver, BridgeTask } from "./drivers";

export type BridgeRegistration = {
  bridgeId: string;
  bridgeToken: string;
  status: string;
  lastSeenAt: string;
};

export type BridgeTaskEnvelope = {
  task: BridgeTask | null;
};

export type PostJson = <T>(
  path: string,
  body: Record<string, unknown>,
) => Promise<T>;

export async function processTask(params: {
  bridgeId: string;
  bridgeToken: string;
  task: BridgeTask;
  postJson: PostJson;
  drivers: Map<AgentBackendType, BridgeDriver>;
}): Promise<void> {
  const { bridgeId, bridgeToken, task, postJson, drivers } = params;

  await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/accept`, {
    bridgeToken,
  });

  const driver = drivers.get(task.backendType);

  if (!driver) {
    await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/fail`, {
      bridgeToken,
      error: `No bridge driver configured for backend ${task.backendType}.`,
    });
    return;
  }

  let finalText = "";

  try {
    for await (const event of driver.run(task)) {
      if (event.type === "delta") {
        finalText += event.text;
        await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/delta`, {
          bridgeToken,
          delta: event.text,
        });
        continue;
      }

      if (event.type === "completed") {
        const completedText =
          event.finalText !== undefined ? event.finalText : finalText || "(no output)";

        await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/complete`, {
          bridgeToken,
          finalText: completedText,
        });
        return;
      }

      await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/fail`, {
        bridgeToken,
        error: event.error,
      });
      return;
    }

    await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/complete`, {
      bridgeToken,
      finalText: finalText || "(no output)",
    });
  } catch (error) {
    await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/fail`, {
      bridgeToken,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function pollAndProcessTask(params: {
  enabled: boolean;
  bridgeId: string;
  bridgeToken: string;
  postJson: PostJson;
  drivers: Map<AgentBackendType, BridgeDriver>;
  logger?: Pick<Console, "log">;
}): Promise<boolean> {
  const { enabled, bridgeId, bridgeToken, postJson, drivers, logger } = params;

  if (!enabled || !bridgeId || !bridgeToken) {
    return false;
  }

  const result = await postJson<BridgeTaskEnvelope>(`/api/bridges/${bridgeId}/tasks/pull`, {
    bridgeToken,
  });

  if (!result.task) {
    return false;
  }

  logger?.log(
    `[bridge] pulled task=${result.task.id} backend=${result.task.backendType} session=${result.task.sessionId}`,
  );

  await processTask({
    bridgeId,
    bridgeToken,
    task: result.task,
    postJson,
    drivers,
  });

  return true;
}
