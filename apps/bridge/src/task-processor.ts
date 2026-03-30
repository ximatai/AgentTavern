import type { AgentBackendType } from "@agent-tavern/shared";
import type { AgentStreamEvent } from "@agent-tavern/agent-sdk";

import type { BridgeDriver, BridgeTask } from "./drivers";

export type BridgeRegistration = {
  bridgeId: string;
  bridgeToken: string;
  bridgeInstanceId: string;
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
  bridgeInstanceId: string;
  task: BridgeTask;
  postJson: PostJson;
  drivers: Map<AgentBackendType, BridgeDriver>;
}): Promise<void> {
  const { bridgeId, bridgeToken, bridgeInstanceId, task, postJson, drivers } = params;

  await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/accept`, {
    bridgeToken,
    bridgeInstanceId,
  });

  const driver = drivers.get(task.backendType);

  if (!driver) {
    await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/fail`, {
      bridgeToken,
      bridgeInstanceId,
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
          bridgeInstanceId,
          delta: event.text,
        });
        continue;
      }

      if (event.type === "completed") {
        const completedText =
          event.finalText !== undefined ? event.finalText : finalText || "(no output)";
        const attachmentIds: string[] = [];

        if (Array.isArray(event.attachments)) {
          for (const attachment of event.attachments) {
            const uploaded = await postJson<{ attachmentId: string }>(
              `/api/bridges/${bridgeId}/tasks/${task.id}/attachments`,
              {
                bridgeToken,
                bridgeInstanceId,
                name: attachment.name,
                mimeType: attachment.mimeType,
                contentBase64: attachment.contentBase64,
              },
            );
            attachmentIds.push(uploaded.attachmentId);
          }
        }

        const completeBody: Record<string, unknown> = {
          bridgeToken,
          bridgeInstanceId,
          finalText: completedText,
        };
        if (attachmentIds.length > 0) {
          completeBody.attachmentIds = attachmentIds;
        }
        if (event.summaryText) {
          completeBody.summaryText = event.summaryText;
        }
        if (Array.isArray(event.mentionedDisplayNames) && event.mentionedDisplayNames.length > 0) {
          completeBody.mentionedDisplayNames = event.mentionedDisplayNames;
        }

        if (event.sessionId) {
          completeBody.backendThreadId = event.sessionId;
        }

        await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/complete`, completeBody);
        return;
      }

      await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/fail`, {
        bridgeToken,
        bridgeInstanceId,
        error: event.error,
      });
      return;
    }

    await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/complete`, {
      bridgeToken,
      bridgeInstanceId,
      finalText: finalText || "(no output)",
    });
  } catch (error) {
    await postJson(`/api/bridges/${bridgeId}/tasks/${task.id}/fail`, {
      bridgeToken,
      bridgeInstanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function pollAndProcessTask(params: {
  enabled: boolean;
  bridgeId: string;
  bridgeToken: string;
  bridgeInstanceId: string;
  postJson: PostJson;
  drivers: Map<AgentBackendType, BridgeDriver>;
  logger?: Pick<Console, "log">;
}): Promise<boolean> {
  const { enabled, bridgeId, bridgeToken, bridgeInstanceId, postJson, drivers, logger } = params;

  if (!enabled || !bridgeId || !bridgeToken || !bridgeInstanceId) {
    return false;
  }

  const result = await postJson<BridgeTaskEnvelope>(`/api/bridges/${bridgeId}/tasks/pull`, {
    bridgeToken,
    bridgeInstanceId,
  });

  if (!result.task) {
    return false;
  }

  logger?.log(
    `[bridge] pulled task=${result.task.id} kind=${result.task.kind} backend=${result.task.backendType} session=${result.task.sessionId}`,
  );

  await processTask({
    bridgeId,
    bridgeToken,
    bridgeInstanceId,
    task: result.task,
    postJson,
    drivers,
  });

  return true;
}
