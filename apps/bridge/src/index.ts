type BridgeRegistration = {
  bridgeId: string;
  bridgeToken: string;
  status: string;
  lastSeenAt: string;
};

type BridgeTaskEnvelope = {
  task: null | {
    id: string;
    sessionId: string;
    roomId: string;
    agentMemberId: string;
    requesterMemberId: string;
    backendType: string;
    backendThreadId: string;
    outputMessageId: string;
    prompt: string;
    contextPayload: string | null;
    status: string;
    createdAt: string;
    assignedAt: string | null;
  };
};

const serverBaseUrl = process.env.AGENT_TAVERN_SERVER_URL ?? "http://127.0.0.1:8787";
const bridgeName = process.env.AGENT_TAVERN_BRIDGE_NAME ?? "Local Bridge";
const heartbeatMs = Number(process.env.AGENT_TAVERN_BRIDGE_HEARTBEAT_MS ?? 10_000);
const pollMs = Number(process.env.AGENT_TAVERN_BRIDGE_POLL_MS ?? 3_000);
const enableTaskLoop = process.env.AGENT_TAVERN_BRIDGE_ENABLE_TASKS === "true";

let bridgeId = process.env.AGENT_TAVERN_BRIDGE_ID ?? "";
let bridgeToken = process.env.AGENT_TAVERN_BRIDGE_TOKEN ?? "";

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${serverBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as T & { error?: string };

  if (!response.ok) {
    throw new Error((data as { error?: string }).error ?? `request failed: ${response.status}`);
  }

  return data;
}

async function registerBridge(): Promise<void> {
  const result = await postJson<BridgeRegistration>("/api/bridges/register", {
    bridgeId: bridgeId || undefined,
    bridgeToken: bridgeToken || undefined,
    bridgeName,
    platform: process.platform,
    version: "0.1.0",
    metadata: {
      providers: [],
      hostname: process.env.HOSTNAME ?? null,
      taskLoopEnabled: enableTaskLoop,
    },
  });

  bridgeId = result.bridgeId;
  bridgeToken = result.bridgeToken;

  console.log(`[bridge] registered id=${bridgeId} status=${result.status}`);
  console.log(`[bridge] export AGENT_TAVERN_BRIDGE_ID=${bridgeId}`);
  console.log(`[bridge] export AGENT_TAVERN_BRIDGE_TOKEN=${bridgeToken}`);
}

async function sendHeartbeat(): Promise<void> {
  if (!bridgeId || !bridgeToken) {
    return;
  }

  await postJson(`/api/bridges/${bridgeId}/heartbeat`, {
    bridgeToken,
    metadata: {
      taskLoopEnabled: enableTaskLoop,
    },
  });
}

async function pollTasks(): Promise<void> {
  if (!enableTaskLoop || !bridgeId || !bridgeToken) {
    return;
  }

  const result = await postJson<BridgeTaskEnvelope>(`/api/bridges/${bridgeId}/tasks/pull`, {
    bridgeToken,
  });

  if (!result.task) {
    return;
  }

  console.log(
    `[bridge] pulled task=${result.task.id} backend=${result.task.backendType} session=${result.task.sessionId}`,
  );

  await postJson(`/api/bridges/${bridgeId}/tasks/${result.task.id}/accept`, {
    bridgeToken,
  });

  await postJson(`/api/bridges/${bridgeId}/tasks/${result.task.id}/fail`, {
    bridgeToken,
    error: "No provider drivers configured yet in local bridge skeleton.",
  });
}

async function main(): Promise<void> {
  await registerBridge();

  setInterval(() => {
    void sendHeartbeat().catch((error) => {
      console.error(`[bridge] heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, heartbeatMs);

  if (enableTaskLoop) {
    setInterval(() => {
      void pollTasks().catch((error) => {
        console.error(`[bridge] task poll failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, pollMs);
  }
}

void main().catch((error) => {
  console.error(`[bridge] startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
