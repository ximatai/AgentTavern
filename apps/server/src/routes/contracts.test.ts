import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";

function uniqueTempDbPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const tempRoot = path.resolve(currentDir, "../../.tmp-tests");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "agent-tavern-routes-"));
  return path.join(tempDir, "agent-tavern.db");
}

const databasePath = uniqueTempDbPath();
process.env.AGENT_TAVERN_DB_PATH = databasePath;

const [{ runMigrations }, appModule, dbClient, schema, ids, realtime] = await Promise.all([
  import("../db/migrate.js"),
  import("../app.js"),
  import("../db/client.js"),
  import("../db/schema.js"),
  import("../lib/id.js"),
  import("../realtime.js"),
]);

runMigrations();

const { app } = appModule;
const { db } = dbClient;
const {
  rooms,
  members,
  messages,
  mentions,
  approvals,
  agentSessions,
  agentBindings,
  assistantInvites,
  bridgeTasks,
  localBridges,
} = schema;
const { createInviteToken } = ids;
const { issueWsToken, registerSocket } = realtime;

function seedRoom(params: { roomId: string; inviteToken: string; name: string }): void {
  db.insert(rooms).values({
    id: params.roomId,
    name: params.name,
    inviteToken: params.inviteToken,
    status: "active",
    createdAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
  }).run();
}

function markMemberOnline(memberId: string, roomId: string, wsToken: string): () => void {
  const listeners = new Map<string, () => void>();
  const fakeSocket = {
    readyState: WebSocket.OPEN,
    close() {},
    send() {},
    on(event: string, handler: () => void) {
      listeners.set(event, handler);
      return this;
    },
  };

  registerSocket(fakeSocket as never, {
    url: `/?roomId=${roomId}&memberId=${memberId}&wsToken=${wsToken}`,
  } as never);

  return () => {
    listeners.get("close")?.();
  };
}

async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  timeoutMs = 1_000,
  intervalMs = 20,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = read();

    if (matches(value)) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return read();
}

test("joining the same room twice with the same nickname returns 409", async () => {
  const roomId = "room_join_conflict";
  seedRoom({
    roomId,
    name: "Join Conflict Room",
    inviteToken: createInviteToken(),
  });

  const firstResponse = await app.request(`http://localhost/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "Alice" }),
  });

  const secondResponse = await app.request(`http://localhost/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "Alice" }),
  });

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 409);
  assert.deepEqual(await secondResponse.json(), {
    error: "displayName already exists in room",
  });
});

test("mentioning an assistant while the owner is offline expires approval flow", async () => {
  const roomId = "room_owner_offline";
  const createdAt = new Date("2026-03-25T01:00:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Owner Offline Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "Requester",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_owner_offline",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "Owner",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
    {
      id: "mem_assistant",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistA",
      ownerMemberId: "mem_owner_offline",
      adapterType: "local_process",
      adapterConfig: "{\"command\":\"node\"}",
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const wsToken = issueWsToken("mem_requester", roomId);

  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester",
      wsToken,
      content: "@AssistA please help",
    }),
  });

  assert.equal(response.status, 201);

  const approval = db.select().from(approvals).where(eq(approvals.roomId, roomId)).get();
  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.roomId, roomId))
    .get();
  const mention = db.select().from(mentions).get();
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();

  assert.equal(approval?.status, "expired");
  assert.equal(session?.status, "rejected");
  assert.equal(mention?.status, "expired");
  assert.equal(roomMessages.length, 2);
  assert.equal(roomMessages.at(-1)?.messageType, "approval_result");
  assert.match(roomMessages.at(-1)?.content ?? "", /owner is offline/i);
});

test("approving an assistant request updates approval, session and mention state", async () => {
  const roomId = "room_approve_flow";
  const createdAt = new Date("2026-03-25T02:00:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Approve Flow Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_approve",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterApprove",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_owner_approve",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "OwnerApprove",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_assistant_approve",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistApprove",
      ownerMemberId: "mem_owner_approve",
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write('approved agent:' + text.trim()));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_approve", roomId);
  const ownerToken = issueWsToken("mem_owner_approve", roomId);
  const closeOwnerSocket = markMemberOnline("mem_owner_approve", roomId, ownerToken);

  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_approve",
      wsToken: requesterToken,
      content: "@AssistApprove please help",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pendingApproval = db
    .select()
    .from(approvals)
    .where(eq(approvals.roomId, roomId))
    .get();

  assert.equal(pendingApproval?.status, "pending");

  const approveResponse = await app.request(
    `http://localhost/api/approvals/${pendingApproval?.id}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorMemberId: "mem_owner_approve",
        wsToken: ownerToken,
      }),
    },
  );

  assert.equal(approveResponse.status, 200);

  const approval = db.select().from(approvals).where(eq(approvals.roomId, roomId)).get();
  const session = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .get(),
    (value) => value?.status === "completed",
  );
  const mention = db.select().from(mentions).where(eq(mentions.targetMemberId, "mem_assistant_approve")).get();
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();

  assert.equal(approval?.status, "approved");
  assert.equal(session?.status, "completed");
  assert.equal(mention?.status, "approved");
  assert.ok(roomMessages.some((message) => message.messageType === "approval_result"));
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "agent_text" &&
        /approved agent:/i.test(message.content),
    ),
  );

  closeOwnerSocket();
});

test("rejecting an assistant request keeps the session rejected and mention rejected", async () => {
  const roomId = "room_reject_flow";
  const createdAt = new Date("2026-03-25T03:00:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Reject Flow Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_reject",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterReject",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_owner_reject",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "OwnerReject",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_assistant_reject",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistReject",
      ownerMemberId: "mem_owner_reject",
      adapterType: "local_process",
      adapterConfig: "{\"command\":\"node\"}",
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_reject", roomId);
  const ownerToken = issueWsToken("mem_owner_reject", roomId);
  const closeOwnerSocket = markMemberOnline("mem_owner_reject", roomId, ownerToken);

  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_reject",
      wsToken: requesterToken,
      content: "@AssistReject please help",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pendingApproval = db
    .select()
    .from(approvals)
    .where(eq(approvals.roomId, roomId))
    .get();

  assert.equal(pendingApproval?.status, "pending");

  const rejectResponse = await app.request(
    `http://localhost/api/approvals/${pendingApproval?.id}/reject`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorMemberId: "mem_owner_reject",
        wsToken: ownerToken,
      }),
    },
  );

  assert.equal(rejectResponse.status, 200);

  const approval = db.select().from(approvals).where(eq(approvals.roomId, roomId)).get();
  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.roomId, roomId))
    .get();
  const mention = db.select().from(mentions).where(eq(mentions.targetMemberId, "mem_assistant_reject")).get();
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();

  assert.equal(approval?.status, "rejected");
  assert.equal(session?.status, "rejected");
  assert.equal(mention?.status, "rejected");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "approval_result" &&
        /rejected/i.test(message.content),
    ),
  );

  closeOwnerSocket();
});

test("owner mentioning their own assistant bypasses approval", async () => {
  const roomId = "room_owner_bypass";
  const createdAt = new Date("2026-03-25T03:30:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Owner Bypass Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_owner_bypass",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "OwnerBypass",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_assistant_bypass",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistBypass",
      ownerMemberId: "mem_owner_bypass",
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write('owner bypass:' + text.trim()));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const ownerToken = issueWsToken("mem_owner_bypass", roomId);

  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_owner_bypass",
      wsToken: ownerToken,
      content: "@AssistBypass please help",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const approval = db.select().from(approvals).where(eq(approvals.roomId, roomId)).get();
  const session = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .get(),
    (value) => value?.status === "completed",
  );
  const mention = db
    .select()
    .from(mentions)
    .where(eq(mentions.targetMemberId, "mem_assistant_bypass"))
    .get();
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();

  assert.equal(approval, undefined);
  assert.equal(session?.approvalRequired, false);
  assert.equal(session?.status, "completed");
  assert.equal(mention?.status, "triggered");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "agent_text" &&
        /owner bypass:/i.test(message.content),
    ),
  );
  assert.ok(!roomMessages.some((message) => message.messageType === "approval_request"));
});

test("mentioning an independent agent triggers execution and commits a reply", async () => {
  const roomId = "room_independent_agent";
  const createdAt = new Date("2026-03-25T04:00:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Independent Agent Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_independent",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterIndependent",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_agent_independent",
      roomId,
      type: "agent",
      roleKind: "independent",
      displayName: "SoloAgent",
      ownerMemberId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write('independent agent:' + text.trim()));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_independent", roomId);

  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_independent",
      wsToken: requesterToken,
      content: "@SoloAgent please help",
    }),
  });

  assert.equal(response.status, 201);

  const session = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .get(),
    (value) => value?.status === "completed",
  );
  const mention = db.select().from(mentions).where(eq(mentions.targetMemberId, "mem_agent_independent")).get();
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();

  assert.equal(session?.status, "completed");
  assert.equal(mention?.status, "triggered");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "agent_text" &&
        /independent agent:/i.test(message.content),
    ),
  );
});

test("bridge register creates a reusable bridge identity and heartbeat refreshes it", async () => {
  const registerResponse = await app.request("http://localhost/api/bridges/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeName: "Alice Laptop",
      platform: "macOS",
      version: "0.1.0",
      metadata: { providers: ["codex"] },
    }),
  });

  assert.equal(registerResponse.status, 201);
  const registered = await registerResponse.json();
  assert.equal(typeof registered.bridgeId, "string");
  assert.equal(typeof registered.bridgeToken, "string");

  const storedBridge = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, registered.bridgeId))
    .get();

  assert.equal(storedBridge?.bridgeName, "Alice Laptop");
  assert.equal(storedBridge?.status, "online");

  const reconnectResponse = await app.request("http://localhost/api/bridges/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeId: registered.bridgeId,
      bridgeToken: registered.bridgeToken,
      bridgeName: "Alice Laptop",
      platform: "macOS",
      version: "0.1.1",
      metadata: { providers: ["codex", "local_process"] },
    }),
  });

  assert.equal(reconnectResponse.status, 200);
  const reconnected = await reconnectResponse.json();
  assert.equal(reconnected.bridgeId, registered.bridgeId);
  assert.equal(reconnected.bridgeToken, registered.bridgeToken);

  const heartbeatResponse = await app.request(
    `http://localhost/api/bridges/${registered.bridgeId}/heartbeat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: registered.bridgeToken,
        metadata: { activeAgents: 2 },
      }),
    },
  );

  assert.equal(heartbeatResponse.status, 200);

  const refreshedBridge = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, registered.bridgeId))
    .get();

  assert.equal(refreshedBridge?.version, "0.1.1");
  assert.equal(refreshedBridge?.status, "online");
  assert.match(refreshedBridge?.metadata ?? "", /activeAgents/);

  const preserveHeartbeatResponse = await app.request(
    `http://localhost/api/bridges/${registered.bridgeId}/heartbeat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: registered.bridgeToken,
      }),
    },
  );

  assert.equal(preserveHeartbeatResponse.status, 200);

  const preservedBridge = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, registered.bridgeId))
    .get();

  assert.match(preservedBridge?.metadata ?? "", /activeAgents/);

  const preserveRegisterResponse = await app.request("http://localhost/api/bridges/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeId: registered.bridgeId,
      bridgeToken: registered.bridgeToken,
      bridgeName: "Alice Laptop",
      platform: "macOS",
      version: "0.1.2",
    }),
  });

  assert.equal(preserveRegisterResponse.status, 200);

  const preservedAfterRegister = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, registered.bridgeId))
    .get();

  assert.equal(preservedAfterRegister?.version, "0.1.2");
  assert.match(preservedAfterRegister?.metadata ?? "", /activeAgents/);
});

test("bridge can attach an existing agent binding by backendThreadId", async () => {
  const originalAttachedAt = new Date("2026-03-25T05:00:00.000Z").toISOString();

  db.insert(localBridges).values({
    id: "brg_attach",
    bridgeName: "Attach Bridge",
    bridgeToken: "bridge_attach_token",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: originalAttachedAt,
    createdAt: originalAttachedAt,
    updatedAt: originalAttachedAt,
  }).run();

  db.insert(rooms).values({
    id: "room_attach_binding",
    name: "Attach Binding Room",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt: originalAttachedAt,
  }).run();

  db.insert(members).values({
    id: "mem_attach_agent",
    roomId: "room_attach_binding",
    type: "agent",
    roleKind: "assistant",
    displayName: "AttachAgent",
    ownerMemberId: null,
    adapterType: "codex_cli",
    adapterConfig: null,
    presenceStatus: "offline",
    createdAt: originalAttachedAt,
  }).run();

  db.insert(agentBindings).values({
    id: "agb_attach",
    memberId: "mem_attach_agent",
    bridgeId: null,
    backendType: "codex_cli",
    backendThreadId: "thread_attach",
    cwd: null,
    status: "pending_bridge",
    attachedAt: originalAttachedAt,
    detachedAt: null,
  }).run();

  const response = await app.request("http://localhost/api/bridges/brg_attach/agents/attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_attach_token",
      backendThreadId: "thread_attach",
      cwd: "/tmp/bridge-cwd",
    }),
  });

  assert.equal(response.status, 200);

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.id, "agb_attach"))
    .get();

  assert.equal(binding?.bridgeId, "brg_attach");
  assert.equal(binding?.cwd, "/tmp/bridge-cwd");
  assert.equal(binding?.status, "active");
  assert.notEqual(binding?.attachedAt, originalAttachedAt);
});

test("bridge attach returns 409 when the binding is already owned by another bridge", async () => {
  const createdAt = new Date("2026-03-25T05:30:00.000Z").toISOString();

  db.insert(localBridges).values([
    {
      id: "brg_attach_owner_a",
      bridgeName: "Attach Owner A",
      bridgeToken: "bridge_attach_owner_a_token",
      status: "online",
      platform: "macOS",
      version: "0.1.0",
      metadata: null,
      lastSeenAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "brg_attach_owner_b",
      bridgeName: "Attach Owner B",
      bridgeToken: "bridge_attach_owner_b_token",
      status: "online",
      platform: "macOS",
      version: "0.1.0",
      metadata: null,
      lastSeenAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    },
  ]).run();

  db.insert(rooms).values({
    id: "room_attach_owner_conflict",
    name: "Attach Owner Conflict Room",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt,
  }).run();

  db.insert(members).values({
    id: "mem_attach_owner_conflict",
    roomId: "room_attach_owner_conflict",
    type: "agent",
    roleKind: "assistant",
    displayName: "AttachOwnerConflict",
    ownerMemberId: null,
    adapterType: "codex_cli",
    adapterConfig: null,
    presenceStatus: "offline",
    createdAt,
  }).run();

  db.insert(agentBindings).values({
    id: "agb_attach_owner_conflict",
    memberId: "mem_attach_owner_conflict",
    bridgeId: "brg_attach_owner_a",
    backendType: "codex_cli",
    backendThreadId: "thread_attach_owner_conflict",
    cwd: "/tmp/attach-owner-a",
    status: "active",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const response = await app.request(
    "http://localhost/api/bridges/brg_attach_owner_b/agents/attach",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_attach_owner_b_token",
        backendThreadId: "thread_attach_owner_conflict",
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "agent binding already attached to another bridge",
  });
});

test("accepted assistant invite can be attached to a bridge by memberId", async () => {
  const createdAt = new Date("2026-03-25T05:45:00.000Z").toISOString();

  db.insert(rooms).values({
    id: "room_invite_attach",
    name: "Invite Attach Room",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt,
  }).run();

  db.insert(members).values({
    id: "mem_owner_invite_attach",
    roomId: "room_invite_attach",
    type: "human",
    roleKind: "none",
    displayName: "OwnerInviteAttach",
    ownerMemberId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt,
  }).run();

  db.insert(assistantInvites).values({
    id: "ainv_attach",
    roomId: "room_invite_attach",
    ownerMemberId: "mem_owner_invite_attach",
    presetDisplayName: "ThreadAttach",
    backendType: "codex_cli",
    inviteToken: "invite_attach_token",
    status: "pending",
    acceptedMemberId: null,
    createdAt,
    expiresAt: null,
    acceptedAt: null,
  }).run();

  db.insert(localBridges).values({
    id: "brg_invite_attach",
    bridgeName: "Invite Attach Bridge",
    bridgeToken: "bridge_invite_attach_token",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  const acceptResponse = await app.request(
    "http://localhost/api/assistant-invites/invite_attach_token/accept",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backendThreadId: "thread_invite_attach",
      }),
    },
  );

  assert.equal(acceptResponse.status, 201);
  const accepted = await acceptResponse.json();

  const attachResponse = await app.request(
    "http://localhost/api/bridges/brg_invite_attach/agents/attach",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_invite_attach_token",
        memberId: accepted.memberId,
        cwd: "/tmp/invite-attach",
      }),
    },
  );

  assert.equal(attachResponse.status, 200);

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.memberId, accepted.memberId))
    .get();

  assert.equal(binding?.bridgeId, "brg_invite_attach");
  assert.equal(binding?.status, "active");
  assert.equal(binding?.cwd, "/tmp/invite-attach");
});

test("unattached codex binding fails with a local bridge requirement message", async () => {
  const roomId = "room_codex_requires_bridge";
  const createdAt = new Date("2026-03-25T06:00:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Codex Bridge Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_codex",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterCodex",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_codex_agent",
      roomId,
      type: "agent",
      roleKind: "independent",
      displayName: "CodexAgent",
      ownerMemberId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();

  db.insert(agentBindings).values({
    id: "agb_codex_pending_bridge",
    memberId: "mem_codex_agent",
    bridgeId: null,
    backendType: "codex_cli",
    backendThreadId: "thread_codex_pending_bridge",
    cwd: null,
    status: "pending_bridge",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_requester_codex", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_codex",
      wsToken: requesterToken,
      content: "@CodexAgent please help",
    }),
  });

  assert.equal(response.status, 201);

  const session = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .get(),
    (value) => value?.status === "failed",
  );
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();

  assert.equal(session?.status, "failed");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "system_notice" &&
        /local bridge/i.test(message.content),
    ),
  );
});

test("attached codex binding can be pulled and completed through bridge task endpoints", async () => {
  const roomId = "room_codex_bridge_task";
  const createdAt = new Date("2026-03-25T07:00:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Codex Bridge Task Room",
    inviteToken: createInviteToken(),
  });

  db.insert(localBridges).values({
    id: "brg_codex_task",
    bridgeName: "Codex Bridge",
    bridgeToken: "bridge_codex_task_token",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_requester_bridge_task",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterBridgeTask",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_codex_bridge_task",
      roomId,
      type: "agent",
      roleKind: "independent",
      displayName: "BridgeCodex",
      ownerMemberId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();

  db.insert(agentBindings).values({
    id: "agb_codex_bridge_task",
    memberId: "mem_codex_bridge_task",
    bridgeId: "brg_codex_task",
    backendType: "codex_cli",
    backendThreadId: "thread_codex_bridge_task",
    cwd: "/tmp/codex-bridge-task",
    status: "active",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_requester_bridge_task", roomId);
  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_bridge_task",
      wsToken: requesterToken,
      content: "@BridgeCodex please help",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pullResponse = await app.request("http://localhost/api/bridges/brg_codex_task/tasks/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_codex_task_token",
    }),
  });

  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();
  assert.equal(pulled.task.bridgeId, "brg_codex_task");
  assert.equal(pulled.task.backendThreadId, "thread_codex_bridge_task");
  assert.equal(pulled.task.cwd, "/tmp/codex-bridge-task");

  const acceptResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
      }),
    },
  );

  assert.equal(acceptResponse.status, 200);

  const duplicateAcceptResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
      }),
    },
  );

  assert.equal(duplicateAcceptResponse.status, 409);

  const deltaResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/delta`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
        delta: "partial output",
      }),
    },
  );

  assert.equal(deltaResponse.status, 200);

  const completeResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
        finalText: "final bridge output",
      }),
    },
  );

  assert.equal(completeResponse.status, 200);

  const duplicateCompleteResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
        finalText: "duplicate output",
      }),
    },
  );

  assert.equal(duplicateCompleteResponse.status, 409);

  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.roomId, roomId))
    .get();
  const task = db.select().from(bridgeTasks).where(eq(bridgeTasks.id, pulled.task.id)).get();
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();

  assert.equal(session?.status, "completed");
  assert.equal(task?.status, "completed");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "agent_text" &&
        message.content === "final bridge output",
    ),
  );
});

test("pull can reclaim an expired assigned bridge task lease", async () => {
  const createdAt = new Date("2026-03-25T08:00:00.000Z").toISOString();
  const expiredAssignedAt = new Date(Date.now() - 60_000).toISOString();

  db.insert(localBridges).values({
    id: "brg_reclaim_lease",
    bridgeName: "Reclaim Lease Bridge",
    bridgeToken: "bridge_reclaim_lease_token",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(rooms).values({
    id: "room_reclaim_lease",
    name: "Reclaim Lease Room",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_requester_reclaim_lease",
      roomId: "room_reclaim_lease",
      type: "human",
      roleKind: "none",
      displayName: "RequesterReclaimLease",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_agent_reclaim_lease",
      roomId: "room_reclaim_lease",
      type: "agent",
      roleKind: "independent",
      displayName: "AgentReclaimLease",
      ownerMemberId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();

  db.insert(messages).values({
    id: "msg_trigger_reclaim_lease",
    roomId: "room_reclaim_lease",
    senderMemberId: "mem_requester_reclaim_lease",
    messageType: "user_text",
    content: "@AgentReclaimLease help",
    replyToMessageId: null,
    createdAt,
  }).run();

  db.insert(agentSessions).values({
    id: "ags_reclaim_lease",
    roomId: "room_reclaim_lease",
    agentMemberId: "mem_agent_reclaim_lease",
    triggerMessageId: "msg_trigger_reclaim_lease",
    requesterMemberId: "mem_requester_reclaim_lease",
    approvalId: null,
    approvalRequired: false,
    status: "pending",
    startedAt: null,
    endedAt: null,
  }).run();

  db.insert(bridgeTasks).values({
    id: "btsk_reclaim_lease",
    bridgeId: "brg_reclaim_lease",
    sessionId: "ags_reclaim_lease",
    roomId: "room_reclaim_lease",
    agentMemberId: "mem_agent_reclaim_lease",
    requesterMemberId: "mem_requester_reclaim_lease",
    backendType: "codex_cli",
    backendThreadId: "thread_reclaim_lease",
    outputMessageId: "msg_output_reclaim_lease",
    prompt: "help",
    contextPayload: null,
    status: "assigned",
    createdAt,
    assignedAt: expiredAssignedAt,
    acceptedAt: null,
    completedAt: null,
    failedAt: null,
  }).run();

  const pullResponse = await app.request(
    "http://localhost/api/bridges/brg_reclaim_lease/tasks/pull",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_reclaim_lease_token",
      }),
    },
  );

  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();
  assert.equal(pulled.task?.id, "btsk_reclaim_lease");
  assert.equal(pulled.task?.status, "assigned");
  assert.notEqual(pulled.task?.assignedAt, expiredAssignedAt);
});
