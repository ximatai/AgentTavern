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
