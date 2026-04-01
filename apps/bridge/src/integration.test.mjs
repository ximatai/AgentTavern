import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { pollAndProcessTask } from "./task-processor.ts";

function uniqueTempDbPath() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const tempRoot = path.resolve(currentDir, "../.tmp-tests");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "agent-tavern-bridge-"));
  return path.join(tempDir, "agent-tavern.db");
}

test("pollAndProcessTask completes a server-created bridge task through the real API", async () => {
  process.env.AGENT_TAVERN_DB_PATH = uniqueTempDbPath();

  const [{ runMigrations }, appModule, dbClient, schema, ids, realtime] = await Promise.all([
    import("../../server/src/db/migrate.js"),
    import("../../server/src/app.js"),
    import("../../server/src/db/client.js"),
    import("../../server/src/db/schema.js"),
    import("../../server/src/lib/id.js"),
    import("../../server/src/realtime.js"),
  ]);

  runMigrations();

  const { app } = appModule;
  const { db } = dbClient;
  const { citizens, rooms, members, agentBindings, localBridges, agentSessions, messages } = schema;
  const { createInviteToken } = ids;
  const { issueWsToken } = realtime;

  const createdAt = new Date("2026-03-25T09:00:00.000Z").toISOString();
  const roomId = "room_bridge_e2e";

  db.insert(rooms).values({
    id: roomId,
    name: "Bridge E2E Room",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt,
  }).run();

  db.insert(localBridges).values({
    id: "brg_bridge_e2e",
    bridgeName: "Bridge E2E",
    bridgeToken: "bridge_e2e_token",
    currentInstanceId: "binst_bridge_e2e",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_agent_bridge_e2e",
    kind: "agent",
    loginKey: "agent:bridge-e2e",
    globalDisplayName: "BridgeCodexE2E",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_e2e",
    status: "offline",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_requester_bridge_e2e",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterBridgeE2E",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_agent_bridge_e2e",
      roomId,
      citizenId: "prn_agent_bridge_e2e",
      type: "agent",
      roleKind: "independent",
      displayName: "BridgeCodexE2E",
      ownerMemberId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();

  db.insert(agentBindings).values({
    id: "agb_bridge_e2e",
    citizenId: "prn_agent_bridge_e2e",
    privateAssistantId: null,
    bridgeId: "brg_bridge_e2e",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_e2e",
    cwd: "/tmp/bridge-e2e",
    status: "active",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_requester_bridge_e2e", roomId);
  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_bridge_e2e",
      wsToken: requesterToken,
      content: "@BridgeCodexE2E please help",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const postJson = async (requestPath, body) => {
    const response = await app.request(`http://localhost${requestPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error ?? `request failed: ${response.status}`);
    }

    return data;
  };

  const drivers = new Map([
    [
      "codex_cli",
      {
        backendType: "codex_cli",
        async *run() {
          yield { type: "delta", text: "bridge " };
          yield { type: "completed", finalText: "bridge e2e output" };
        },
      },
    ],
  ]);

  const didWork = await pollAndProcessTask({
    enabled: true,
    bridgeId: "brg_bridge_e2e",
    bridgeToken: "bridge_e2e_token",
    bridgeInstanceId: "binst_bridge_e2e",
    postJson,
    drivers,
  });

  assert.equal(didWork, true);

  const session = db.select().from(agentSessions).all().find((row) => row.roomId === roomId);
  const roomMessages = db.select().from(messages).all().filter((row) => row.roomId === roomId);

  assert.equal(session?.status, "completed");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "agent_text" &&
        message.content === "bridge e2e output",
    ),
  );
});
