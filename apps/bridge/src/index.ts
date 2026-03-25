import os from "node:os";
import path from "node:path";

import { createDriverRegistry } from "./drivers";
import {
  type BridgeRegistration,
  type PostJson,
  pollAndProcessTask,
} from "./task-processor";
import { persistBridgeIdentity, readStoredBridgeIdentity } from "./state";

const serverBaseUrl = process.env.AGENT_TAVERN_SERVER_URL ?? "http://127.0.0.1:8787";
const bridgeName = process.env.AGENT_TAVERN_BRIDGE_NAME ?? "Local Bridge";
const heartbeatMs = Number(process.env.AGENT_TAVERN_BRIDGE_HEARTBEAT_MS ?? 10_000);
const pollMs = Number(process.env.AGENT_TAVERN_BRIDGE_POLL_MS ?? 3_000);
const enableTaskLoop = process.env.AGENT_TAVERN_BRIDGE_ENABLE_TASKS === "true";
const bridgeStatePath =
  process.env.AGENT_TAVERN_BRIDGE_STATE_PATH ??
  path.join(os.homedir(), ".agent-tavern", "bridge-state.json");
const drivers = createDriverRegistry();

const persistedIdentity = readStoredBridgeIdentity({
  bridgeStatePath,
  configuredBridgeId: process.env.AGENT_TAVERN_BRIDGE_ID,
  configuredBridgeToken: process.env.AGENT_TAVERN_BRIDGE_TOKEN,
  logger: console,
});
let bridgeId = persistedIdentity?.bridgeId ?? "";
let bridgeToken = persistedIdentity?.bridgeToken ?? "";
let taskLoopInFlight = false;

const postJson: PostJson = async <T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> => {
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
};

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
  persistBridgeIdentity(bridgeStatePath, { bridgeId, bridgeToken });

  console.log(`[bridge] registered id=${bridgeId} status=${result.status}`);
  console.log(`[bridge] persisted identity at ${bridgeStatePath}`);
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
  if (!enableTaskLoop || !bridgeId || !bridgeToken || taskLoopInFlight) {
    return;
  }

  taskLoopInFlight = true;

  try {
    await pollAndProcessTask({
      enabled: enableTaskLoop,
      bridgeId,
      bridgeToken,
      postJson,
      drivers,
      logger: console,
    });
  } catch (error) {
    throw error;
  } finally {
    taskLoopInFlight = false;
  }
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
