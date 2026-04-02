import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createDriverRegistry } from "./drivers";
import {
  type BridgeRegistration,
  type PostJson,
  pollAndProcessTask,
} from "./task-processor";
import { buildBridgeMetadata } from "./metadata";
import { persistBridgeIdentity, readStoredBridgeIdentity } from "./state";

const serverBaseUrl = process.env.AGENT_TAVERN_SERVER_URL ?? "http://127.0.0.1:8787";
const bridgeName = process.env.AGENT_TAVERN_BRIDGE_NAME ?? "Local Bridge";
const heartbeatMs = Number(process.env.AGENT_TAVERN_BRIDGE_HEARTBEAT_MS ?? 10_000);
const pollMs = Number(process.env.AGENT_TAVERN_BRIDGE_POLL_MS ?? 3_000);
const enableTaskLoop = process.env.AGENT_TAVERN_BRIDGE_ENABLE_TASKS !== "false";
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
const bridgeInstanceId = `binst_${randomUUID()}`;
let taskLoopInFlight = false;
const bridgeMetadata = buildBridgeMetadata({
  providers: [],
  hostname: process.env.HOSTNAME ?? null,
  taskLoopEnabled: enableTaskLoop,
});

class BridgeRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, options: { status: number; code?: string | null }) {
    super(message);
    this.name = "BridgeRequestError";
    this.status = options.status;
    this.code = options.code ?? null;
  }
}

function isStaleBridgeCredentialError(error: unknown): boolean {
  if (!(error instanceof BridgeRequestError)) {
    return false;
  }

  return error.code === "BRIDGE_NOT_FOUND" || error.code === "INVALID_BRIDGE_CREDENTIALS";
}

const postJson: PostJson = async <T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(`${serverBaseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };

  if (!response.ok) {
    throw new BridgeRequestError((data as { error?: string }).error ?? `request failed: ${response.status}`, {
      status: response.status,
      code: typeof data.code === "string" ? data.code : null,
    });
  }

  return data;
};

async function registerBridge(): Promise<void> {
  const registerBody = (): Record<string, unknown> => ({
    bridgeId: bridgeId || undefined,
    bridgeToken: bridgeToken || undefined,
    bridgeInstanceId,
    bridgeName,
    platform: process.platform,
    version: "0.1.0",
    metadata: bridgeMetadata,
  });

  let result: BridgeRegistration;

  try {
    result = await postJson<BridgeRegistration>("/api/bridges/register", registerBody());
  } catch (error) {
    if (!bridgeId || !bridgeToken || !isStaleBridgeCredentialError(error)) {
      throw error;
    }

    console.warn(
      `[bridge] stale credentials detected for id=${bridgeId}; registering a new bridge identity`,
    );
    bridgeId = "";
    bridgeToken = "";
    result = await postJson<BridgeRegistration>("/api/bridges/register", registerBody());
  }

  bridgeId = result.bridgeId;
  bridgeToken = result.bridgeToken;
  persistBridgeIdentity(bridgeStatePath, {
    bridgeId,
    bridgeToken,
    serverBaseUrl,
    bridgeName,
  });

  console.log(
    `[bridge] registered id=${bridgeId} instance=${bridgeInstanceId} status=${result.status}`,
  );
  console.log(`[bridge] persisted identity at ${bridgeStatePath}`);
}

async function sendHeartbeat(): Promise<void> {
  if (!bridgeId || !bridgeToken) {
    return;
  }

  await postJson(`/api/bridges/${bridgeId}/heartbeat`, {
    bridgeToken,
    bridgeInstanceId,
    metadata: bridgeMetadata,
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
      bridgeInstanceId,
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
