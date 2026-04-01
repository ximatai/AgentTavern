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
    citizens,
    rooms,
    members,
    messages,
    roomSummaries,
    mentions,
  approvals,
  agentSessions,
  agentBindings,
  agentAuthorizations,
  bridgeTasks,
  localBridges,
  messageAttachments,
  privateAssistants,
  serverConfigs,
} = schema;
const { createInviteToken } = ids;
const { issueCitizenToken, issueWsToken, registerSocket } = realtime;

function seedRoom(params: {
  roomId: string;
  inviteToken: string;
  name: string;
  ownerMemberId?: string | null;
}): void {
  db.insert(rooms).values({
    id: params.roomId,
    name: params.name,
    inviteToken: params.inviteToken,
    status: "active",
    ownerMemberId: params.ownerMemberId ?? null,
    secretaryMemberId: null,
    secretaryMode: "off",
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

function markCitizenOnline(citizenId: string, citizenToken: string): () => void {
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
    url: `/?citizenId=${citizenId}&citizenToken=${citizenToken}`,
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

test("a human room member can configure an independent agent as secretary", async () => {
  const roomId = "room_secretary_config";
  const inviteToken = createInviteToken();
  seedRoom({
    roomId,
    name: "Secretary Config Room",
    inviteToken,
    ownerMemberId: "mem_human_secretary_actor",
  });

  db.insert(members).values([
    {
      id: "mem_human_secretary_actor",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Alice",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
    },
    {
      id: "mem_agent_secretary",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "independent",
      displayName: "scribe",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: "{\"command\":\"echo\"}",
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
    },
  ]).run();

  const wsToken = issueWsToken("mem_human_secretary_actor", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/secretary`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorMemberId: "mem_human_secretary_actor",
      wsToken,
      secretaryMemberId: "mem_agent_secretary",
      secretaryMode: "coordinate",
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: roomId,
    name: "Secretary Config Room",
    inviteToken,
    status: "active",
    ownerMemberId: "mem_human_secretary_actor",
    secretaryMemberId: "mem_agent_secretary",
    secretaryMode: "coordinate",
    createdAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
  });

  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();
  assert.equal(room?.secretaryMemberId, "mem_agent_secretary");
  assert.equal(room?.secretaryMode, "coordinate");
});

test("room secretary must be an active independent agent", async () => {
  const roomId = "room_secretary_invalid_target";
  seedRoom({
    roomId,
    name: "Secretary Invalid Room",
    inviteToken: createInviteToken(),
    ownerMemberId: "mem_human_secretary_actor_2",
  });

  db.insert(members).values([
    {
      id: "mem_human_secretary_actor_2",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Alice",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
    },
    {
      id: "mem_assistant_secretary_bad",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "assistant",
      displayName: "helper",
      ownerMemberId: "mem_human_secretary_actor_2",
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: "{\"command\":\"echo\"}",
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
    },
  ]).run();

  const wsToken = issueWsToken("mem_human_secretary_actor_2", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/secretary`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorMemberId: "mem_human_secretary_actor_2",
      wsToken,
      secretaryMemberId: "mem_assistant_secretary_bad",
      secretaryMode: "coordinate",
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "room secretary must be an active independent agent",
  });
});

test("room secretary observes human room messages without an explicit mention", async () => {
  const roomId = "room_secretary_observe";
  const createdAt = new Date("2026-03-25T00:10:00.000Z").toISOString();

  db.insert(rooms).values({
    id: roomId,
    name: "Secretary Observe Room",
    inviteToken: createInviteToken(),
    status: "active",
    secretaryMemberId: "mem_secretary_observer",
    secretaryMode: "coordinate",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_human_secretary_requester",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Alice",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_secretary_observer",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "independent",
      displayName: "Scribe",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write('secretary observed'));",
        ],
        inputFormat: 'text',
      }),
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  const wsToken = issueWsToken("mem_human_secretary_requester", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_human_secretary_requester",
      wsToken,
      content: "Can someone summarize what we should do next?",
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
  assert.equal(session?.agentMemberId, "mem_secretary_observer");
  assert.equal(session?.kind, "room_observe");

  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();
  assert.ok(
    roomMessages.some(
      (message) =>
        message.senderMemberId === "mem_secretary_observer" &&
        message.messageType === "agent_text" &&
        /secretary observed/i.test(message.content),
    ),
  );
});

test("room secretary can silently complete an observe run", async () => {
  const roomId = "room_secretary_silent";
  const createdAt = new Date("2026-03-25T00:12:00.000Z").toISOString();

  db.insert(rooms).values({
    id: roomId,
    name: "Secretary Silent Room",
    inviteToken: createInviteToken(),
    status: "active",
    secretaryMemberId: "mem_secretary_silent",
    secretaryMode: "coordinate",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_human_secretary_silent",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Alice",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_secretary_silent",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "independent",
      displayName: "Scribe",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  const wsToken = issueWsToken("mem_human_secretary_silent", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_human_secretary_silent",
      wsToken,
      content: "FYI, just logging a note.",
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
  assert.equal(session?.status, "completed");

  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();
  assert.equal(roomMessages.length, 1);
  assert.equal(roomMessages[0]?.senderMemberId, "mem_human_secretary_silent");
});

test("room secretary does not add a second session when another agent is explicitly targeted", async () => {
  const roomId = "room_secretary_no_duplicate_trigger";
  const createdAt = new Date("2026-03-25T00:14:00.000Z").toISOString();

  db.insert(rooms).values({
    id: roomId,
    name: "Secretary No Duplicate Room",
    inviteToken: createInviteToken(),
    status: "active",
    secretaryMemberId: "mem_secretary_guard",
    secretaryMode: "coordinate",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_human_secretary_guard",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Alice",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_secretary_guard",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "independent",
      displayName: "Scribe",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write('secretary should not run'));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_target_agent",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "independent",
      displayName: "Planner",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write('planner reply'));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  const wsToken = issueWsToken("mem_human_secretary_guard", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_human_secretary_guard",
      wsToken,
      content: "@Planner can you draft the next step?",
    }),
  });

  assert.equal(response.status, 201);

  const completedSessions = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .all(),
    (value) => value.some((item) => item.status === "completed"),
  );

  assert.equal(completedSessions.length, 1);
  assert.equal(completedSessions[0]?.agentMemberId, "mem_target_agent");

  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();
  assert.ok(roomMessages.some((message) => /planner reply/i.test(message.content)));
  assert.ok(!roomMessages.some((message) => /secretary should not run/i.test(message.content)));
});

test("room secretary in summarize mode stores hidden summary blocks separately from visible chat text", async () => {
  const roomId = "room_secretary_summary_local";
  const createdAt = new Date("2026-03-25T00:16:00.000Z").toISOString();

  db.insert(rooms).values({
    id: roomId,
    name: "Secretary Summary Room",
    inviteToken: createInviteToken(),
    status: "active",
    secretaryMemberId: "mem_secretary_summary",
    secretaryMode: "coordinate_and_summarize",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_human_secretary_summary",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Alice",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_secretary_summary",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "independent",
      displayName: "Scribe",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({ type: 'completed', finalText: 'I will ask @Planner next.', summaryText: 'Need planner draft and owner confirmation.' }) + '\\n');",
        ],
        inputFormat: "text",
        outputFormat: "jsonl",
      }),
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  const wsToken = issueWsToken("mem_human_secretary_summary", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_human_secretary_summary",
      wsToken,
      content: "We need to decide the next milestone.",
    }),
  });

  assert.equal(response.status, 201);

  await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .get(),
    (value) => value?.status === "completed",
  );

  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();
  const secretaryMessage = roomMessages.find((message) => message.senderMemberId === "mem_secretary_summary");
  assert.equal(secretaryMessage?.content, "I will ask @Planner next.");

  const storedSummary = db
    .select()
    .from(roomSummaries)
    .where(eq(roomSummaries.roomId, roomId))
    .get();
  assert.equal(storedSummary?.summaryText, "Need planner draft and owner confirmation.");
  assert.equal(storedSummary?.generatedByMemberId, "mem_secretary_summary");
  assert.equal(storedSummary?.sourceMessageId, secretaryMessage?.id ?? null);

  const summaryResponse = await app.request(`http://localhost/api/rooms/${roomId}/summary`);
  assert.equal(summaryResponse.status, 200);
  assert.deepEqual(await summaryResponse.json(), {
    summary: {
      roomId,
      summaryText: "Need planner draft and owner confirmation.",
      generatedByMemberId: "mem_secretary_summary",
      sourceMessageId: secretaryMessage?.id ?? null,
      createdAt: storedSummary?.createdAt,
      updatedAt: storedSummary?.updatedAt,
    },
  });
});

test("room summary artifact is injected into later agent prompts", async () => {
  const roomId = "room_summary_prompt_injection";
  const createdAt = new Date("2026-03-25T00:18:00.000Z").toISOString();

  db.insert(rooms).values({
    id: roomId,
    name: "Summary Prompt Injection Room",
    inviteToken: createInviteToken(),
    status: "active",
    secretaryMemberId: "mem_secretary_summary_seed",
    secretaryMode: "coordinate_and_summarize",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_requester_summary_prompt",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Requester",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_secretary_summary_seed",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "independent",
      displayName: "Scribe",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({ type: 'completed', summaryText: 'Project is blocked on the planner draft.' }) + '\\n');",
        ],
        inputFormat: "text",
        outputFormat: "jsonl",
      }),
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_planner_summary_prompt",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "independent",
      displayName: "Planner",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write(text.includes('Project is blocked on the planner draft.') ? 'summary seen' : 'summary missing'));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_summary_prompt", roomId);

  const seedResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_summary_prompt",
      wsToken: requesterToken,
      content: "Please keep the plan summary current.",
    }),
  });
  assert.equal(seedResponse.status, 201);

  await waitFor(
    () =>
      db
        .select()
        .from(roomSummaries)
        .where(eq(roomSummaries.roomId, roomId))
        .get(),
    (value) => value?.summaryText === "Project is blocked on the planner draft.",
  );

  const plannerResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_summary_prompt",
      wsToken: requesterToken,
      content: "@Planner can you take over?",
    }),
  });
  assert.equal(plannerResponse.status, 201);

  await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .all()
        .filter((session) => session.agentMemberId === "mem_planner_summary_prompt"),
    (value) => value.some((session) => session.status === "completed"),
  );

  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();
  assert.ok(roomMessages.some((message) => /summary seen/i.test(message.content)));
});

test("a nickname can be reused after the previous citizen leaves the room", async () => {
  const roomId = "room_join_reuse_after_leave";
  const inviteToken = createInviteToken();
  seedRoom({
    roomId,
    name: "Join Reuse Room",
    inviteToken,
  });

  const firstBootstrap = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "reuse-a@example.com",
      globalDisplayName: "Alice",
    }),
  });
  assert.equal(firstBootstrap.status, 200);
  const firstPrincipal = await firstBootstrap.json();

  const secondBootstrap = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "reuse-b@example.com",
      globalDisplayName: "Alice",
    }),
  });
  assert.equal(secondBootstrap.status, 200);
  const secondPrincipal = await secondBootstrap.json();

  const firstJoin = await app.request(`http://localhost/api/invites/${inviteToken}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: firstPrincipal.citizenId,
      citizenToken: firstPrincipal.citizenToken,
    }),
  });
  assert.equal(firstJoin.status, 200);

  const leaveResponse = await app.request(`http://localhost/api/rooms/${roomId}/leave`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: firstPrincipal.citizenId,
      citizenToken: firstPrincipal.citizenToken,
    }),
  });
  assert.equal(leaveResponse.status, 200);

  const secondJoin = await app.request(`http://localhost/api/invites/${inviteToken}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: secondPrincipal.citizenId,
      citizenToken: secondPrincipal.citizenToken,
    }),
  });

  assert.equal(secondJoin.status, 200);
  const activeMembers = db
    .select()
    .from(members)
    .where(eq(members.roomId, roomId))
    .all()
    .filter((member) => (member.membershipStatus ?? "active") === "active");
  assert.equal(activeMembers.length, 1);
  assert.equal(activeMembers[0]?.citizenId, secondPrincipal.citizenId);
  assert.equal(activeMembers[0]?.displayName, "Alice");
});

test("citizen bootstrap creates or restores a human citizen and room join can inherit global display name", async () => {
  const bootstrapResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "alice@example.com",
      globalDisplayName: "阿南",
    }),
  });

  assert.equal(bootstrapResponse.status, 200);
  const bootstrapResult = await bootstrapResponse.json();
  assert.equal(bootstrapResult.kind, "human");
  assert.equal(bootstrapResult.loginKey, "alice@example.com");
  assert.equal(bootstrapResult.globalDisplayName, "阿南");
  assert.equal(bootstrapResult.status, "offline");

  const restoredResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "alice@example.com",
      globalDisplayName: "阿南二号",
    }),
  });

  assert.equal(restoredResponse.status, 200);
  const restoredResult = await restoredResponse.json();
  assert.equal(restoredResult.citizenId, bootstrapResult.citizenId);
  assert.equal(restoredResult.globalDisplayName, "阿南二号");
  assert.equal(restoredResult.status, "offline");

  const persistedPrincipal = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, bootstrapResult.citizenId))
    .get();
  assert.equal(persistedPrincipal?.globalDisplayName, "阿南二号");

  const roomId = "room_principal_join";
  seedRoom({
    roomId,
    name: "Citizen Join Room",
    inviteToken: createInviteToken(),
  });

  const joinResponse = await app.request(`http://localhost/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: bootstrapResult.citizenId,
      citizenToken: bootstrapResult.citizenToken,
    }),
  });

  assert.equal(joinResponse.status, 403);
  assert.deepEqual(await joinResponse.json(), {
    error: "room join requires invite or existing membership",
  });

  const invitedJoinResponse = await app.request(
    `http://localhost/api/invites/${db.select().from(rooms).where(eq(rooms.id, roomId)).get()!.inviteToken}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: bootstrapResult.citizenId,
        citizenToken: bootstrapResult.citizenToken,
      }),
    },
  );

  assert.equal(invitedJoinResponse.status, 200);
  const joinResult = await invitedJoinResponse.json();
  assert.equal(joinResult.displayName, "阿南二号");

  const insertedMember = db.select().from(members).where(eq(members.id, joinResult.memberId)).get();
  assert.equal(insertedMember?.citizenId, bootstrapResult.citizenId);
  assert.equal(insertedMember?.displayName, "阿南二号");
});

test("citizen bootstrap syncs inherited member display names but preserves room-specific overrides", async () => {
  const bootstrapResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "rename@example.com",
      globalDisplayName: "gmail",
    }),
  });

  assert.equal(bootstrapResponse.status, 200);
  const principal = await bootstrapResponse.json();

  const roomId = "room_principal_rename_sync";
  seedRoom({
    roomId,
    name: "Rename Sync Room",
    inviteToken: createInviteToken(),
  });

  const invitedJoinResponse = await app.request(
    `http://localhost/api/invites/${db.select().from(rooms).where(eq(rooms.id, roomId)).get()!.inviteToken}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: principal.citizenId,
        citizenToken: principal.citizenToken,
      }),
    },
  );

  assert.equal(invitedJoinResponse.status, 200);
  const joinResult = await invitedJoinResponse.json();

  const customRoomId = "room_principal_rename_custom";
  seedRoom({
    roomId: customRoomId,
    name: "Rename Custom Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values({
    id: "mem_principal_rename_custom",
    roomId: customRoomId,
    citizenId: principal.citizenId,
    type: "human",
    roleKind: "none",
    displayName: "自定义昵称",
    ownerMemberId: null,
    sourcePrivateAssistantId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "offline",
    membershipStatus: "active",
    leftAt: null,
    createdAt: new Date("2026-03-30T08:00:00.000Z").toISOString(),
  }).run();

  const renameResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "rename@example.com",
      globalDisplayName: "老刘",
    }),
  });

  assert.equal(renameResponse.status, 200);

  const inheritedMember = db.select().from(members).where(eq(members.id, joinResult.memberId)).get();
  const customMember = db.select().from(members).where(eq(members.id, "mem_principal_rename_custom")).get();

  assert.equal(inheritedMember?.displayName, "老刘");
  assert.equal(customMember?.displayName, "自定义昵称");
});

test("principal lobby presence follows websocket connection instead of bootstrap", async () => {
  const bootstrapResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "presence-check@example.com",
      globalDisplayName: "在线校验",
    }),
  });

  assert.equal(bootstrapResponse.status, 200);
  const principal = await bootstrapResponse.json();
  assert.equal(principal.status, "offline");

  const initialLobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(initialLobbyResponse.status, 200);
  const initialLobby = await initialLobbyResponse.json();
  assert.equal(
    initialLobby.citizens.some((item: { id: string }) => item.id === principal.citizenId),
    false,
  );

  const disconnect = markCitizenOnline(principal.citizenId, principal.citizenToken);

  const onlinePrincipal = await waitFor(
    () =>
      db.select().from(citizens).where(eq(citizens.id, principal.citizenId)).get(),
    (value) => value?.status === "online",
  );
  assert.equal(onlinePrincipal?.status, "online");

  const onlineLobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(onlineLobbyResponse.status, 200);
  const onlineLobby = await onlineLobbyResponse.json();
  assert.equal(
    onlineLobby.citizens.some((item: { id: string }) => item.id === principal.citizenId),
    true,
  );

  disconnect();

  const offlinePrincipal = await waitFor(
    () =>
      db.select().from(citizens).where(eq(citizens.id, principal.citizenId)).get(),
    (value) => value?.status === "offline",
  );
  assert.equal(offlinePrincipal?.status, "offline");

  const offlineLobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(offlineLobbyResponse.status, 200);
  const offlineLobby = await offlineLobbyResponse.json();
  assert.equal(
    offlineLobby.citizens.some((item: { id: string }) => item.id === principal.citizenId),
    false,
  );
});

test("agent citizen can leave a room with citizen token", async () => {
  const bootstrapResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "agent",
      loginKey: "agent:leave-room:test",
      globalDisplayName: "LeaveRoomBot",
      backendType: "codex_cli",
      backendThreadId: "thread-leave-room",
    }),
  });

  assert.equal(bootstrapResponse.status, 200);
  const principal = await bootstrapResponse.json();

  const roomId = "room_leave_principal";
  const inviteToken = createInviteToken();
  seedRoom({
    roomId,
    name: "Leave Room",
    inviteToken,
  });

  const joinResponse = await app.request(`http://localhost/api/invites/${inviteToken}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
    }),
  });

  assert.equal(joinResponse.status, 200);
  const joinResult = await joinResponse.json();
  assert.ok(db.select().from(members).where(eq(members.id, joinResult.memberId)).get());

  const leaveResponse = await app.request(`http://localhost/api/rooms/${roomId}/leave`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
    }),
  });

  assert.equal(leaveResponse.status, 200);
  assert.deepEqual(await leaveResponse.json(), {
    left: true,
    roomId,
    citizenId: principal.citizenId,
    memberId: joinResult.memberId,
  });
  const departedMember = db.select().from(members).where(eq(members.id, joinResult.memberId)).get();
  assert.equal(departedMember?.citizenId, principal.citizenId);
  assert.equal(departedMember?.presenceStatus, "offline");
  assert.equal(departedMember?.membershipStatus, "left");
  assert.ok(departedMember?.leftAt);
});

test("agent citizen can leave the system and detach from all rooms", async () => {
  const bootstrapResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "agent",
      loginKey: "agent:leave-system:test",
      globalDisplayName: "LeaveSystemBot",
      backendType: "codex_cli",
      backendThreadId: "thread-leave-system",
    }),
  });

  assert.equal(bootstrapResponse.status, 200);
  const principal = await bootstrapResponse.json();

  db.insert(localBridges).values({
    id: "brg_leave_system",
    bridgeName: "Leave System Bridge",
    bridgeToken: "bridge-token",
    currentInstanceId: "bridge-instance",
    status: "online",
    platform: "darwin",
    version: "1.0.0",
    metadata: null,
    lastSeenAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
    createdAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
  }).run();

  db.update(agentBindings)
    .set({
      bridgeId: "brg_leave_system",
      status: "active",
      attachedAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
      detachedAt: null,
    })
    .where(eq(agentBindings.citizenId, principal.citizenId))
    .run();

  const roomA = { roomId: "room_leave_system_a", inviteToken: createInviteToken(), name: "Leave A" };
  const roomB = { roomId: "room_leave_system_b", inviteToken: createInviteToken(), name: "Leave B" };
  seedRoom(roomA);
  seedRoom(roomB);

  for (const room of [roomA, roomB]) {
    const joinResponse = await app.request(`http://localhost/api/invites/${room.inviteToken}/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: principal.citizenId,
        citizenToken: principal.citizenToken,
      }),
    });
    assert.equal(joinResponse.status, 200);
  }

  db.update(citizens).set({ status: "online" }).where(eq(citizens.id, principal.citizenId)).run();

  const leaveResponse = await app.request(
    `http://localho../api/citizens/${principal.citizenId}/leave-system`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenToken: principal.citizenToken,
      }),
    },
  );

  assert.equal(leaveResponse.status, 200);
  const leaveResult = await leaveResponse.json();
  assert.equal(leaveResult.leftSystem, true);
  assert.equal(leaveResult.removedRoomCount, 2);

  const remainingMembers = db
    .select()
    .from(members)
    .where(eq(members.citizenId, principal.citizenId))
    .all();
  assert.equal(remainingMembers.length, 0);

  const departedMembers = db
    .select()
    .from(members)
    .where(eq(members.displayName, "LeaveSystemBot"))
    .all();
  assert.ok(departedMembers.length >= 2);
  assert.ok(departedMembers.every((member) => member.citizenId === null));
  assert.ok(departedMembers.every((member) => member.presenceStatus === "offline"));
  assert.ok(departedMembers.every((member) => member.membershipStatus === "left"));
  assert.ok(departedMembers.every((member) => Boolean(member.leftAt)));

  const refreshedPrincipal = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, principal.citizenId))
    .get();
  assert.equal(refreshedPrincipal?.status, "offline");

  const refreshedBinding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.citizenId, principal.citizenId))
    .get();
  assert.equal(refreshedBinding?.bridgeId, null);
  assert.equal(refreshedBinding?.status, "detached");
});

test("human member can disband a room and archive its active runtime state", async () => {
  const roomId = "room_disband_runtime";
  const inviteToken = createInviteToken();
  const createdAt = new Date("2026-03-25T03:00:00.000Z").toISOString();

  seedRoom({
    roomId,
    inviteToken,
    name: "Disband Runtime Room",
    ownerMemberId: "mem_disband_owner",
  });

  db.insert(citizens).values([
    {
      id: "prn_disband_owner",
      kind: "human",
      loginKey: "owner@example.com",
      globalDisplayName: "OwnerDisband",
      backendType: null,
      backendThreadId: null,
      backendConfig: null,
      status: "online",
      createdAt,
    },
    {
      id: "prn_disband_peer",
      kind: "human",
      loginKey: "peer@example.com",
      globalDisplayName: "PeerDisband",
      backendType: null,
      backendThreadId: null,
      backendConfig: null,
      status: "online",
      createdAt,
    },
  ]).run();

  db.insert(members).values([
    {
      id: "mem_disband_owner",
      roomId,
      citizenId: "prn_disband_owner",
      type: "human",
      roleKind: "none",
      displayName: "OwnerDisband",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_disband_peer",
      roomId,
      citizenId: "prn_disband_peer",
      type: "human",
      roleKind: "none",
      displayName: "PeerDisband",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_disband_assistant",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "assistant",
      displayName: "DisbandAssistant",
      ownerMemberId: "mem_disband_owner",
      sourcePrivateAssistantId: "pa_disband_assistant",
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  db.insert(messages).values({
    id: "msg_disband_trigger",
    roomId,
    senderMemberId: "mem_disband_peer",
    senderDisplayName: "PeerDisband",
    senderType: "human",
    senderRoleKind: "none",
    messageType: "user_text",
    content: "@DisbandAssistant help",
    systemData: null,
    replyToMessageId: null,
    createdAt,
  }).run();

  db.insert(mentions).values({
    id: "men_disband_pending",
    messageId: "msg_disband_trigger",
    targetMemberId: "mem_disband_assistant",
    triggerText: "@DisbandAssistant",
    status: "pending_approval",
    createdAt,
  }).run();

  db.insert(approvals).values({
    id: "apr_disband_pending",
    roomId,
    requesterMemberId: "mem_disband_peer",
    ownerMemberId: "mem_disband_owner",
    agentMemberId: "mem_disband_assistant",
    triggerMessageId: "msg_disband_trigger",
    status: "pending",
    grantDuration: "once",
    createdAt,
    resolvedAt: null,
  }).run();

  db.insert(agentSessions).values({
    id: "ags_disband_waiting",
    roomId,
    agentMemberId: "mem_disband_assistant",
    kind: "message_reply",
    triggerMessageId: "msg_disband_trigger",
    requesterMemberId: "mem_disband_peer",
    approvalId: "apr_disband_pending",
    approvalRequired: true,
    status: "waiting_approval",
    startedAt: null,
    endedAt: null,
  }).run();

  db.insert(agentAuthorizations).values({
    id: "aut_disband_active",
    roomId,
    ownerMemberId: "mem_disband_owner",
    requesterMemberId: "mem_disband_peer",
    agentMemberId: "mem_disband_assistant",
    grantDuration: "forever",
    remainingUses: null,
    expiresAt: null,
    revokedAt: null,
    createdAt,
    updatedAt: createdAt,
  }).run();

  const ownerWsToken = issueWsToken("mem_disband_owner", roomId);
  const ownerPrincipalToken = issueCitizenToken("prn_disband_owner");

  const response = await app.request(`http://localhost/api/rooms/${roomId}/disband`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorMemberId: "mem_disband_owner",
      wsToken: ownerWsToken,
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.roomId, roomId);
  assert.equal(payload.status, "archived");
  assert.equal(payload.disbandedByMemberId, "mem_disband_owner");
  assert.ok(payload.disbandedAt);

  const archivedRoom = db.select().from(rooms).where(eq(rooms.id, roomId)).get();
  const roomMembers = db.select().from(members).where(eq(members.roomId, roomId)).all();
  const approval = db.select().from(approvals).where(eq(approvals.id, "apr_disband_pending")).get();
  const session = db.select().from(agentSessions).where(eq(agentSessions.id, "ags_disband_waiting")).get();
  const mention = db.select().from(mentions).where(eq(mentions.id, "men_disband_pending")).get();
  const authorization = db.select().from(agentAuthorizations).where(eq(agentAuthorizations.id, "aut_disband_active")).get();
  const joinedRoomsResponse = await app.request(
    `http://localhost/api/me/rooms?citizenId=prn_disband_owner&citizenToken=${ownerPrincipalToken}`,
  );

  assert.equal(archivedRoom?.status, "archived");
  assert.equal(archivedRoom?.ownerMemberId, null);
  assert.equal(archivedRoom?.secretaryMode, "off");
  assert.equal(archivedRoom?.secretaryMemberId, null);
  assert.ok(roomMembers.every((member) => member.membershipStatus === "left"));
  assert.ok(roomMembers.every((member) => member.presenceStatus === "offline"));
  assert.equal(approval?.status, "expired");
  assert.ok(approval?.resolvedAt);
  assert.equal(session?.status, "cancelled");
  assert.ok(session?.endedAt);
  assert.equal(mention?.status, "expired");
  assert.ok(authorization?.revokedAt);
  assert.deepEqual(await joinedRoomsResponse.json(), { rooms: [] });
});

test("archived rooms reject invite joins and new messages", async () => {
  const roomId = "room_disband_rejects_actions";
  const inviteToken = createInviteToken();
  const createdAt = new Date("2026-03-25T03:05:00.000Z").toISOString();

  seedRoom({
    roomId,
    inviteToken,
    name: "Archived Room Guards",
    ownerMemberId: "mem_disband_actor_only",
  });

  db.insert(citizens).values({
    id: "prn_disband_actor_only",
    kind: "human",
    loginKey: "actor-only@example.com",
    globalDisplayName: "ActorOnly",
    backendType: null,
    backendThreadId: null,
    backendConfig: null,
    status: "online",
    createdAt,
  }).run();

  db.insert(members).values({
    id: "mem_disband_actor_only",
    roomId,
    citizenId: "prn_disband_actor_only",
    type: "human",
    roleKind: "none",
    displayName: "ActorOnly",
    ownerMemberId: null,
    sourcePrivateAssistantId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "online",
    membershipStatus: "active",
    leftAt: null,
    createdAt,
  }).run();

  const actorWsToken = issueWsToken("mem_disband_actor_only", roomId);

  const disbandResponse = await app.request(`http://localhost/api/rooms/${roomId}/disband`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorMemberId: "mem_disband_actor_only",
      wsToken: actorWsToken,
    }),
  });

  assert.equal(disbandResponse.status, 200);

  const joinResponse = await app.request(`http://localhost/api/invites/${inviteToken}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "LateJoiner" }),
  });
  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_disband_actor_only",
      wsToken: actorWsToken,
      content: "hello?",
    }),
  });

  assert.equal(joinResponse.status, 410);
  assert.deepEqual(await joinResponse.json(), { error: "invite is no longer active" });
  assert.equal(messageResponse.status, 410);
  assert.deepEqual(await messageResponse.json(), { error: "room is archived" });
});

test("direct room reuses the same two-citizen room and room pull adds a lobby citizen into an existing room", async () => {
  const aliceResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "alice-direct@example.com",
      globalDisplayName: "阿南",
    }),
  });
  const bobResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "bob-direct@example.com",
      globalDisplayName: "小白",
    }),
  });
  const carolResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "carol-direct@example.com",
      globalDisplayName: "小红",
    }),
  });

  const alice = await aliceResponse.json();
  const bob = await bobResponse.json();
  const carol = await carolResponse.json();

  const firstDirectRoomResponse = await app.request("http://localhost/api/direct-rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorCitizenId: alice.citizenId,
      actorCitizenToken: alice.citizenToken,
      peerCitizenId: bob.citizenId,
    }),
  });

  assert.equal(firstDirectRoomResponse.status, 200);
  const firstDirectRoom = await firstDirectRoomResponse.json();
  assert.equal(firstDirectRoom.reused, false);

  const secondDirectRoomResponse = await app.request("http://localhost/api/direct-rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorCitizenId: alice.citizenId,
      actorCitizenToken: alice.citizenToken,
      peerCitizenId: bob.citizenId,
    }),
  });

  assert.equal(secondDirectRoomResponse.status, 200);
  const secondDirectRoom = await secondDirectRoomResponse.json();
  assert.equal(secondDirectRoom.reused, true);
  assert.equal(secondDirectRoom.room.id, firstDirectRoom.room.id);

  const actorJoinResponse = await app.request(
    `http://localhost/api/rooms/${firstDirectRoom.room.id}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: alice.citizenId,
        citizenToken: alice.citizenToken,
        roomDisplayName: "阿南主持人",
      }),
    },
  );

  assert.equal(actorJoinResponse.status, 200);
  const actorJoin = await actorJoinResponse.json();
  assert.equal(actorJoin.memberId, firstDirectRoom.join.memberId);

  const actorMember = db
    .select()
    .from(members)
    .where(eq(members.id, firstDirectRoom.join.memberId))
    .get();
  assert.ok(actorMember);

  const actorToken = issueWsToken(actorMember.id, firstDirectRoom.room.id);

  const pullResponse = await app.request(`http://localhost/api/rooms/${firstDirectRoom.room.id}/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorMemberId: actorMember.id,
      wsToken: actorToken,
      targetCitizenId: carol.citizenId,
    }),
  });

  assert.equal(pullResponse.status, 201);
  const pulledJoin = await pullResponse.json();
  assert.equal(pulledJoin.displayName, "小红");

  const roomMembers = db
    .select()
    .from(members)
    .where(eq(members.roomId, firstDirectRoom.room.id))
    .all();
  assert.equal(roomMembers.length, 3);
  assert.ok(roomMembers.find((member) => member.citizenId === carol.citizenId));
});

test("agent citizens can initiate direct rooms with humans", async () => {
  const agentResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "agent",
      loginKey: "agent:finance-bot",
      globalDisplayName: "FinanceBot",
      backendType: "codex_cli",
      backendThreadId: "thread_agent_principal_finance",
    }),
  });
  const humanResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "human-agent-peer@example.com",
      globalDisplayName: "阿南",
    }),
  });

  assert.equal(agentResponse.status, 200);
  const agent = await agentResponse.json();
  const human = await humanResponse.json();
  assert.equal(agent.status, "offline");
  assert.equal(human.status, "offline");

  const disconnectAgent = markCitizenOnline(agent.citizenId, agent.citizenToken);

  const lobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(lobbyResponse.status, 200);
  const lobby = await lobbyResponse.json();
  const lobbyAgent = lobby.citizens.find((item: { id: string }) => item.id === agent.citizenId);
  assert.ok(lobbyAgent);
  assert.equal(lobbyAgent.backendType, "codex_cli");
  assert.equal(lobbyAgent.runtimeStatus, "pending_bridge");

  const directRoomResponse = await app.request("http://localhost/api/direct-rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorCitizenId: agent.citizenId,
      actorCitizenToken: agent.citizenToken,
      peerCitizenId: human.citizenId,
    }),
  });

  assert.equal(directRoomResponse.status, 200);
  const directRoom = await directRoomResponse.json();
  assert.equal(directRoom.reused, false);

  const roomMembers = db
    .select()
    .from(members)
    .where(eq(members.roomId, directRoom.room.id))
    .all();
  const actorMember = roomMembers.find((member) => member.citizenId === agent.citizenId);
  const peerMember = roomMembers.find((member) => member.citizenId === human.citizenId);
  assert.equal(directRoom.room.ownerMemberId, peerMember?.id);
  assert.equal(actorMember?.type, "agent");
  assert.equal(actorMember?.roleKind, "independent");
  assert.equal(actorMember?.adapterType, "codex_cli");
  assert.equal(peerMember?.type, "human");
  assert.equal(peerMember?.roleKind, "none");

  const leaveResponse = await app.request(`http://localhost/api/rooms/${directRoom.room.id}/leave`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: agent.citizenId,
      citizenToken: agent.citizenToken,
    }),
  });
  assert.equal(leaveResponse.status, 200);
  const leavePayload = await leaveResponse.json();
  assert.equal(leavePayload.left, true);

  disconnectAgent();
});

test("agent citizen with active binding appears in lobby without citizen websocket", async () => {
  const agentResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "agent",
      loginKey: "agent:lobby-bridge-bot",
      globalDisplayName: "LobbyBridgeBot",
      backendType: "codex_cli",
      backendThreadId: "thread_agent_principal_lobby_bridge",
    }),
  });

  assert.equal(agentResponse.status, 200);
  const agent = await agentResponse.json();
  assert.equal(agent.status, "offline");

  db.insert(localBridges).values({
    id: "brg_lobby_bridge",
    bridgeName: "Lobby Bridge",
    bridgeToken: "bridge-token-lobby",
    currentInstanceId: "bridge-instance",
    status: "online",
    platform: "darwin",
    version: "1.0.0",
    metadata: null,
    lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).run();

  db.update(agentBindings)
    .set({
      bridgeId: "brg_lobby_bridge",
      status: "active",
      attachedAt: new Date().toISOString(),
      detachedAt: null,
    })
    .where(eq(agentBindings.backendThreadId, "thread_agent_principal_lobby_bridge"))
    .run();

  const lobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(lobbyResponse.status, 200);
  const lobby = await lobbyResponse.json();
  const lobbyAgent = lobby.citizens.find((item: { id: string }) => item.id === agent.citizenId);
  assert.ok(lobbyAgent);
  assert.equal(lobbyAgent.status, "online");
  assert.equal(lobbyAgent.runtimeStatus, "ready");
});

test("claude agent citizens can also initiate direct rooms", async () => {
  const agentResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "agent",
      loginKey: "agent:claude-helper",
      globalDisplayName: "ClaudeHelper",
      backendType: "claude_code",
      backendThreadId: "thread_agent_principal_claude",
    }),
  });
  const humanResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "human-claude-peer@example.com",
      globalDisplayName: "小李",
    }),
  });

  assert.equal(agentResponse.status, 200);
  const agent = await agentResponse.json();
  const human = await humanResponse.json();
  assert.equal(agent.status, "offline");
  assert.equal(agent.backendType, "claude_code");
  assert.equal(agent.backendThreadId, "thread_agent_principal_claude");
  assert.equal(human.status, "offline");

  const disconnectAgent = markCitizenOnline(agent.citizenId, agent.citizenToken);

  const lobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(lobbyResponse.status, 200);
  const lobby = await lobbyResponse.json();
  const lobbyAgent = lobby.citizens.find((item: { id: string }) => item.id === agent.citizenId);
  assert.ok(lobbyAgent);
  assert.equal(lobbyAgent.backendType, "claude_code");
  assert.equal(lobbyAgent.runtimeStatus, "pending_bridge");

  const directRoomResponse = await app.request("http://localhost/api/direct-rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorCitizenId: agent.citizenId,
      actorCitizenToken: agent.citizenToken,
      peerCitizenId: human.citizenId,
    }),
  });

  assert.equal(directRoomResponse.status, 200);
  const directRoom = await directRoomResponse.json();
  const roomMembers = db
    .select()
    .from(members)
    .where(eq(members.roomId, directRoom.room.id))
    .all();
  const actorMember = roomMembers.find((member) => member.citizenId === agent.citizenId);
  const peerMember = roomMembers.find((member) => member.citizenId === human.citizenId);
  assert.equal(directRoom.room.ownerMemberId, peerMember?.id);
  assert.equal(actorMember?.type, "agent");
  assert.equal(actorMember?.roleKind, "independent");
  assert.equal(actorMember?.adapterType, "claude_code");

  disconnectAgent();
});

test("room owner can transfer ownership to another active human member", async () => {
  const roomId = "room_owner_transfer";
  const inviteToken = createInviteToken();
  const createdAt = new Date("2026-03-25T03:15:00.000Z").toISOString();

  seedRoom({
    roomId,
    inviteToken,
    name: "Owner Transfer Room",
    ownerMemberId: "mem_owner_transfer_current",
  });

  db.insert(members).values([
    {
      id: "mem_owner_transfer_current",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Alice",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_owner_transfer_next",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Bob",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "offline",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  const wsToken = issueWsToken("mem_owner_transfer_current", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/ownership/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorMemberId: "mem_owner_transfer_current",
      wsToken,
      nextOwnerMemberId: "mem_owner_transfer_next",
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ownerMemberId, "mem_owner_transfer_next");

  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get();
  assert.equal(room?.ownerMemberId, "mem_owner_transfer_next");
});

test("room owner cannot leave before transferring ownership", async () => {
  const roomId = "room_owner_leave_requires_transfer";
  const createdAt = new Date("2026-03-25T03:20:00.000Z").toISOString();

  seedRoom({
    roomId,
    inviteToken: createInviteToken(),
    name: "Owner Leave Guard Room",
    ownerMemberId: "mem_owner_leave_guard",
  });

  db.insert(citizens).values([
    {
      id: "prn_owner_leave_guard",
      kind: "human",
      loginKey: "owner-leave-guard@example.com",
      globalDisplayName: "Alice",
      backendType: null,
      backendThreadId: null,
      backendConfig: null,
      status: "online",
      createdAt,
    },
    {
      id: "prn_owner_leave_guard_peer",
      kind: "human",
      loginKey: "owner-leave-guard-peer@example.com",
      globalDisplayName: "Bob",
      backendType: null,
      backendThreadId: null,
      backendConfig: null,
      status: "offline",
      createdAt,
    },
  ]).run();

  db.insert(members).values([
    {
      id: "mem_owner_leave_guard",
      roomId,
      citizenId: "prn_owner_leave_guard",
      type: "human",
      roleKind: "none",
      displayName: "Alice",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_owner_leave_guard_peer",
      roomId,
      citizenId: "prn_owner_leave_guard_peer",
      type: "human",
      roleKind: "none",
      displayName: "Bob",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "offline",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  const citizenToken = issueCitizenToken("prn_owner_leave_guard");
  const response = await app.request(`http://localhost/api/rooms/${roomId}/leave`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: "prn_owner_leave_guard",
      citizenToken,
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "room owner must transfer ownership before leaving",
  });
});

test("openai-compatible agent citizen bootstrap stores backendConfig and auto-generates backendThreadId", async () => {
  const agentResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "agent",
      loginKey: "agent:lmstudio-openai",
      globalDisplayName: "LocalOpenAI",
      backendType: "openai_compatible",
      backendConfig: {
        baseUrl: "http://127.0.0.1:1234/v1/",
        model: "qwen2.5-7b-instruct",
      },
    }),
  });

  assert.equal(agentResponse.status, 200);
  const agent = await agentResponse.json();
  assert.equal(agent.backendType, "openai_compatible");
  assert.match(agent.backendThreadId, /^oai_/);
  assert.deepEqual(agent.backendConfig, {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen2.5-7b-instruct",
  });

  const storedPrincipal = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, agent.citizenId))
    .get();
  assert.equal(storedPrincipal?.backendType, "openai_compatible");
  assert.equal(
    storedPrincipal?.backendConfig,
    JSON.stringify({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen2.5-7b-instruct",
    }),
  );

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.citizenId, agent.citizenId))
    .get();
  assert.equal(binding?.backendType, "openai_compatible");
  assert.equal(binding?.backendThreadId, agent.backendThreadId);

  const disconnectAgent = markCitizenOnline(agent.citizenId, agent.citizenToken);

  const lobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(lobbyResponse.status, 200);
  const lobby = await lobbyResponse.json();
  const lobbyAgent = lobby.citizens.find((item: { id: string }) => item.id === agent.citizenId);
  assert.ok(lobbyAgent);
  assert.equal(lobbyAgent.backendType, "openai_compatible");
  assert.deepEqual(lobbyAgent.backendConfig, {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen2.5-7b-instruct",
  });
  assert.equal(lobbyAgent.runtimeStatus, "pending_bridge");

  disconnectAgent();
});

test("citizen can create an openai-compatible agent citizen from a shared server config", async () => {
  const ownerResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "agent-citizen-owner@example.com",
      globalDisplayName: "OwnerUser",
    }),
  });
  const consumerResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "agent-citizen-consumer@example.com",
      globalDisplayName: "ConsumerUser",
    }),
  });
  const owner = await ownerResponse.json();
  const consumer = await consumerResponse.json();

  const configCreateResponse = await app.request("http://localhost/api/me/server-configs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: owner.citizenId,
      citizenToken: owner.citizenToken,
      name: "Shared Citizen Config",
      backendType: "openai_compatible",
      visibility: "shared",
      config: {
        baseUrl: "http://127.0.0.1:4444/v1/",
        model: "citizen-qwen",
        apiKey: "citizen-secret",
      },
    }),
  });
  assert.equal(configCreateResponse.status, 201);
  const createdConfig = await configCreateResponse.json();

  const createCitizenResponse = await app.request("http://localhost/api/me/agent-citizens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorCitizenId: consumer.citizenId,
      actorCitizenToken: consumer.citizenToken,
      loginKey: "agent:shared-citizen",
      globalDisplayName: "SharedCitizen",
      serverConfigId: createdConfig.id,
    }),
  });

  assert.equal(createCitizenResponse.status, 201);
  const createdCitizen = await createCitizenResponse.json();
  assert.equal(createdCitizen.kind, "agent");
  assert.equal(createdCitizen.backendType, "openai_compatible");
  assert.match(createdCitizen.backendThreadId, /^oai_/);
  assert.deepEqual(createdCitizen.backendConfig, {
    baseUrl: "http://127.0.0.1:4444/v1",
    model: "citizen-qwen",
  });

  const storedPrincipal = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, createdCitizen.citizenId))
    .get();
  assert.equal(storedPrincipal?.kind, "agent");
  assert.equal(storedPrincipal?.loginKey, "agent:shared-citizen");
  assert.equal(storedPrincipal?.sourceServerConfigId, createdConfig.id);
  assert.equal(
    storedPrincipal?.backendConfig,
    JSON.stringify({
      baseUrl: "http://127.0.0.1:4444/v1",
      model: "citizen-qwen",
      apiKey: "citizen-secret",
    }),
  );

  const storedBinding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.citizenId, createdCitizen.citizenId))
    .get();
  assert.equal(storedBinding?.backendType, "openai_compatible");
  assert.equal(storedBinding?.backendThreadId, createdCitizen.backendThreadId);

  const disconnectAgent = markCitizenOnline(createdCitizen.citizenId, createdCitizen.citizenToken);
  const lobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(lobbyResponse.status, 200);
  const lobby = await lobbyResponse.json();
  const lobbyAgent = lobby.citizens.find((item: { id: string }) => item.id === createdCitizen.citizenId);
  assert.ok(lobbyAgent);
  assert.deepEqual(lobbyAgent.backendConfig, {
    baseUrl: "http://127.0.0.1:4444/v1",
    model: "citizen-qwen",
  });
  disconnectAgent();
});

test("citizen cannot create an agent citizen from another citizen's private server config", async () => {
  const ownerResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "agent-citizen-private-owner@example.com",
      globalDisplayName: "PrivateOwner",
    }),
  });
  const consumerResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "agent-citizen-private-consumer@example.com",
      globalDisplayName: "PrivateConsumer",
    }),
  });
  const owner = await ownerResponse.json();
  const consumer = await consumerResponse.json();

  const configCreateResponse = await app.request("http://localhost/api/me/server-configs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: owner.citizenId,
      citizenToken: owner.citizenToken,
      name: "Private Citizen Config",
      backendType: "openai_compatible",
      visibility: "private",
      config: {
        baseUrl: "http://127.0.0.1:4545/v1/",
        model: "private-qwen",
        apiKey: "private-secret",
      },
    }),
  });
  assert.equal(configCreateResponse.status, 201);
  const createdConfig = await configCreateResponse.json();

  const createCitizenResponse = await app.request("http://localhost/api/me/agent-citizens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorCitizenId: consumer.citizenId,
      actorCitizenToken: consumer.citizenToken,
      loginKey: "agent:private-citizen",
      globalDisplayName: "PrivateCitizen",
      serverConfigId: createdConfig.id,
    }),
  });
  assert.equal(createCitizenResponse.status, 403);
  assert.deepEqual(await createCitizenResponse.json(), {
    error: "server config is not available to this citizen",
  });
});

test("agent citizen bootstrap rejects a bound backendThreadId without leaving a citizen record", async () => {
  const createdAt = new Date("2026-03-25T00:30:00.000Z").toISOString();

  db.insert(citizens).values({
    id: "prn_existing_bound_agent",
    kind: "agent",
    loginKey: "agent:existing-bound",
    globalDisplayName: "ExistingBound",
    backendType: "codex_cli",
    backendThreadId: "thread_bound_conflict",
    status: "offline",
    createdAt,
  }).run();

  db.insert(agentBindings).values({
    id: "agb_existing_bound_agent",
    citizenId: "prn_existing_bound_agent",
    privateAssistantId: null,
    bridgeId: null,
    backendType: "codex_cli",
    backendThreadId: "thread_bound_conflict",
    cwd: null,
    status: "pending_bridge",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const response = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "agent",
      loginKey: "agent:new-conflict",
      globalDisplayName: "NewConflict",
      backendType: "codex_cli",
      backendThreadId: "thread_bound_conflict",
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "backendThreadId already bound",
  });

  const leakedPrincipal = db
    .select()
    .from(citizens)
    .where(eq(citizens.loginKey, "agent:new-conflict"))
    .get();
  assert.equal(leakedPrincipal, undefined);
});

test("agent citizen bootstrap keeps an existing principal unchanged when backendThreadId is already bound elsewhere", async () => {
  const createdAt = new Date("2026-03-25T00:40:00.000Z").toISOString();

  db.insert(citizens).values([
    {
      id: "prn_existing_update_agent",
      kind: "agent",
      loginKey: "agent:update-target",
      globalDisplayName: "BeforeUpdate",
      backendType: "codex_cli",
      backendThreadId: "thread_update_original",
      status: "offline",
      createdAt,
    },
    {
      id: "prn_existing_conflict_agent",
      kind: "agent",
      loginKey: "agent:update-conflict-owner",
      globalDisplayName: "ConflictOwner",
      backendType: "codex_cli",
      backendThreadId: "thread_update_conflict",
      status: "offline",
      createdAt,
    },
  ]).run();

  db.insert(agentBindings).values([
    {
      id: "agb_existing_update_agent",
      citizenId: "prn_existing_update_agent",
      privateAssistantId: null,
      bridgeId: null,
      backendType: "codex_cli",
      backendThreadId: "thread_update_original",
      cwd: null,
      status: "pending_bridge",
      attachedAt: createdAt,
      detachedAt: null,
    },
    {
      id: "agb_existing_conflict_agent",
      citizenId: "prn_existing_conflict_agent",
      privateAssistantId: null,
      bridgeId: null,
      backendType: "codex_cli",
      backendThreadId: "thread_update_conflict",
      cwd: null,
      status: "pending_bridge",
      attachedAt: createdAt,
      detachedAt: null,
    },
  ]).run();

  const response = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "agent",
      loginKey: "agent:update-target",
      globalDisplayName: "AfterAttempt",
      backendType: "codex_cli",
      backendThreadId: "thread_update_conflict",
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "backendThreadId already bound",
  });

  const principalAfter = db
    .select()
    .from(citizens)
    .where(eq(citizens.id, "prn_existing_update_agent"))
    .get();
  const bindingAfter = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.id, "agb_existing_update_agent"))
    .get();

  assert.equal(principalAfter?.globalDisplayName, "BeforeUpdate");
  assert.equal(principalAfter?.backendThreadId, "thread_update_original");
  assert.equal(bindingAfter?.backendThreadId, "thread_update_original");
});

test("citizen can invite a private codex assistant, accept it, and adopt it into a room", async () => {
  const bootstrapResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "owner-private@example.com",
      globalDisplayName: "房主",
    }),
  });
  const principal = await bootstrapResponse.json();

  const inviteResponse = await app.request("http://localhost/api/me/assistants/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
      name: "账本助理",
      backendType: "codex_cli",
    }),
  });

  assert.equal(inviteResponse.status, 201);
  const privateAssistantInvite = await inviteResponse.json();

  const listedInvitesResponse = await app.request(
    `http://localhost/api/me/assistants/invites?citizenId=${principal.citizenId}&citizenToken=${principal.citizenToken}`,
  );
  assert.equal(listedInvitesResponse.status, 200);
  const listedInvites = await listedInvitesResponse.json();
  assert.equal(listedInvites.length, 1);
  assert.equal(listedInvites[0].id, privateAssistantInvite.id);

  const acceptInviteResponse = await app.request(
    `http://localhost/api/private-assistant-invites/${privateAssistantInvite.inviteToken}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backendThreadId: "thread_private_codex_1",
      }),
    },
  );

  assert.equal(acceptInviteResponse.status, 201);
  const privateAssistant = await acceptInviteResponse.json();

  const listedResponse = await app.request(
    `http://localhost/api/me/assistants?citizenId=${principal.citizenId}&citizenToken=${principal.citizenToken}`,
  );
  assert.equal(listedResponse.status, 200);
  const listedAssistants = await listedResponse.json();
  assert.equal(listedAssistants.length, 1);
  assert.equal(listedAssistants[0].id, privateAssistant.id);

  const roomId = "room_private_assistant";
  seedRoom({
    roomId,
    name: "Private Assistant Room",
    inviteToken: createInviteToken(),
  });

  const joinResponse = await app.request(`http://localhost/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
    }),
  });
  assert.equal(joinResponse.status, 403);
  const invitedJoinResponse = await app.request(
    `http://localhost/api/invites/${db.select().from(rooms).where(eq(rooms.id, roomId)).get()!.inviteToken}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: principal.citizenId,
        citizenToken: principal.citizenToken,
      }),
    },
  );
  assert.equal(invitedJoinResponse.status, 200);
  const join = await invitedJoinResponse.json();
  const actorToken = join.wsToken;

  const adoptResponse = await app.request(
    `http://localhost/api/rooms/${roomId}/assistants/adopt`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorMemberId: join.memberId,
        wsToken: actorToken,
        privateAssistantId: privateAssistant.id,
      }),
    },
  );

  assert.equal(adoptResponse.status, 201);
  const adoptedMember = await adoptResponse.json();
  assert.equal(adoptedMember.displayName, "账本助理");

  const insertedProjection = db
    .select()
    .from(members)
    .where(eq(members.id, adoptedMember.id))
    .get();
  assert.equal(insertedProjection?.sourcePrivateAssistantId, privateAssistant.id);

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.privateAssistantId, privateAssistant.id))
    .get();
  assert.equal(binding?.backendThreadId, "thread_private_codex_1");

  const storedAssistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, privateAssistant.id))
    .get();
  assert.equal(storedAssistant?.name, "账本助理");

  db.insert(messages).values({
    id: "msg_private_assistant_history",
    roomId,
    senderMemberId: adoptedMember.id,
    messageType: "agent_text",
    content: "账本已同步。",
    systemData: null,
    replyToMessageId: null,
    createdAt: new Date("2026-03-25T00:20:00.000Z").toISOString(),
  }).run();

  const secondRoomId = "room_private_assistant_second";
  seedRoom({
    roomId: secondRoomId,
    name: "Private Assistant Room 2",
    inviteToken: createInviteToken(),
  });

  const secondJoinResponse = await app.request(`http://localhost/api/rooms/${secondRoomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
      roomDisplayName: "房主二号",
    }),
  });
  assert.equal(secondJoinResponse.status, 403);
  const secondInvitedJoinResponse = await app.request(
    `http://localhost/api/invites/${db.select().from(rooms).where(eq(rooms.id, secondRoomId)).get()!.inviteToken}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: principal.citizenId,
        citizenToken: principal.citizenToken,
        roomDisplayName: "房主二号",
      }),
    },
  );
  assert.equal(secondInvitedJoinResponse.status, 200);
  const secondJoin = await secondInvitedJoinResponse.json();

  const secondAdoptResponse = await app.request(
    `http://localhost/api/rooms/${secondRoomId}/assistants/adopt`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorMemberId: secondJoin.memberId,
        wsToken: secondJoin.wsToken,
        privateAssistantId: privateAssistant.id,
      }),
    },
  );

  assert.equal(secondAdoptResponse.status, 201);
  const secondAdoptedMember = await secondAdoptResponse.json();

  const allBindingsForThread = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.backendThreadId, "thread_private_codex_1"))
    .all();
  assert.equal(allBindingsForThread.length, 1);

  const secondProjection = db
    .select()
    .from(members)
    .where(eq(members.id, secondAdoptedMember.id))
    .get();
  assert.equal(secondProjection?.sourcePrivateAssistantId, privateAssistant.id);

  const offlineResponse = await app.request(
    `http://localhost/api/rooms/${roomId}/assistants/${adoptedMember.id}/offline`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorMemberId: join.memberId,
        wsToken: actorToken,
      }),
    },
  );
  assert.equal(offlineResponse.status, 200);

  const hiddenProjection = db
    .select()
    .from(members)
    .where(eq(members.id, adoptedMember.id))
    .get();
  assert.equal(hiddenProjection?.presenceStatus, "offline");

  const reAdoptResponse = await app.request(
    `http://localhost/api/rooms/${roomId}/assistants/adopt`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorMemberId: join.memberId,
        wsToken: actorToken,
        privateAssistantId: privateAssistant.id,
      }),
    },
  );
  assert.equal(reAdoptResponse.status, 201);
  const reAdoptedMember = await reAdoptResponse.json();
  assert.equal(reAdoptedMember.id, adoptedMember.id);

  const deleteResponse = await app.request(
    `http://localhost/api/me/assistants/${privateAssistant.id}?citizenId=${principal.citizenId}&citizenToken=${principal.citizenToken}`,
    {
      method: "DELETE",
    },
  );
  assert.equal(deleteResponse.status, 200);

  const deletedAssistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, privateAssistant.id))
    .get();
  assert.equal(deletedAssistant, undefined);

  const deletedProjection = db
    .select()
    .from(members)
    .where(eq(members.id, adoptedMember.id))
    .get();
  assert.equal(deletedProjection?.presenceStatus, "offline");

  const projectionMessageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`);
  assert.equal(projectionMessageResponse.status, 200);
  const projectionMessages = (await projectionMessageResponse.json()) as Array<{
    senderMemberId: string;
    senderDisplayName: string;
    senderPresenceStatus: string | null;
  }>;
  const assistantHistory = projectionMessages.find((message) => message.senderMemberId === adoptedMember.id);
  assert.equal(assistantHistory?.senderDisplayName, "账本助理");
  assert.equal(assistantHistory?.senderPresenceStatus, "offline");
});

test("private assistants can be paused and resumed by the owner", async () => {
  const principalResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "paused-assistant-owner@example.com",
      globalDisplayName: "暂停房主",
    }),
  });
  assert.equal(principalResponse.status, 200);
  const principal = await principalResponse.json();

  const assistantResponse = await app.request("http://localhost/api/me/assistants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
      name: "暂停助理",
      backendType: "openai_compatible",
      backendConfig: {
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "neo-test",
      },
    }),
  });
  assert.equal(assistantResponse.status, 201);
  const assistant = await assistantResponse.json();

  const roomId = "room_paused_assistant";
  seedRoom({
    roomId,
    name: "Paused Assistant Room",
    inviteToken: createInviteToken(),
  });

  const joinResponse = await app.request(
    `http://localhost/api/invites/${db.select().from(rooms).where(eq(rooms.id, roomId)).get()!.inviteToken}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: principal.citizenId,
        citizenToken: principal.citizenToken,
      }),
    },
  );
  assert.equal(joinResponse.status, 200);
  const join = await joinResponse.json();

  const pauseResponse = await app.request(`http://localhost/api/me/assistants/${assistant.id}/pause`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
    }),
  });
  assert.equal(pauseResponse.status, 200);
  assert.equal((await pauseResponse.json()).status, "paused");

  const blockedAdoptResponse = await app.request(`http://localhost/api/rooms/${roomId}/assistants/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorMemberId: join.memberId,
      wsToken: join.wsToken,
      privateAssistantId: assistant.id,
    }),
  });
  assert.equal(blockedAdoptResponse.status, 409);
  assert.deepEqual(await blockedAdoptResponse.json(), {
    error: "private assistant is temporarily offline",
  });

  const resumeResponse = await app.request(`http://localhost/api/me/assistants/${assistant.id}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
    }),
  });
  assert.equal(resumeResponse.status, 200);

  const adoptResponse = await app.request(`http://localhost/api/rooms/${roomId}/assistants/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorMemberId: join.memberId,
      wsToken: join.wsToken,
      privateAssistantId: assistant.id,
    }),
  });
  assert.equal(adoptResponse.status, 201);
  const adopted = await adoptResponse.json();

  const pauseAgainResponse = await app.request(`http://localhost/api/me/assistants/${assistant.id}/pause`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
    }),
  });
  assert.equal(pauseAgainResponse.status, 200);

  const pausedProjection = db.select().from(members).where(eq(members.id, adopted.id)).get();
  assert.equal(pausedProjection?.presenceStatus, "offline");

  const listedMembersResponse = await app.request(`http://localhost/api/rooms/${roomId}/members`);
  assert.equal(listedMembersResponse.status, 200);
  const listedMembers = (await listedMembersResponse.json()) as Array<{ id: string; presenceStatus: string }>;
  assert.ok(
    listedMembers.some((member) => member.id === adopted.id && member.presenceStatus === "offline"),
  );

  const mentionResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: join.memberId,
      wsToken: join.wsToken,
      content: "@暂停助理 帮我看一下",
    }),
  });
  assert.equal(mentionResponse.status, 201);

  const listedMessagesResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`);
  const listedMessages = (await listedMessagesResponse.json()) as Array<{
    messageType: string;
    systemData: { kind: string; title: string } | null;
  }>;
  const unavailableMessage = listedMessages.find(
    (message) => message.systemData?.kind === "agent_unavailable",
  );
  assert.equal(unavailableMessage?.messageType, "system_notice");
});

test("citizen can directly connect an openai-compatible private assistant from the web ui", async () => {
  const bootstrapResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "owner-web-assistant@example.com",
      globalDisplayName: "Web Owner",
    }),
  });
  const principal = await bootstrapResponse.json();

  const createResponse = await app.request("http://localhost/api/me/assistants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: principal.citizenId,
      citizenToken: principal.citizenToken,
      name: "本地模型助理",
      backendType: "openai_compatible",
      backendConfig: {
        baseUrl: "http://127.0.0.1:1234/v1/",
        model: "qwen-local",
      },
    }),
  });

  assert.equal(createResponse.status, 201);
  const assistant = await createResponse.json();
  assert.equal(assistant.backendType, "openai_compatible");
  assert.match(assistant.backendThreadId, /^oai_/);
  assert.equal(
    assistant.backendConfig,
    JSON.stringify({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen-local",
    }),
  );

  const listedResponse = await app.request(
    `http://localhost/api/me/assistants?citizenId=${principal.citizenId}&citizenToken=${principal.citizenToken}`,
  );
  assert.equal(listedResponse.status, 200);
  const listedAssistants = await listedResponse.json();
  assert.equal(listedAssistants.length, 1);
  assert.equal(listedAssistants[0].id, assistant.id);

  const storedBinding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.privateAssistantId, assistant.id))
    .get();
  assert.equal(storedBinding?.backendType, "openai_compatible");
  assert.equal(storedBinding?.backendThreadId, assistant.backendThreadId);
});

test("citizen can manage private and shared server configs", async () => {
  const ownerResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "server-config-owner@example.com",
      globalDisplayName: "ServerConfigOwner",
    }),
  });
  const peerResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "server-config-peer@example.com",
      globalDisplayName: "ServerConfigPeer",
    }),
  });
  const owner = await ownerResponse.json();
  const peer = await peerResponse.json();

  const createResponse = await app.request("http://localhost/api/me/server-configs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: owner.citizenId,
      citizenToken: owner.citizenToken,
      name: "Team Shared Qwen",
      backendType: "openai_compatible",
      visibility: "shared",
      config: {
        baseUrl: "http://127.0.0.1:1234/v1/",
        model: "qwen-team",
        apiKey: "secret-token",
        headers: {
          Authorization: "Bearer hidden-token",
        },
      },
    }),
  });

  assert.equal(createResponse.status, 201);
  const createdConfig = await createResponse.json();
  assert.equal(createdConfig.visibility, "shared");
  assert.equal(createdConfig.config.apiKey, "secret-token");

  const ownListResponse = await app.request(
    `http://localhost/api/me/server-configs?citizenId=${owner.citizenId}&citizenToken=${owner.citizenToken}`,
  );
  assert.equal(ownListResponse.status, 200);
  const ownList = await ownListResponse.json();
  assert.equal(ownList.length, 1);
  assert.equal(ownList[0].id, createdConfig.id);

  const sharedListResponse = await app.request(
    `http://localhost/api/server-configs/shared?citizenId=${peer.citizenId}&citizenToken=${peer.citizenToken}`,
  );
  assert.equal(sharedListResponse.status, 200);
  const sharedList = await sharedListResponse.json();
  const sharedConfig = sharedList.find((item: { id: string }) => item.id === createdConfig.id);
  assert.ok(sharedConfig);
  assert.equal(sharedConfig.config.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(sharedConfig.config.model, "qwen-team");
  assert.equal(sharedConfig.config.apiKey, undefined);
  assert.equal(sharedConfig.config.headers, undefined);
  assert.equal(sharedConfig.hasAuth, true);

  const patchResponse = await app.request(
    `http://localhost/api/me/server-configs/${createdConfig.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: owner.citizenId,
        citizenToken: owner.citizenToken,
        visibility: "private",
        config: {
          baseUrl: "http://127.0.0.1:2234/v1/",
          model: "qwen-owner",
        },
      }),
    },
  );
  assert.equal(patchResponse.status, 200);
  const patched = await patchResponse.json();
  assert.equal(patched.visibility, "private");
  assert.equal(patched.config.baseUrl, "http://127.0.0.1:2234/v1");
  assert.equal(patched.config.model, "qwen-owner");

  const sharedListAfterPatchResponse = await app.request(
    `http://localhost/api/server-configs/shared?citizenId=${peer.citizenId}&citizenToken=${peer.citizenToken}`,
  );
  assert.equal(sharedListAfterPatchResponse.status, 200);
  const sharedListAfterPatch = await sharedListAfterPatchResponse.json();
  assert.equal(
    sharedListAfterPatch.some((item: { id: string }) => item.id === createdConfig.id),
    false,
  );

  const deleteResponse = await app.request(
    `http://localhost/api/me/server-configs/${createdConfig.id}?citizenId=${owner.citizenId}&citizenToken=${owner.citizenToken}`,
    {
      method: "DELETE",
    },
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(
    db.select().from(serverConfigs).where(eq(serverConfigs.id, createdConfig.id)).get(),
    undefined,
  );
});

test("citizen can test an openai-compatible server config before saving", async () => {
  const bootstrapResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "server-config-test@example.com",
      globalDisplayName: "ServerConfigTest",
    }),
  });
  const citizen = await bootstrapResponse.json();

  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        id: "chatcmpl_test",
        choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const testResponse = await app.request("http://localhost/api/me/server-configs/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: citizen.citizenId,
        citizenToken: citizen.citizenToken,
        backendType: "openai_compatible",
        config: {
          baseUrl: "http://127.0.0.1:1234/v1/",
          model: "qwen-test",
          apiKey: "secret-token",
        },
      }),
    });

    assert.equal(testResponse.status, 200);
    assert.deepEqual(await testResponse.json(), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:1234/v1/chat/completions");
    assert.deepEqual(calls[0]?.init?.headers, {
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer secret-token",
    });
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      model: "qwen-test",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("server config test returns backend errors clearly", async () => {
  const bootstrapResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "server-config-test-fail@example.com",
      globalDisplayName: "ServerConfigTestFail",
    }),
  });
  const citizen = await bootstrapResponse.json();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('{"error":"bad model"}', {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const testResponse = await app.request("http://localhost/api/me/server-configs/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizenId: citizen.citizenId,
        citizenToken: citizen.citizenToken,
        backendType: "openai_compatible",
        config: {
          baseUrl: "http://127.0.0.1:1234/v1/",
          model: "missing-model",
        },
      }),
    });

    assert.equal(testResponse.status, 400);
    assert.deepEqual(await testResponse.json(), {
      error: 'openai-compatible backend request failed (400): {"error":"bad model"}',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("citizen can create an openai-compatible private assistant from a shared server config", async () => {
  const ownerResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "shared-config-owner@example.com",
      globalDisplayName: "SharedOwner",
    }),
  });
  const consumerResponse = await app.request("http://localho../api/citizens/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "shared-config-consumer@example.com",
      globalDisplayName: "SharedConsumer",
    }),
  });
  const owner = await ownerResponse.json();
  const consumer = await consumerResponse.json();

  const configCreateResponse = await app.request("http://localhost/api/me/server-configs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: owner.citizenId,
      citizenToken: owner.citizenToken,
      name: "Shared Assistant Config",
      backendType: "openai_compatible",
      visibility: "shared",
      config: {
        baseUrl: "http://127.0.0.1:3333/v1/",
        model: "shared-qwen",
        apiKey: "shared-secret",
      },
    }),
  });
  assert.equal(configCreateResponse.status, 201);
  const createdConfig = await configCreateResponse.json();

  const createAssistantResponse = await app.request("http://localhost/api/me/assistants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: consumer.citizenId,
      citizenToken: consumer.citizenToken,
      name: "SharedAPIAssistant",
      serverConfigId: createdConfig.id,
    }),
  });

  assert.equal(createAssistantResponse.status, 201);
  const assistant = await createAssistantResponse.json();
  assert.equal(assistant.backendType, "openai_compatible");

  const storedAssistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, assistant.id))
    .get();
  assert.equal(storedAssistant?.ownerCitizenId, consumer.citizenId);
  assert.equal(
    storedAssistant?.backendConfig,
    JSON.stringify({
      baseUrl: "http://127.0.0.1:3333/v1",
      model: "shared-qwen",
      apiKey: "shared-secret",
    }),
  );

  const storedBinding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.privateAssistantId, assistant.id))
    .get();
  assert.equal(storedBinding?.backendType, "openai_compatible");
  assert.match(storedBinding?.backendThreadId ?? "", /^oai_/);
});

test("uploads draft attachments and sends an attachment-only message", async () => {
  const roomId = "room_message_attachments";
  const createdAt = new Date("2026-03-25T00:30:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Attachment Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values({
    id: "mem_attachment_sender",
    roomId,
    type: "human",
    roleKind: "none",
    displayName: "AttachmentSender",
    ownerMemberId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt,
  }).run();

  const wsToken = issueWsToken("mem_attachment_sender", roomId);
  const formData = new FormData();
  formData.set("senderMemberId", "mem_attachment_sender");
  formData.set("wsToken", wsToken);
  formData.append("files", new File(["alpha"], "alpha.txt", { type: "text/plain" }));
  formData.append("files", new File(["beta"], "beta.png", { type: "image/png" }));

  const uploadResponse = await app.request(`http://localhost/api/rooms/${roomId}/attachments`, {
    method: "POST",
    body: formData,
  });

  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()) as Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    url: string;
  }>;
  assert.equal(uploaded.length, 2);
  assert.match(uploaded[0]!.url, /^\/api\/attachments\/.+\/content$/);

  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_attachment_sender",
      wsToken,
      content: "",
      attachmentIds: uploaded.map((attachment) => attachment.id),
    }),
  });

  assert.equal(messageResponse.status, 201);
  const createdMessage = (await messageResponse.json()) as {
    id: string;
    content: string;
    attachments: Array<{ id: string; name: string; url: string }>;
  };
  assert.equal(createdMessage.content, "");
  assert.equal(createdMessage.attachments.length, 2);

  const roomMessages = await app.request(`http://localhost/api/rooms/${roomId}/messages`);
  const listedMessages = (await roomMessages.json()) as Array<{
    id: string;
    attachments: Array<{ id: string }>;
  }>;
  assert.equal(listedMessages.length, 1);
  assert.deepEqual(
    listedMessages[0]?.attachments.map((attachment) => attachment.id).sort(),
    uploaded.map((attachment) => attachment.id).sort(),
  );

  const storedAttachments = db
    .select()
    .from(messageAttachments)
    .where(eq(messageAttachments.roomId, roomId))
    .all();
  assert.equal(storedAttachments.length, 2);
  assert.ok(storedAttachments.every((attachment) => attachment.messageId === createdMessage.id));

  const contentResponse = await app.request(`http://localhost${uploaded[1]!.url}`);
  assert.equal(contentResponse.status, 200);
  assert.equal(contentResponse.headers.get("content-type"), "image/png");
  assert.match(contentResponse.headers.get("content-disposition") ?? "", /^inline;/);
  assert.equal(contentResponse.headers.get("x-content-type-options"), "nosniff");
});

test("creates a quoted reply and rejects cross-room reply targets", async () => {
  const roomId = "room_message_reply";
  const otherRoomId = "room_message_reply_other";
  const createdAt = new Date("2026-03-25T00:35:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Reply Room",
    inviteToken: createInviteToken(),
  });
  seedRoom({
    roomId: otherRoomId,
    name: "Other Reply Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_reply_sender",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "ReplySender",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_reply_other",
      roomId: otherRoomId,
      type: "human",
      roleKind: "none",
      displayName: "ReplyOther",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  db.insert(messages).values([
    {
      id: "msg_reply_base",
      roomId,
      senderMemberId: "mem_reply_sender",
      messageType: "user_text",
      content: "Base message",
      replyToMessageId: null,
      createdAt,
    },
    {
      id: "msg_reply_other_room",
      roomId: otherRoomId,
      senderMemberId: "mem_reply_other",
      messageType: "user_text",
      content: "Other room message",
      replyToMessageId: null,
      createdAt,
    },
  ]).run();

  const wsToken = issueWsToken("mem_reply_sender", roomId);

  const successResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_reply_sender",
      wsToken,
      content: "Quoted reply",
      replyToMessageId: "msg_reply_base",
    }),
  });

  assert.equal(successResponse.status, 201);
  const createdReply = (await successResponse.json()) as { replyToMessageId: string | null };
  assert.equal(createdReply.replyToMessageId, "msg_reply_base");

  const rejectedResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_reply_sender",
      wsToken,
      content: "Invalid quoted reply",
      replyToMessageId: "msg_reply_other_room",
    }),
  });

  assert.equal(rejectedResponse.status, 409);
  assert.deepEqual(await rejectedResponse.json(), {
    error: "reply target not found in room",
  });
});

test("replying to an agent message implicitly targets that agent when no explicit mention is present", async () => {
  const roomId = "room_reply_agent_implicit";
  const createdAt = new Date("2026-03-25T00:37:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Implicit Reply Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_reply_human",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "ReplyHuman",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_reply_agent",
      roomId,
      type: "agent",
      roleKind: "independent",
      displayName: "账本助理",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: ["--input-type=module", "-e", "process.stdout.write('ok')"],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  db.insert(messages).values({
    id: "msg_agent_reply_base",
    roomId,
    senderMemberId: "mem_reply_agent",
    messageType: "agent_text",
    content: "我在，有什么要处理？",
    replyToMessageId: null,
    createdAt,
  }).run();

  const wsToken = issueWsToken("mem_reply_human", roomId);

  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_reply_human",
      wsToken,
      content: "继续处理刚才那件事",
      replyToMessageId: "msg_agent_reply_base",
    }),
  });

  assert.equal(response.status, 201);

  const mention = db
    .select()
    .from(mentions)
    .where(eq(mentions.messageId, (await response.json() as { id: string }).id))
    .get();
  assert.equal(mention?.targetMemberId, "mem_reply_agent");
});

test("rejects oversized attachment uploads on the server", async () => {
  const roomId = "room_attachment_limits";
  const createdAt = new Date("2026-03-25T00:40:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Attachment Limits Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values({
    id: "mem_attachment_limits",
    roomId,
    type: "human",
    roleKind: "none",
    displayName: "AttachmentLimits",
    ownerMemberId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt,
  }).run();

  const wsToken = issueWsToken("mem_attachment_limits", roomId);
  const oversized = "x".repeat(5 * 1024 * 1024 + 1);
  const formData = new FormData();
  formData.set("senderMemberId", "mem_attachment_limits");
  formData.set("wsToken", wsToken);
  formData.append(
    "files",
    new File([oversized], "too-large.bin", { type: "application/octet-stream" }),
  );

  const response = await app.request(`http://localhost/api/rooms/${roomId}/attachments`, {
    method: "POST",
    body: formData,
  });

  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /exceeds/i);
  assert.equal(
    db.select().from(messageAttachments).where(eq(messageAttachments.roomId, roomId)).all().length,
    0,
  );
});

test("rejects unsupported attachment mime types on the server", async () => {
  const roomId = "room_attachment_type_limits";
  const createdAt = new Date("2026-03-25T00:45:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Attachment Type Limits Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values({
    id: "mem_attachment_type_limits",
    roomId,
    type: "human",
    roleKind: "none",
    displayName: "AttachmentTypeLimits",
    ownerMemberId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt,
  }).run();

  const wsToken = issueWsToken("mem_attachment_type_limits", roomId);
  const formData = new FormData();
  formData.set("senderMemberId", "mem_attachment_type_limits");
  formData.set("wsToken", wsToken);
  formData.append("files", new File(["{}"], "payload.html", { type: "text/html" }));

  const response = await app.request(`http://localhost/api/rooms/${roomId}/attachments`, {
    method: "POST",
    body: formData,
  });

  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /unsupported type/i);
  assert.equal(
    db.select().from(messageAttachments).where(eq(messageAttachments.roomId, roomId)).all().length,
    0,
  );
});

test("serves non-preview attachments as downloads with sanitized filenames", async () => {
  const roomId = "room_attachment_download_headers";
  const createdAt = new Date("2026-03-25T00:50:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Attachment Download Headers Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values({
    id: "mem_attachment_download_headers",
    roomId,
    type: "human",
    roleKind: "none",
    displayName: "AttachmentDownloadHeaders",
    ownerMemberId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "online",
    createdAt,
  }).run();

  const wsToken = issueWsToken("mem_attachment_download_headers", roomId);
  const formData = new FormData();
  formData.set("senderMemberId", "mem_attachment_download_headers");
  formData.set("wsToken", wsToken);
  formData.append("files", new File(["notes"], "../bad\"name.txt", { type: "text/plain" }));

  const uploadResponse = await app.request(`http://localhost/api/rooms/${roomId}/attachments`, {
    method: "POST",
    body: formData,
  });

  assert.equal(uploadResponse.status, 201);
  const [uploaded] = (await uploadResponse.json()) as Array<{ url: string; name: string }>;
  assert.equal(uploaded?.name, "bad_name.txt");

  const contentResponse = await app.request(`http://localhost${uploaded!.url}`);
  assert.equal(contentResponse.status, 200);
  assert.equal(contentResponse.headers.get("content-type"), "text/plain");
  assert.match(contentResponse.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.match(contentResponse.headers.get("content-disposition") ?? "", /filename="bad_name.txt"/);
  assert.equal(contentResponse.headers.get("x-content-type-options"), "nosniff");
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
  const mention = db
    .select()
    .from(mentions)
    .where(eq(mentions.targetMemberId, "mem_assistant"))
    .get();
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

  const listedMessagesResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`);
  const listedMessages = (await listedMessagesResponse.json()) as Array<{
    messageType: string;
    systemData: { kind: string; title: string } | null;
  }>;
  const offlineSystemMessage = listedMessages.find(
    (message) => message.systemData?.kind === "approval_owner_offline",
  );
  assert.equal(offlineSystemMessage?.systemData?.kind, "approval_owner_offline");
  assert.equal(offlineSystemMessage?.systemData?.title, "Owner unavailable");
});

test("mentioning an assistant keeps approval pending when the owner citizen is online", async () => {
  const roomId = "room_owner_principal_online";
  const createdAt = new Date("2026-03-25T01:10:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Owner Citizen Online Room",
    inviteToken: createInviteToken(),
  });

  db.insert(citizens).values({
    id: "prn_owner_principal_online",
    kind: "human",
    loginKey: "owner-principal-online@example.com",
    globalDisplayName: "Owner",
    backendType: null,
    backendThreadId: null,
    backendConfig: null,
    status: "offline",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_requester_principal_online",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Requester",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_owner_principal_online",
      roomId,
      citizenId: "prn_owner_principal_online",
      type: "human",
      roleKind: "none",
      displayName: "Owner",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "offline",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_assistant_principal_online",
      roomId,
      citizenId: null,
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistB",
      ownerMemberId: "mem_owner_principal_online",
      sourcePrivateAssistantId: null,
      adapterType: "local_process",
      adapterConfig: "{\"command\":\"node\"}",
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  const requesterWsToken = issueWsToken("mem_requester_principal_online", roomId);
  const ownerPrincipalToken = issueCitizenToken("prn_owner_principal_online");
  const disconnectOwner = markCitizenOnline("prn_owner_principal_online", ownerPrincipalToken);

  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_principal_online",
      wsToken: requesterWsToken,
      content: "@AssistB please help",
    }),
  });

  assert.equal(response.status, 201);

  const approval = db.select().from(approvals).where(eq(approvals.roomId, roomId)).get();
  const session = db.select().from(agentSessions).where(eq(agentSessions.roomId, roomId)).get();
  const mention = db.select().from(mentions).where(eq(mentions.targetMemberId, "mem_assistant_principal_online")).get();
  const listedMessagesResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`);
  const listedMessages = (await listedMessagesResponse.json()) as Array<{
    messageType: string;
    systemData: { kind: string; title: string } | null;
  }>;

  assert.equal(approval?.status, "pending");
  assert.equal(session?.status, "waiting_approval");
  assert.equal(mention?.status, "pending_approval");
  assert.equal(listedMessages.some((message) => message.systemData?.kind === "approval_owner_offline"), false);
  assert.equal(listedMessages.some((message) => message.messageType === "approval_request"), true);

  disconnectOwner();
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

test("timed authorization lets the requester reuse the same assistant without a second approval", async () => {
  const roomId = "room_authorization_window";
  const createdAt = new Date("2026-03-25T02:30:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Authorization Window Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_auth_window",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterWindow",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_owner_auth_window",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "OwnerWindow",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_assistant_auth_window",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistWindow",
      ownerMemberId: "mem_owner_auth_window",
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write('window agent:' + text.trim()));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_auth_window", roomId);
  const ownerToken = issueWsToken("mem_owner_auth_window", roomId);
  const closeOwnerSocket = markMemberOnline("mem_owner_auth_window", roomId, ownerToken);

  const firstResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_auth_window",
      wsToken: requesterToken,
      content: "@AssistWindow first pass",
    }),
  });

  assert.equal(firstResponse.status, 201);

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
        actorMemberId: "mem_owner_auth_window",
        wsToken: ownerToken,
        grantDuration: "10_minutes",
      }),
    },
  );

  assert.equal(approveResponse.status, 200);

  await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .all(),
    (value) => value.filter((session) => session.status === "completed").length >= 1,
  );

  closeOwnerSocket();

  const secondResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_auth_window",
      wsToken: requesterToken,
      content: "@AssistWindow second pass",
    }),
  });

  assert.equal(secondResponse.status, 201);

  const sessions = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .all(),
    (value) => value.filter((session) => session.status === "completed").length >= 2,
  );
  const activeApprovalCount = db
    .select()
    .from(approvals)
    .where(eq(approvals.roomId, roomId))
    .all().length;
  const authorization = db
    .select()
    .from(agentAuthorizations)
    .where(eq(agentAuthorizations.roomId, roomId))
    .get();

  assert.equal(activeApprovalCount, 1);
  assert.equal(sessions.length, 2);
  assert.equal(authorization?.grantDuration, "10_minutes");
  assert.equal(authorization?.remainingUses, null);
});

test("single-use authorization requires a fresh approval on the next request", async () => {
  const roomId = "room_authorization_once";
  const createdAt = new Date("2026-03-25T02:45:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Authorization Once Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_auth_once",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterOnce",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_owner_auth_once",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "OwnerOnce",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_assistant_auth_once",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistOnce",
      ownerMemberId: "mem_owner_auth_once",
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write('once agent:' + text.trim()));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_auth_once", roomId);
  const ownerToken = issueWsToken("mem_owner_auth_once", roomId);
  const closeOwnerSocket = markMemberOnline("mem_owner_auth_once", roomId, ownerToken);

  const firstResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_auth_once",
      wsToken: requesterToken,
      content: "@AssistOnce first pass",
    }),
  });

  assert.equal(firstResponse.status, 201);

  const pendingApproval = db
    .select()
    .from(approvals)
    .where(eq(approvals.roomId, roomId))
    .get();

  const approveResponse = await app.request(
    `http://localhost/api/approvals/${pendingApproval?.id}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorMemberId: "mem_owner_auth_once",
        wsToken: ownerToken,
        grantDuration: "once",
      }),
    },
  );

  assert.equal(approveResponse.status, 200);

  await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .all(),
    (value) => value.filter((session) => session.status === "completed").length >= 1,
  );

  closeOwnerSocket();

  const secondResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_auth_once",
      wsToken: requesterToken,
      content: "@AssistOnce second pass",
    }),
  });

  assert.equal(secondResponse.status, 201);

  const secondApprovalSet = await waitFor(
    () =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.roomId, roomId))
        .all(),
    (value) => value.length >= 2,
  );
  assert.equal(secondApprovalSet.length, 2);

  const thirdResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_auth_once",
      wsToken: requesterToken,
      content: "@AssistOnce third pass",
    }),
  });

  assert.equal(thirdResponse.status, 201);

  const finalApproval = await waitFor(
    () =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.roomId, roomId))
        .all(),
    (value) => value.length >= 3,
  );
  const authorization = db
    .select()
    .from(agentAuthorizations)
    .where(eq(agentAuthorizations.roomId, roomId))
    .get();

  assert.equal(finalApproval.length, 3);
  assert.equal(authorization?.remainingUses, 0);
  assert.notEqual(authorization?.revokedAt, null);
});

test("approve returns 400 when grantDuration is invalid", async () => {
  const roomId = "room_invalid_grant_duration";
  const createdAt = new Date("2026-03-25T02:50:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Invalid Grant Duration Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_invalid_grant",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterInvalidGrant",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_owner_invalid_grant",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "OwnerInvalidGrant",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_assistant_invalid_grant",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistInvalidGrant",
      ownerMemberId: "mem_owner_invalid_grant",
      adapterType: "local_process",
      adapterConfig: "{\"command\":\"node\"}",
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_invalid_grant", roomId);
  const ownerToken = issueWsToken("mem_owner_invalid_grant", roomId);
  const closeOwnerSocket = markMemberOnline("mem_owner_invalid_grant", roomId, ownerToken);

  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_invalid_grant",
      wsToken: requesterToken,
      content: "@AssistInvalidGrant please help",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pendingApproval = db
    .select()
    .from(approvals)
    .where(eq(approvals.roomId, roomId))
    .get();

  const approveResponse = await app.request(
    `http://localhost/api/approvals/${pendingApproval?.id}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorMemberId: "mem_owner_invalid_grant",
        wsToken: ownerToken,
        grantDuration: "bad_value",
      }),
    },
  );

  assert.equal(approveResponse.status, 400);
  assert.deepEqual(await approveResponse.json(), {
    error: "invalid grantDuration",
  });

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

test("assistant replies can mention an independent agent and trigger a follow-up session", async () => {
  const roomId = "room_assistant_followup_chain";
  const createdAt = new Date("2026-03-25T03:40:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Assistant Followup Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_assistant_followup",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterFollowup",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_owner_assistant_followup",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "OwnerFollowup",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_beta_assistant_followup",
      roomId,
      type: "agent",
      roleKind: "independent",
      displayName: "BetaFollowup",
      ownerMemberId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write('beta followup:' + text.trim()));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_assistant_followup",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistFollowup",
      ownerMemberId: "mem_owner_assistant_followup",
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({ type: 'completed', action: { content: 'Please take the next turn.', mentionedDisplayNames: ['BetaFollowup'] } }) + '\\n');",
        ],
        inputFormat: "text",
        outputFormat: "jsonl",
      }),
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_assistant_followup", roomId);
  const ownerToken = issueWsToken("mem_owner_assistant_followup", roomId);
  markMemberOnline("mem_owner_assistant_followup", roomId, ownerToken);

  const firstResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_assistant_followup",
      wsToken: requesterToken,
      content: "@AssistFollowup please coordinate",
    }),
  });

  assert.equal(firstResponse.status, 201);

  const pendingApproval = db
    .select()
    .from(approvals)
    .where(eq(approvals.roomId, roomId))
    .get();
  assert.ok(pendingApproval);

  const approveResponse = await app.request(
    `http://localhost/api/approvals/${pendingApproval?.id}/approve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorMemberId: "mem_owner_assistant_followup",
        wsToken: ownerToken,
        grantDuration: "once",
      }),
    },
  );
  assert.equal(approveResponse.status, 200);

  const completedSessions = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .all(),
    (value) => value.filter((session) => session.status === "completed").length >= 2,
  );

  const betaMention = db
    .select()
    .from(mentions)
    .where(eq(mentions.targetMemberId, "mem_beta_assistant_followup"))
    .get();

  assert.ok(betaMention);
  assert.ok(completedSessions.some((session) => session.agentMemberId === "mem_assistant_followup"));
  assert.ok(completedSessions.some((session) => session.agentMemberId === "mem_beta_assistant_followup"));
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
  assert.equal(session?.kind, "message_reply");
  assert.equal(mention?.status, "triggered");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "agent_text" &&
        /independent agent:/i.test(message.content),
    ),
  );
});

test("agent prompts exclude hidden offline private assistants from the room roster", async () => {
  const roomId = "room_hidden_offline_private_assistant_prompt";
  const createdAt = new Date("2026-03-25T04:05:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Hidden Assistant Prompt Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_hidden_prompt",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterHiddenPrompt",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      createdAt,
    },
    {
      id: "mem_agent_visible_prompt",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "VisibleAssistant",
      ownerMemberId: "mem_requester_hidden_prompt",
      sourcePrivateAssistantId: "pa_visible_prompt",
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write(text));",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "online",
      membershipStatus: "active",
      createdAt,
    },
    {
      id: "mem_agent_hidden_prompt",
      roomId,
      type: "agent",
      roleKind: "assistant",
      displayName: "HiddenOfflineAssistant",
      ownerMemberId: "mem_requester_hidden_prompt",
      sourcePrivateAssistantId: "pa_hidden_prompt",
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdout.write('hidden');",
        ],
        inputFormat: "text",
      }),
      presenceStatus: "offline",
      membershipStatus: "active",
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_hidden_prompt", roomId);

  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_hidden_prompt",
      wsToken: requesterToken,
      content: "@VisibleAssistant who is here?",
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
  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();
  const agentReply = roomMessages.find(
    (message) => message.messageType === "agent_text" && message.senderMemberId === "mem_agent_visible_prompt",
  );

  assert.equal(session?.status, "completed");
  assert.ok(agentReply);
  assert.match(agentReply!.content, /Active room members:/);
  assert.match(agentReply!.content, /RequesterHiddenPrompt/);
  assert.match(agentReply!.content, /VisibleAssistant/);
  assert.doesNotMatch(agentReply!.content, /HiddenOfflineAssistant/);
});

test("local independent agent can commit an attachment-only reply from a unified action", async () => {
  const roomId = "room_local_agent_attachment_action";
  const createdAt = new Date("2026-03-25T04:10:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Local Agent Attachment Action Room",
    inviteToken: createInviteToken(),
  });

  db.insert(members).values([
    {
      id: "mem_requester_local_attachment_action",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterAttachmentAction",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_agent_local_attachment_action",
      roomId,
      type: "agent",
      roleKind: "independent",
      displayName: "FileAgent",
      ownerMemberId: null,
      adapterType: "local_process",
      adapterConfig: JSON.stringify({
        command: "node",
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({ type: 'completed', action: { attachments: [{ name: 'report.txt', mimeType: 'text/plain', contentBase64: Buffer.from('report body').toString('base64') }] } }) + '\\n');",
        ],
        inputFormat: "text",
        outputFormat: "jsonl",
      }),
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_requester_local_attachment_action", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_local_attachment_action",
      wsToken: requesterToken,
      content: "@FileAgent send the report file",
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
  assert.equal(session?.agentMemberId, "mem_agent_local_attachment_action");

  const agentMessage = db
    .select()
    .from(messages)
    .where(eq(messages.senderMemberId, "mem_agent_local_attachment_action"))
    .get();
  assert.equal(agentMessage?.content, "");

  const attachedRows = db
    .select()
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, agentMessage?.id ?? ""))
    .all();
  assert.equal(attachedRows.length, 1);
  assert.equal(attachedRows[0]?.originalName, "report.txt");
  assert.equal(attachedRows[0]?.mimeType, "text/plain");
});

test("private assistant projections reject concurrent runs across rooms for the same asset", async () => {
  const createdAt = new Date("2026-03-25T04:50:00.000Z").toISOString();

  db.insert(rooms).values([
    {
      id: "room_private_concurrent_a",
      name: "Private Concurrent A",
      inviteToken: createInviteToken(),
      status: "active",
      createdAt,
    },
    {
      id: "room_private_concurrent_b",
      name: "Private Concurrent B",
      inviteToken: createInviteToken(),
      status: "active",
      createdAt,
    },
  ]).run();

  db.insert(members).values([
    {
      id: "mem_private_requester_a",
      roomId: "room_private_concurrent_a",
      type: "human",
      roleKind: "none",
      displayName: "RequesterA",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_private_requester_b",
      roomId: "room_private_concurrent_b",
      type: "human",
      roleKind: "none",
      displayName: "RequesterB",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_private_assistant_a",
      roomId: "room_private_concurrent_a",
      citizenId: null,
      type: "agent",
      roleKind: "assistant",
      displayName: "SharedPrivateAgent",
      ownerMemberId: "mem_private_requester_a",
      sourcePrivateAssistantId: "pa_private_concurrent",
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_private_assistant_b",
      roomId: "room_private_concurrent_b",
      citizenId: null,
      type: "agent",
      roleKind: "assistant",
      displayName: "SharedPrivateAgent",
      ownerMemberId: "mem_private_requester_b",
      sourcePrivateAssistantId: "pa_private_concurrent",
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  db.insert(messages).values({
    id: "msg_private_trigger_a",
    roomId: "room_private_concurrent_a",
    senderMemberId: "mem_private_requester_a",
    messageType: "user_text",
    content: "@SharedPrivateAgent first task",
    systemData: null,
    replyToMessageId: null,
    createdAt,
  }).run();

  db.insert(agentSessions).values({
    id: "ags_private_concurrent_existing",
    roomId: "room_private_concurrent_a",
    agentMemberId: "mem_private_assistant_a",
    triggerMessageId: "msg_private_trigger_a",
    requesterMemberId: "mem_private_requester_a",
    approvalId: null,
    approvalRequired: false,
    status: "running",
    startedAt: createdAt,
    endedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_private_requester_b", "room_private_concurrent_b");
  const response = await app.request("http://localhost/api/rooms/room_private_concurrent_b/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_private_requester_b",
      wsToken: requesterToken,
      content: "@SharedPrivateAgent second task",
    }),
  });

  assert.equal(response.status, 201);

  const rejectedSession = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, "room_private_concurrent_b"))
        .get(),
    (value) => value?.status === "failed",
  );

  assert.equal(rejectedSession?.status, "failed");

  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, "room_private_concurrent_b"))
    .all();

  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "system_notice" &&
        message.content === "SharedPrivateAgent is already handling another request in a different room.",
    ),
  );
});

test("private assistant projections do not treat same-room pending sessions as different-room busy", async () => {
  const createdAt = new Date("2026-03-25T05:10:00.000Z").toISOString();

  db.insert(rooms).values({
    id: "room_private_same_room_busy",
    name: "Private Same Room Busy",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_same_room_requester",
      roomId: "room_private_same_room_busy",
      type: "human",
      roleKind: "none",
      displayName: "RequesterSameRoom",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_same_room_assistant",
      roomId: "room_private_same_room_busy",
      citizenId: null,
      type: "agent",
      roleKind: "assistant",
      displayName: "SameRoomAssistant",
      ownerMemberId: "mem_same_room_requester",
      sourcePrivateAssistantId: "pa_same_room_busy",
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  db.insert(messages).values([
    {
      id: "msg_same_room_existing",
      roomId: "room_private_same_room_busy",
      senderMemberId: "mem_same_room_requester",
      messageType: "user_text",
      content: "@SameRoomAssistant first task",
      systemData: null,
      replyToMessageId: null,
      createdAt,
    },
    {
      id: "msg_same_room_new",
      roomId: "room_private_same_room_busy",
      senderMemberId: "mem_same_room_requester",
      messageType: "user_text",
      content: "@SameRoomAssistant second task",
      systemData: null,
      replyToMessageId: null,
      createdAt: new Date("2026-03-25T05:11:00.000Z").toISOString(),
    },
  ]).run();

  db.insert(agentSessions).values({
    id: "ags_same_room_existing",
    roomId: "room_private_same_room_busy",
    agentMemberId: "mem_same_room_assistant",
    triggerMessageId: "msg_same_room_existing",
    requesterMemberId: "mem_same_room_requester",
    approvalId: null,
    approvalRequired: false,
    status: "pending",
    startedAt: null,
    endedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_same_room_requester", "room_private_same_room_busy");
  const response = await app.request("http://localhost/api/rooms/room_private_same_room_busy/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_same_room_requester",
      wsToken: requesterToken,
      content: "@SameRoomAssistant second task",
    }),
  });

  assert.equal(response.status, 201);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, "room_private_same_room_busy"))
    .all();

  assert.ok(
    !roomMessages.some(
      (message) =>
        message.messageType === "system_notice" &&
        message.content === "SameRoomAssistant is already handling another request in a different room.",
    ),
  );
});

test("bridge register creates a reusable bridge identity and heartbeat refreshes it", async () => {
  const registerResponse = await app.request("http://localhost/api/bridges/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeInstanceId: "binst_alice_1",
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
  assert.equal(registered.bridgeInstanceId, "binst_alice_1");

  const storedBridge = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, registered.bridgeId))
    .get();

  assert.equal(storedBridge?.bridgeName, "Alice Laptop");
  assert.equal(storedBridge?.currentInstanceId, "binst_alice_1");
  assert.equal(storedBridge?.status, "online");

  const reconnectResponse = await app.request("http://localhost/api/bridges/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeId: registered.bridgeId,
      bridgeToken: registered.bridgeToken,
      bridgeInstanceId: "binst_alice_2",
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
  assert.equal(reconnected.bridgeInstanceId, "binst_alice_2");

  const heartbeatResponse = await app.request(
    `http://localhost/api/bridges/${registered.bridgeId}/heartbeat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: registered.bridgeToken,
        bridgeInstanceId: "binst_alice_2",
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
  assert.equal(refreshedBridge?.currentInstanceId, "binst_alice_2");
  assert.equal(refreshedBridge?.status, "online");
  assert.match(refreshedBridge?.metadata ?? "", /activeAgents/);

  const preserveHeartbeatResponse = await app.request(
    `http://localhost/api/bridges/${registered.bridgeId}/heartbeat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: registered.bridgeToken,
        bridgeInstanceId: "binst_alice_2",
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
      bridgeInstanceId: "binst_alice_3",
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
  assert.equal(preservedAfterRegister?.currentInstanceId, "binst_alice_3");
  assert.match(preservedAfterRegister?.metadata ?? "", /activeAgents/);

  const staleHeartbeatResponse = await app.request(
    `http://localhost/api/bridges/${registered.bridgeId}/heartbeat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: registered.bridgeToken,
        bridgeInstanceId: "binst_alice_2",
      }),
    },
  );

  assert.equal(staleHeartbeatResponse.status, 409);
  assert.deepEqual(await staleHeartbeatResponse.json(), {
    code: "STALE_BRIDGE_INSTANCE",
    error: "stale bridge instance",
  });
});

test("bridge reconnect with a new instance fails accepted tasks from the old instance", async () => {
  const createdAt = new Date("2026-03-25T04:40:00.000Z").toISOString();

  db.insert(rooms).values({
    id: "room_bridge_reconnect_running",
    name: "Bridge Reconnect Running",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_bridge_reconnect_owner",
      roomId: "room_bridge_reconnect_running",
      type: "human",
      roleKind: "none",
      displayName: "Owner",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
    {
      id: "mem_bridge_reconnect_agent",
      roomId: "room_bridge_reconnect_running",
      type: "agent",
      roleKind: "assistant",
      displayName: "ReconnectAgent",
      ownerMemberId: "mem_bridge_reconnect_owner",
      sourcePrivateAssistantId: "pa_bridge_reconnect_running",
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();

  db.insert(messages).values({
    id: "msg_bridge_reconnect_trigger",
    roomId: "room_bridge_reconnect_running",
    senderMemberId: "mem_bridge_reconnect_owner",
    messageType: "user_text",
    content: "@ReconnectAgent continue",
    replyToMessageId: null,
    createdAt,
  }).run();

  db.insert(localBridges).values({
    id: "brg_bridge_reconnect_running",
    bridgeName: "Reconnect Bridge",
    bridgeToken: "bridge_reconnect_running_token",
    currentInstanceId: "binst_bridge_reconnect_old",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(agentSessions).values({
    id: "ags_bridge_reconnect_running",
    roomId: "room_bridge_reconnect_running",
    agentMemberId: "mem_bridge_reconnect_agent",
    triggerMessageId: "msg_bridge_reconnect_trigger",
    requesterMemberId: "mem_bridge_reconnect_owner",
    approvalId: null,
    approvalRequired: false,
    status: "running",
    startedAt: createdAt,
    endedAt: null,
  }).run();

  db.insert(bridgeTasks).values({
    id: "btsk_bridge_reconnect_running",
    bridgeId: "brg_bridge_reconnect_running",
    sessionId: "ags_bridge_reconnect_running",
    roomId: "room_bridge_reconnect_running",
    agentMemberId: "mem_bridge_reconnect_agent",
    requesterMemberId: "mem_bridge_reconnect_owner",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_reconnect_running",
    cwd: null,
    outputMessageId: "msg_bridge_reconnect_output",
    prompt: "continue",
    contextPayload: "[]",
    status: "accepted",
    createdAt,
    assignedAt: createdAt,
    assignedInstanceId: "binst_bridge_reconnect_old",
    acceptedAt: createdAt,
    acceptedInstanceId: "binst_bridge_reconnect_old",
    completedAt: null,
    failedAt: null,
  }).run();

  const reconnectResponse = await app.request("http://localhost/api/bridges/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeId: "brg_bridge_reconnect_running",
      bridgeToken: "bridge_reconnect_running_token",
      bridgeInstanceId: "binst_bridge_reconnect_new",
      bridgeName: "Reconnect Bridge",
      platform: "macOS",
      version: "0.1.1",
    }),
  });

  assert.equal(reconnectResponse.status, 200);

  const task = db
    .select()
    .from(bridgeTasks)
    .where(eq(bridgeTasks.id, "btsk_bridge_reconnect_running"))
    .get();
  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, "ags_bridge_reconnect_running"))
    .get();
  const allMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, "room_bridge_reconnect_running"))
    .all();

  assert.equal(task?.status, "failed");
  assert.equal(session?.status, "failed");
  assert.match(
    allMessages.at(-1)?.content ?? "",
    /could not be resumed automatically/i,
  );
});

test("bridge heartbeat auto-attaches pending bindings when it is the sole online bridge", async () => {
  const createdAt = new Date("2026-03-25T04:30:00.000Z").toISOString();

  db.update(localBridges).set({ status: "offline" }).run();

  db.insert(localBridges).values({
    id: "brg_auto_attach",
    bridgeName: "Auto Attach Bridge",
    bridgeToken: "bridge_auto_attach_token",
    currentInstanceId: "binst_auto_attach",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_auto_attach",
    kind: "agent",
    loginKey: "agent:auto-attach",
    globalDisplayName: "AutoAttachAgent",
    backendType: "codex_cli",
    backendThreadId: "thread_auto_attach",
    status: "offline",
    createdAt,
  }).run();

  db.insert(agentBindings).values({
    id: "agb_auto_attach",
    citizenId: "prn_auto_attach",
    privateAssistantId: null,
    bridgeId: null,
    backendType: "codex_cli",
    backendThreadId: "thread_auto_attach",
    cwd: null,
    status: "pending_bridge",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const response = await app.request("http://localhost/api/bridges/brg_auto_attach/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_auto_attach_token",
      bridgeInstanceId: "binst_auto_attach",
    }),
  });

  assert.equal(response.status, 200);

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.id, "agb_auto_attach"))
    .get();

  assert.equal(binding?.bridgeId, "brg_auto_attach");
  assert.equal(binding?.status, "active");
  assert.notEqual(binding?.attachedAt, createdAt);
});

test("bridge heartbeat broadcasts member.updated when a stale attached bridge becomes fresh again", async () => {
  const roomId = "room_bridge_heartbeat_recovery";
  const staleSeenAt = new Date(Date.now() - 60_000).toISOString();
  const wsToken = issueWsToken("mem_human_bridge_heartbeat_recovery", roomId);
  const sent: string[] = [];
  const listeners = new Map<string, () => void>();
  const fakeSocket = {
    readyState: WebSocket.OPEN,
    close() {},
    send(payload: string) {
      sent.push(payload);
    },
    on(event: string, handler: () => void) {
      listeners.set(event, handler);
      return this;
    },
  };

  seedRoom({
    roomId,
    name: "Bridge Heartbeat Recovery",
    inviteToken: createInviteToken(),
  });

  db.insert(localBridges).values({
    id: "brg_heartbeat_recovery",
    bridgeName: "Recovery Bridge",
    bridgeToken: "bridge_heartbeat_recovery_token",
    currentInstanceId: "binst_heartbeat_recovery",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: staleSeenAt,
    createdAt: staleSeenAt,
    updatedAt: staleSeenAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_heartbeat_recovery",
    kind: "agent",
    loginKey: "agent:heartbeat-recovery",
    globalDisplayName: "RecoveredAgent",
    backendType: "codex_cli",
    backendThreadId: "thread_heartbeat_recovery",
    status: "offline",
    createdAt: staleSeenAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_human_bridge_heartbeat_recovery",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Owner",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt: staleSeenAt,
    },
    {
      id: "mem_agent_bridge_heartbeat_recovery",
      roomId,
      citizenId: "prn_heartbeat_recovery",
      type: "agent",
      roleKind: "independent",
      displayName: "RecoveredAgent",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      membershipStatus: "active",
      leftAt: null,
      createdAt: staleSeenAt,
    },
  ]).run();

  db.insert(agentBindings).values({
    id: "agb_heartbeat_recovery",
    citizenId: "prn_heartbeat_recovery",
    privateAssistantId: null,
    bridgeId: "brg_heartbeat_recovery",
    backendType: "codex_cli",
    backendThreadId: "thread_heartbeat_recovery",
    cwd: "/tmp/heartbeat-recovery",
    status: "active",
    attachedAt: staleSeenAt,
    detachedAt: null,
  }).run();

  registerSocket(fakeSocket as never, {
    url: `/?roomId=${roomId}&memberId=mem_human_bridge_heartbeat_recovery&wsToken=${wsToken}`,
  } as never);

  const response = await app.request("http://localhost/api/bridges/brg_heartbeat_recovery/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_heartbeat_recovery_token",
      bridgeInstanceId: "binst_heartbeat_recovery",
    }),
  });

  assert.equal(response.status, 200);

  const updatedEvent = sent
    .map((payload) => JSON.parse(payload))
    .find((event) => event.type === "member.updated" && event.payload?.member?.id === "mem_agent_bridge_heartbeat_recovery");

  assert.equal(updatedEvent?.payload?.member?.runtimeStatus, "ready");

  listeners.get("close")?.();
});

test("bridge heartbeat does not auto-attach pending bindings when multiple bridges are online", async () => {
  const createdAt = new Date("2026-03-25T04:45:00.000Z").toISOString();

  db.update(localBridges).set({ status: "offline" }).run();

  db.insert(localBridges).values([
    {
      id: "brg_auto_attach_a",
      bridgeName: "Auto Attach Bridge A",
      bridgeToken: "bridge_auto_attach_a_token",
      currentInstanceId: "binst_auto_attach_a",
      status: "online",
      platform: "macOS",
      version: "0.1.0",
      metadata: null,
      lastSeenAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: "brg_auto_attach_b",
      bridgeName: "Auto Attach Bridge B",
      bridgeToken: "bridge_auto_attach_b_token",
      currentInstanceId: "binst_auto_attach_b",
      status: "online",
      platform: "macOS",
      version: "0.1.0",
      metadata: null,
      lastSeenAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    },
  ]).run();

  db.insert(citizens).values({
    id: "prn_auto_attach_conflict",
    kind: "agent",
    loginKey: "agent:auto-attach-conflict",
    globalDisplayName: "AutoAttachConflict",
    backendType: "codex_cli",
    backendThreadId: "thread_auto_attach_conflict",
    status: "offline",
    createdAt,
  }).run();

  db.insert(agentBindings).values({
    id: "agb_auto_attach_conflict",
    citizenId: "prn_auto_attach_conflict",
    privateAssistantId: null,
    bridgeId: null,
    backendType: "codex_cli",
    backendThreadId: "thread_auto_attach_conflict",
    cwd: null,
    status: "pending_bridge",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const response = await app.request("http://localhost/api/bridges/brg_auto_attach_a/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_auto_attach_a_token",
      bridgeInstanceId: "binst_auto_attach_a",
    }),
  });

  assert.equal(response.status, 200);

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.id, "agb_auto_attach_conflict"))
    .get();

  assert.equal(binding?.bridgeId, null);
  assert.equal(binding?.status, "pending_bridge");
  assert.equal(binding?.attachedAt, createdAt);
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

  db.insert(citizens).values({
    id: "prn_attach_agent",
    kind: "agent",
    loginKey: "agent:attach",
    globalDisplayName: "AttachAgent",
    backendType: "codex_cli",
    backendThreadId: "thread_attach",
    status: "offline",
    createdAt: originalAttachedAt,
  }).run();

  db.insert(members).values({
    id: "mem_attach_agent",
    roomId: "room_attach_binding",
    citizenId: "prn_attach_agent",
    type: "agent",
    roleKind: "independent",
    displayName: "AttachAgent",
    ownerMemberId: null,
    adapterType: "codex_cli",
    adapterConfig: null,
    presenceStatus: "offline",
    createdAt: originalAttachedAt,
  }).run();

  db.insert(agentBindings).values({
    id: "agb_attach",
    citizenId: "prn_attach_agent",
    privateAssistantId: null,
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

  db.insert(citizens).values({
    id: "prn_attach_owner_conflict",
    kind: "agent",
    loginKey: "agent:attach-owner-conflict",
    globalDisplayName: "AttachOwnerConflict",
    backendType: "codex_cli",
    backendThreadId: "thread_attach_owner_conflict",
    status: "offline",
    createdAt,
  }).run();

  db.insert(members).values({
    id: "mem_attach_owner_conflict",
    roomId: "room_attach_owner_conflict",
    citizenId: "prn_attach_owner_conflict",
    type: "agent",
    roleKind: "independent",
    displayName: "AttachOwnerConflict",
    ownerMemberId: null,
    adapterType: "codex_cli",
    adapterConfig: null,
    presenceStatus: "offline",
    createdAt,
  }).run();

  db.insert(agentBindings).values({
    id: "agb_attach_owner_conflict",
    citizenId: "prn_attach_owner_conflict",
    privateAssistantId: null,
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
    code: "AGENT_BINDING_ALREADY_ATTACHED",
    error: "agent binding already attached to another bridge",
  });
});


test("unattached codex binding fails with a local bridge requirement message", async () => {
  const roomId = "room_codex_requires_bridge";
  const createdAt = new Date("2026-03-25T06:00:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Codex Bridge Room",
    inviteToken: createInviteToken(),
  });

  db.insert(citizens).values({
    id: "prn_codex_agent",
    kind: "agent",
    loginKey: "agent:codex-pending",
    globalDisplayName: "CodexAgent",
    backendType: "codex_cli",
    backendThreadId: "thread_codex_pending_bridge",
    status: "offline",
    createdAt,
  }).run();

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
      citizenId: "prn_codex_agent",
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
    citizenId: "prn_codex_agent",
    privateAssistantId: null,
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
  const requesterToken = issueWsToken("mem_requester_bridge_task", roomId);
  const sent: string[] = [];
  const listeners = new Map<string, () => void>();
  const fakeSocket = {
    readyState: WebSocket.OPEN,
    close() {},
    send(payload: string) {
      sent.push(payload);
    },
    on(event: string, handler: () => void) {
      listeners.set(event, handler);
      return this;
    },
  };

  seedRoom({
    roomId,
    name: "Codex Bridge Task Room",
    inviteToken: createInviteToken(),
  });

  db.insert(localBridges).values({
    id: "brg_codex_task",
    bridgeName: "Codex Bridge",
    bridgeToken: "bridge_codex_task_token",
    currentInstanceId: "binst_codex_task",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_codex_bridge_task",
    kind: "agent",
    loginKey: "agent:bridge-task",
    globalDisplayName: "BridgeCodex",
    backendType: "codex_cli",
    backendThreadId: "thread_codex_bridge_task",
    status: "offline",
    createdAt,
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
      citizenId: "prn_codex_bridge_task",
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
    citizenId: "prn_codex_bridge_task",
    privateAssistantId: null,
    bridgeId: "brg_codex_task",
    backendType: "codex_cli",
    backendThreadId: "thread_codex_bridge_task",
    cwd: "/tmp/codex-bridge-task",
    status: "active",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  registerSocket(fakeSocket as never, {
    url: `/?roomId=${roomId}&memberId=mem_requester_bridge_task&wsToken=${requesterToken}`,
  } as never);

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
      bridgeInstanceId: "binst_codex_task",
    }),
  });

  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();
  assert.equal(pulled.task.bridgeId, "brg_codex_task");
  assert.equal(pulled.task.backendThreadId, "thread_codex_bridge_task");
  assert.equal(pulled.task.cwd, "/tmp/codex-bridge-task");
  assert.equal(pulled.task.assignedInstanceId, "binst_codex_task");

  const acceptResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
        bridgeInstanceId: "binst_codex_task",
      }),
    },
  );

  assert.equal(acceptResponse.status, 200);

  const staleDeltaResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/delta`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
        bridgeInstanceId: "binst_stale_codex_task",
        delta: "stale output",
      }),
    },
  );

  assert.equal(staleDeltaResponse.status, 409);
  assert.deepEqual(await staleDeltaResponse.json(), {
    code: "STALE_BRIDGE_INSTANCE",
    error: "stale bridge instance",
  });

  const duplicateAcceptResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
        bridgeInstanceId: "binst_codex_task",
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
        bridgeInstanceId: "binst_codex_task",
        delta: "partial output",
      }),
    },
  );

  assert.equal(deltaResponse.status, 200);

  const reasoningDeltaResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/delta`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
        bridgeInstanceId: "binst_codex_task",
        kind: "reasoning",
        delta: "thinking through the request",
      }),
    },
  );

  assert.equal(reasoningDeltaResponse.status, 200);

  const completeResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
        bridgeInstanceId: "binst_codex_task",
        action: {
          content: "final bridge output",
        },
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
        bridgeInstanceId: "binst_codex_task",
        action: {
          content: "duplicate output",
        },
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
  assert.equal(task?.acceptedInstanceId, "binst_codex_task");
  assert.equal(task?.status, "completed");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "agent_text" &&
        message.content === "final bridge output",
    ),
  );

  const reasoningEvent = sent
    .map((payload) => JSON.parse(payload))
    .find((event) => event.type === "agent.stream.reasoning");

  assert.equal(reasoningEvent?.payload?.sessionId, session?.id);
  assert.equal(reasoningEvent?.payload?.messageId, task?.outputMessageId);
  assert.equal(reasoningEvent?.payload?.delta, "thinking through the request");

  listeners.get("close")?.();
});

test("bridge-completed agent replies can mention another independent agent and trigger a follow-up session", async () => {
  const roomId = "room_bridge_agent_followup";
  const createdAt = new Date("2026-03-25T07:10:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Bridge Followup Room",
    inviteToken: createInviteToken(),
  });

  db.insert(localBridges).values({
    id: "brg_bridge_followup",
    bridgeName: "Bridge Followup",
    bridgeToken: "bridge_followup_token",
    currentInstanceId: "binst_bridge_followup",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(citizens).values([
    {
      id: "prn_bridge_followup_alpha",
      kind: "agent",
      loginKey: "agent:followup-alpha",
      globalDisplayName: "Alpha",
      backendType: "codex_cli",
      backendThreadId: "thread_followup_alpha",
      status: "offline",
      createdAt,
    },
    {
      id: "prn_bridge_followup_beta",
      kind: "agent",
      loginKey: "agent:followup-beta",
      globalDisplayName: "Beta",
      backendType: "codex_cli",
      backendThreadId: "thread_followup_beta",
      status: "offline",
      createdAt,
    },
  ]).run();

  db.insert(members).values([
    {
      id: "mem_bridge_followup_requester",
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
      id: "mem_bridge_followup_alpha",
      roomId,
      citizenId: "prn_bridge_followup_alpha",
      type: "agent",
      roleKind: "independent",
      displayName: "Alpha",
      ownerMemberId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
    {
      id: "mem_bridge_followup_beta",
      roomId,
      citizenId: "prn_bridge_followup_beta",
      type: "agent",
      roleKind: "independent",
      displayName: "Beta",
      ownerMemberId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();

  db.insert(agentBindings).values([
    {
      id: "agb_bridge_followup_alpha",
      citizenId: "prn_bridge_followup_alpha",
      privateAssistantId: null,
      bridgeId: "brg_bridge_followup",
      backendType: "codex_cli",
      backendThreadId: "thread_followup_alpha",
      cwd: "/tmp/followup-alpha",
      status: "active",
      attachedAt: createdAt,
      detachedAt: null,
    },
    {
      id: "agb_bridge_followup_beta",
      citizenId: "prn_bridge_followup_beta",
      privateAssistantId: null,
      bridgeId: "brg_bridge_followup",
      backendType: "codex_cli",
      backendThreadId: "thread_followup_beta",
      cwd: "/tmp/followup-beta",
      status: "active",
      attachedAt: createdAt,
      detachedAt: null,
    },
  ]).run();

  const requesterToken = issueWsToken("mem_bridge_followup_requester", roomId);
  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_bridge_followup_requester",
      wsToken: requesterToken,
      content: "@Alpha please coordinate with Beta",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pullAlpha = await app.request("http://localhost/api/bridges/brg_bridge_followup/tasks/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_followup_token",
      bridgeInstanceId: "binst_bridge_followup",
    }),
  });

  assert.equal(pullAlpha.status, 200);
  const alphaTaskEnvelope = await pullAlpha.json();
  assert.equal(alphaTaskEnvelope.task.agentMemberId, "mem_bridge_followup_alpha");

  const acceptAlpha = await app.request(
    `http://localhost/api/bridges/brg_bridge_followup/tasks/${alphaTaskEnvelope.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_followup_token",
        bridgeInstanceId: "binst_bridge_followup",
      }),
    },
  );
  assert.equal(acceptAlpha.status, 200);

  const completeAlpha = await app.request(
    `http://localhost/api/bridges/brg_bridge_followup/tasks/${alphaTaskEnvelope.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_followup_token",
        bridgeInstanceId: "binst_bridge_followup",
        action: {
          content: "Please answer the requester next",
          mentionedDisplayNames: ["Beta"],
        },
      }),
    },
  );
  assert.equal(completeAlpha.status, 200);

  const betaMention = db
    .select()
    .from(mentions)
    .where(eq(mentions.targetMemberId, "mem_bridge_followup_beta"))
    .get();
  assert.ok(betaMention);

  const sessionsInRoom = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.roomId, roomId))
    .all();
  const betaSession = sessionsInRoom.find((session) => session.agentMemberId === "mem_bridge_followup_beta");
  assert.ok(betaSession);
  assert.equal(betaSession?.status, "pending");

  const pullBeta = await app.request("http://localhost/api/bridges/brg_bridge_followup/tasks/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_followup_token",
      bridgeInstanceId: "binst_bridge_followup",
    }),
  });

  assert.equal(pullBeta.status, 200);
  const betaTaskEnvelope = await pullBeta.json();
  assert.equal(betaTaskEnvelope.task.agentMemberId, "mem_bridge_followup_beta");
});

test("bridge tasks can upload agent-generated attachments and commit an attachment-only message", async () => {
  const roomId = "room_bridge_attachment_commit";
  const createdAt = new Date("2026-03-25T07:20:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Bridge Attachment Room",
    inviteToken: createInviteToken(),
  });

  db.insert(localBridges).values({
    id: "brg_bridge_attachment",
    bridgeName: "Bridge Attachment",
    bridgeToken: "bridge_attachment_token",
    currentInstanceId: "binst_bridge_attachment",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_bridge_attachment",
    kind: "agent",
    loginKey: "agent:bridge-attachment",
    globalDisplayName: "AttachmentAgent",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_attachment",
    status: "offline",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_requester_bridge_attachment",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterAttachment",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_agent_bridge_attachment",
      roomId,
      citizenId: "prn_bridge_attachment",
      type: "agent",
      roleKind: "independent",
      displayName: "AttachmentAgent",
      ownerMemberId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();

  db.insert(agentBindings).values({
    id: "agb_bridge_attachment",
    citizenId: "prn_bridge_attachment",
    privateAssistantId: null,
    bridgeId: "brg_bridge_attachment",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_attachment",
    cwd: "/tmp/bridge-attachment",
    status: "active",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_requester_bridge_attachment", roomId);
  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_bridge_attachment",
      wsToken: requesterToken,
      content: "@AttachmentAgent send the report file",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pullResponse = await app.request("http://localhost/api/bridges/brg_bridge_attachment/tasks/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_attachment_token",
      bridgeInstanceId: "binst_bridge_attachment",
    }),
  });

  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();

  const acceptResponse = await app.request(
    `http://localhost/api/bridges/brg_bridge_attachment/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_attachment_token",
        bridgeInstanceId: "binst_bridge_attachment",
      }),
    },
  );
  assert.equal(acceptResponse.status, 200);

  const uploadResponse = await app.request(
    `http://localhost/api/bridges/brg_bridge_attachment/tasks/${pulled.task.id}/attachments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_attachment_token",
        bridgeInstanceId: "binst_bridge_attachment",
        name: "report.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("report body", "utf8").toString("base64"),
      }),
    },
  );

  assert.equal(uploadResponse.status, 201);
  const uploadResult = await uploadResponse.json();
  assert.ok(uploadResult.attachmentId);

  const completeResponse = await app.request(
    `http://localhost/api/bridges/brg_bridge_attachment/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_attachment_token",
        bridgeInstanceId: "binst_bridge_attachment",
        attachmentIds: [uploadResult.attachmentId],
      }),
    },
  );

  assert.equal(completeResponse.status, 200);

  const committedMessage = db
    .select()
    .from(messages)
    .where(eq(messages.id, pulled.task.outputMessageId))
    .get();
  assert.ok(committedMessage);
  assert.equal(committedMessage?.content, "");

  const attachedRows = db
    .select()
    .from(messageAttachments)
    .where(eq(messageAttachments.messageId, pulled.task.outputMessageId))
    .all();

  assert.equal(attachedRows.length, 1);
  assert.equal(attachedRows[0]?.originalName, "report.txt");
  assert.equal(attachedRows[0]?.mimeType, "text/plain");
});

test("bridge task completion rejects inline generated attachments without uploaded attachmentIds", async () => {
  const roomId = "room_bridge_inline_attachment_reject";
  const createdAt = "2026-03-30T00:00:00.000Z";

  seedRoom({
    roomId,
    name: "Inline Reject Room",
    inviteToken: createInviteToken(),
  });

  db.insert(citizens).values([
    {
      id: "prn_bridge_inline_requester",
      kind: "human",
      loginKey: "human:inline-requester",
      globalDisplayName: "Requester",
      backendType: null,
      backendThreadId: null,
      status: "offline",
      createdAt,
    },
    {
      id: "prn_bridge_inline_agent",
      kind: "agent",
      loginKey: "agent:inline-agent",
      globalDisplayName: "InlineAgent",
      backendType: "codex_cli",
      backendThreadId: "thread_inline_attachment",
      status: "offline",
      createdAt,
    },
  ]).run();

  db.insert(members).values([
    {
      id: "mem_bridge_inline_requester",
      roomId,
      citizenId: "prn_bridge_inline_requester",
      type: "human",
      roleKind: "none",
      displayName: "Requester",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
    {
      id: "mem_bridge_inline_agent",
      roomId,
      citizenId: "prn_bridge_inline_agent",
      type: "agent",
      roleKind: "independent",
      displayName: "InlineAgent",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();
  db
    .insert(localBridges)
    .values({
      id: "brg_inline_attachment",
      bridgeName: "Inline Attachment Bridge",
      bridgeToken: "bridge_inline_attachment_token",
      currentInstanceId: "binst_inline_attachment",
      status: "online",
      platform: "macOS",
      version: "0.1.0",
      metadata: null,
      createdAt,
      lastSeenAt: createdAt,
      updatedAt: createdAt,
    })
    .run();
  db
    .insert(agentBindings)
    .values({
      id: "agb_inline_attachment",
      citizenId: "prn_bridge_inline_agent",
      privateAssistantId: null,
      bridgeId: "brg_inline_attachment",
      backendType: "codex_cli",
      backendThreadId: "thread_inline_attachment",
      cwd: "/tmp/inline-attachment",
      status: "active",
      attachedAt: createdAt,
      detachedAt: null,
    })
    .run();

  const triggerResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_bridge_inline_requester",
      wsToken: issueWsToken("mem_bridge_inline_requester", roomId),
      content: "@InlineAgent please send the file",
    }),
  });
  assert.equal(triggerResponse.status, 201);

  const pullResponse = await app.request("http://localhost/api/bridges/brg_inline_attachment/tasks/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_inline_attachment_token",
      bridgeInstanceId: "binst_inline_attachment",
    }),
  });
  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();
  assert.ok(pulled.task);

  const acceptResponse = await app.request(
    `http://localhost/api/bridges/brg_inline_attachment/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_inline_attachment_token",
        bridgeInstanceId: "binst_inline_attachment",
      }),
    },
  );
  assert.equal(acceptResponse.status, 200);

  const completeResponse = await app.request(
    `http://localhost/api/bridges/brg_inline_attachment/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_inline_attachment_token",
        bridgeInstanceId: "binst_inline_attachment",
        action: {
          content: "file attached",
          attachments: [
            {
              name: "report.txt",
              mimeType: "text/plain",
              contentBase64: Buffer.from("report body", "utf8").toString("base64"),
            },
          ],
        },
      }),
    },
  );
  assert.equal(completeResponse.status, 400);
  assert.match(
    await completeResponse.text(),
    /generated attachments must be uploaded first and referenced by attachmentIds/,
  );
});

test("bridge task completion rejects agent-generated attachments exceeding total size limit", async () => {
  const roomId = "room_bridge_attachment_limit";
  const createdAt = new Date("2026-03-25T07:35:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Bridge Attachment Limit Room",
    inviteToken: createInviteToken(),
  });

  db.insert(localBridges).values({
    id: "brg_bridge_attachment_limit",
    bridgeName: "Bridge Attachment Limit",
    bridgeToken: "bridge_attachment_limit_token",
    currentInstanceId: "binst_bridge_attachment_limit",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_bridge_attachment_limit",
    kind: "agent",
    loginKey: "agent:bridge-attachment-limit",
    globalDisplayName: "AttachmentLimitAgent",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_attachment_limit",
    status: "offline",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_requester_bridge_attachment_limit",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterAttachmentLimit",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_agent_bridge_attachment_limit",
      roomId,
      citizenId: "prn_bridge_attachment_limit",
      type: "agent",
      roleKind: "independent",
      displayName: "AttachmentLimitAgent",
      ownerMemberId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();

  db.insert(agentBindings).values({
    id: "agb_bridge_attachment_limit",
    citizenId: "prn_bridge_attachment_limit",
    privateAssistantId: null,
    bridgeId: "brg_bridge_attachment_limit",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_attachment_limit",
    cwd: "/tmp/bridge-attachment-limit",
    status: "active",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_requester_bridge_attachment_limit", roomId);
  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_bridge_attachment_limit",
      wsToken: requesterToken,
      content: "@AttachmentLimitAgent send all reports",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pullResponse = await app.request("http://localhost/api/bridges/brg_bridge_attachment_limit/tasks/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_attachment_limit_token",
      bridgeInstanceId: "binst_bridge_attachment_limit",
    }),
  });

  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();

  const acceptResponse = await app.request(
    `http://localhost/api/bridges/brg_bridge_attachment_limit/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_attachment_limit_token",
        bridgeInstanceId: "binst_bridge_attachment_limit",
      }),
    },
  );
  assert.equal(acceptResponse.status, 200);

  const attachmentIds: string[] = [];
  const oversizedPayload = Buffer.alloc(5 * 1024 * 1024, "a").toString("base64");

  for (let index = 0; index < 5; index += 1) {
    const uploadResponse = await app.request(
      `http://localhost/api/bridges/brg_bridge_attachment_limit/tasks/${pulled.task.id}/attachments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bridgeToken: "bridge_attachment_limit_token",
          bridgeInstanceId: "binst_bridge_attachment_limit",
          name: `report-${index + 1}.txt`,
          mimeType: "text/plain",
          contentBase64: oversizedPayload,
        }),
      },
    );

    assert.equal(uploadResponse.status, 201);
    const uploadResult = await uploadResponse.json();
    attachmentIds.push(uploadResult.attachmentId);
  }

  const completeResponse = await app.request(
    `http://localhost/api/bridges/brg_bridge_attachment_limit/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_attachment_limit_token",
        bridgeInstanceId: "binst_bridge_attachment_limit",
        attachmentIds,
      }),
    },
  );

  assert.equal(completeResponse.status, 400);
  assert.deepEqual(await completeResponse.json(), {
    error: "attachments exceed 20971520 bytes in total",
  });

  const committedMessage = db
    .select()
    .from(messages)
    .where(eq(messages.id, pulled.task.outputMessageId))
    .get();
  assert.equal(committedMessage, undefined);
});

test("bridge-backed room secretary can silently complete an observe run", async () => {
  const roomId = "room_bridge_secretary_silent";
  const createdAt = new Date("2026-03-25T08:45:00.000Z").toISOString();
  const freshSeenAt = new Date().toISOString();

  db.insert(rooms).values({
    id: roomId,
    name: "Bridge Secretary Silent Room",
    inviteToken: createInviteToken(),
    status: "active",
    secretaryMemberId: "mem_bridge_secretary_silent",
    secretaryMode: "coordinate",
    createdAt,
  }).run();

  db.insert(localBridges).values({
    id: "brg_bridge_secretary_silent",
    bridgeName: "Secretary Bridge",
    bridgeToken: "bridge_secretary_silent_token",
    currentInstanceId: "binst_bridge_secretary_silent",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: freshSeenAt,
    createdAt: freshSeenAt,
    updatedAt: freshSeenAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_bridge_secretary_silent",
    kind: "agent",
    loginKey: "agent:bridge-secretary-silent",
    globalDisplayName: "BridgeSecretary",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_secretary_silent",
    status: "offline",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_human_bridge_secretary_requester",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Requester",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_bridge_secretary_silent",
      roomId,
      citizenId: "prn_bridge_secretary_silent",
      type: "agent",
      roleKind: "independent",
      displayName: "BridgeSecretary",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  db.insert(agentBindings).values({
    id: "agb_bridge_secretary_silent",
    citizenId: "prn_bridge_secretary_silent",
    privateAssistantId: null,
    bridgeId: "brg_bridge_secretary_silent",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_secretary_silent",
    cwd: "/tmp/bridge-secretary-silent",
    status: "active",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_human_bridge_secretary_requester", roomId);
  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_human_bridge_secretary_requester",
      wsToken: requesterToken,
      content: "Just noting that the draft was uploaded.",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pullResponse = await app.request("http://localhost/api/bridges/brg_bridge_secretary_silent/tasks/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_secretary_silent_token",
      bridgeInstanceId: "binst_bridge_secretary_silent",
    }),
  });

  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();

  const acceptResponse = await app.request(
    `http://localhost/api/bridges/brg_bridge_secretary_silent/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_secretary_silent_token",
        bridgeInstanceId: "binst_bridge_secretary_silent",
      }),
    },
  );

  assert.equal(acceptResponse.status, 200);

  const completeResponse = await app.request(
    `http://localhost/api/bridges/brg_bridge_secretary_silent/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_secretary_silent_token",
        bridgeInstanceId: "binst_bridge_secretary_silent",
      }),
    },
  );

  assert.equal(completeResponse.status, 200);

  const session = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .get(),
    (value) => value?.status === "completed",
  );
  assert.equal(session?.agentMemberId, "mem_bridge_secretary_silent");

  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();
  assert.equal(roomMessages.length, 1);
  assert.equal(roomMessages[0]?.senderMemberId, "mem_human_bridge_secretary_requester");
});

test("bridge-backed summarizing secretary can update summary without posting a visible message", async () => {
  const roomId = "room_bridge_secretary_summary_only";
  const createdAt = new Date("2026-03-25T08:47:00.000Z").toISOString();
  const freshSeenAt = new Date().toISOString();

  db.insert(rooms).values({
    id: roomId,
    name: "Bridge Secretary Summary Only Room",
    inviteToken: createInviteToken(),
    status: "active",
    secretaryMemberId: "mem_bridge_secretary_summary",
    secretaryMode: "coordinate_and_summarize",
    createdAt,
  }).run();

  db.insert(localBridges).values({
    id: "brg_bridge_secretary_summary",
    bridgeName: "Secretary Summary Bridge",
    bridgeToken: "bridge_secretary_summary_token",
    currentInstanceId: "binst_bridge_secretary_summary",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: freshSeenAt,
    createdAt: freshSeenAt,
    updatedAt: freshSeenAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_bridge_secretary_summary",
    kind: "agent",
    loginKey: "agent:bridge-secretary-summary",
    globalDisplayName: "BridgeSecretary",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_secretary_summary",
    status: "offline",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_human_bridge_secretary_summary",
      roomId,
      citizenId: null,
      type: "human",
      roleKind: "none",
      displayName: "Requester",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
    {
      id: "mem_bridge_secretary_summary",
      roomId,
      citizenId: "prn_bridge_secretary_summary",
      type: "agent",
      roleKind: "independent",
      displayName: "BridgeSecretary",
      ownerMemberId: null,
      sourcePrivateAssistantId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      membershipStatus: "active",
      leftAt: null,
      createdAt,
    },
  ]).run();

  db.insert(agentBindings).values({
    id: "agb_bridge_secretary_summary",
    citizenId: "prn_bridge_secretary_summary",
    privateAssistantId: null,
    bridgeId: "brg_bridge_secretary_summary",
    backendType: "codex_cli",
    backendThreadId: "thread_bridge_secretary_summary",
    cwd: "/tmp/bridge-secretary-summary",
    status: "active",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_human_bridge_secretary_summary", roomId);
  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_human_bridge_secretary_summary",
      wsToken: requesterToken,
      content: "Please keep track of the current plan.",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pullResponse = await app.request("http://localhost/api/bridges/brg_bridge_secretary_summary/tasks/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_secretary_summary_token",
      bridgeInstanceId: "binst_bridge_secretary_summary",
    }),
  });
  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();

  const acceptResponse = await app.request(
    `http://localhost/api/bridges/brg_bridge_secretary_summary/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_secretary_summary_token",
        bridgeInstanceId: "binst_bridge_secretary_summary",
      }),
    },
  );
  assert.equal(acceptResponse.status, 200);

  const completeResponse = await app.request(
    `http://localhost/api/bridges/brg_bridge_secretary_summary/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_secretary_summary_token",
        bridgeInstanceId: "binst_bridge_secretary_summary",
        summaryText: "Waiting for final milestone draft from Planner.",
      }),
    },
  );
  assert.equal(completeResponse.status, 200);

  const session = await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .get(),
    (value) => value?.status === "completed",
  );
  assert.equal(session?.agentMemberId, "mem_bridge_secretary_summary");

  const roomMessages = db
    .select()
    .from(messages)
    .where(eq(messages.roomId, roomId))
    .all();
  assert.equal(roomMessages.length, 1);

  const storedSummary = db
    .select()
    .from(roomSummaries)
    .where(eq(roomSummaries.roomId, roomId))
    .get();
  assert.equal(storedSummary?.summaryText, "Waiting for final milestone draft from Planner.");
  assert.equal(storedSummary?.sourceMessageId, null);
});

test("attached claude private assistant binding persists refreshed backendThreadId on completion", async () => {
  const roomId = "room_claude_assistant_bridge_task";
  const createdAt = new Date("2026-03-25T07:30:00.000Z").toISOString();

  seedRoom({
    roomId,
    name: "Claude Assistant Bridge Task Room",
    inviteToken: createInviteToken(),
  });

  db.insert(localBridges).values({
    id: "brg_claude_task",
    bridgeName: "Claude Bridge",
    bridgeToken: "bridge_claude_task_token",
    currentInstanceId: "binst_claude_task",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_owner_claude_task",
    kind: "human",
    loginKey: "owner-claude-task@example.com",
    globalDisplayName: "OwnerClaudeTask",
    backendType: null,
    backendThreadId: null,
    status: "online",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_owner_claude_task",
      roomId,
      citizenId: "prn_owner_claude_task",
      type: "human",
      roleKind: "none",
      displayName: "OwnerClaudeTask",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_requester_claude_task",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterClaudeTask",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  const inviteResponse = await app.request("http://localhost/api/me/assistants/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      citizenId: "prn_owner_claude_task",
      citizenToken: issueCitizenToken("prn_owner_claude_task"),
      name: "ClaudeHelper",
      backendType: "claude_code",
    }),
  });

  assert.equal(inviteResponse.status, 201);
  const createdInvite = await inviteResponse.json();

  const acceptResponse = await app.request(
    `http://localhost/api/private-assistant-invites/${createdInvite.inviteToken}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backendThreadId: "thread_claude_task_initial",
      }),
    },
  );

  assert.equal(acceptResponse.status, 201);
  const accepted = await acceptResponse.json();
  assert.ok(accepted.id);

  const attachResponse = await app.request(
    "http://localhost/api/bridges/brg_claude_task/agents/attach",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_claude_task_token",
        privateAssistantId: accepted.id,
        cwd: "/tmp/claude-assistant-task",
      }),
    },
  );

  assert.equal(attachResponse.status, 200);

  const requesterToken = issueWsToken("mem_owner_claude_task", roomId);
  const adoptResponse = await app.request(`http://localhost/api/rooms/${roomId}/assistants/adopt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorMemberId: "mem_owner_claude_task",
      wsToken: requesterToken,
      privateAssistantId: accepted.id,
    }),
  });

  assert.equal(adoptResponse.status, 201);

  const messageResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_owner_claude_task",
      wsToken: requesterToken,
      content: "@ClaudeHelper please help",
    }),
  });

  assert.equal(messageResponse.status, 201);

  const pullResponse = await app.request("http://localhost/api/bridges/brg_claude_task/tasks/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bridgeToken: "bridge_claude_task_token",
      bridgeInstanceId: "binst_claude_task",
    }),
  });

  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();
  assert.equal(pulled.task.backendThreadId, "thread_claude_task_initial");

  const acceptTaskResponse = await app.request(
    `http://localhost/api/bridges/brg_claude_task/tasks/${pulled.task.id}/accept`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_claude_task_token",
        bridgeInstanceId: "binst_claude_task",
      }),
    },
  );

  assert.equal(acceptTaskResponse.status, 200);

  const completeResponse = await app.request(
    `http://localhost/api/bridges/brg_claude_task/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_claude_task_token",
        bridgeInstanceId: "binst_claude_task",
        action: {
          content: "final claude assistant output",
        },
        backendThreadId: "11111111-2222-3333-4444-555555555555",
      }),
    },
  );

  assert.equal(completeResponse.status, 200);

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.privateAssistantId, accepted.id))
    .get();

  assert.equal(binding?.backendThreadId, "11111111-2222-3333-4444-555555555555");

  const storedAssistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, accepted.id))
    .get();

  assert.equal(storedAssistant?.backendThreadId, "thread_claude_task_initial");
});

test("attached codex binding emits a waiting notice when its bridge heartbeat is stale", async () => {
  const roomId = "room_codex_bridge_waiting";
  const staleSeenAt = new Date(Date.now() - 60_000).toISOString();

  seedRoom({
    roomId,
    name: "Codex Bridge Waiting Room",
    inviteToken: createInviteToken(),
  });

  db.insert(localBridges).values({
    id: "brg_codex_waiting",
    bridgeName: "Stale Codex Bridge",
    bridgeToken: "bridge_codex_waiting_token",
    currentInstanceId: "binst_codex_waiting",
    status: "online",
    platform: "macOS",
    version: "0.1.0",
    metadata: null,
    lastSeenAt: staleSeenAt,
    createdAt: staleSeenAt,
    updatedAt: staleSeenAt,
  }).run();

  db.insert(citizens).values({
    id: "prn_codex_waiting",
    kind: "agent",
    loginKey: "agent:waiting",
    globalDisplayName: "WaitingCodex",
    backendType: "codex_cli",
    backendThreadId: "thread_codex_waiting",
    status: "offline",
    createdAt: staleSeenAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_requester_codex_waiting",
      roomId,
      type: "human",
      roleKind: "none",
      displayName: "RequesterWaiting",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt: staleSeenAt,
    },
    {
      id: "mem_codex_waiting",
      roomId,
      citizenId: "prn_codex_waiting",
      type: "agent",
      roleKind: "independent",
      displayName: "WaitingCodex",
      ownerMemberId: null,
      adapterType: "codex_cli",
      adapterConfig: null,
      presenceStatus: "offline",
      createdAt: staleSeenAt,
    },
  ]).run();

  db.insert(agentBindings).values({
    id: "agb_codex_waiting",
    citizenId: "prn_codex_waiting",
    privateAssistantId: null,
    bridgeId: "brg_codex_waiting",
    backendType: "codex_cli",
    backendThreadId: "thread_codex_waiting",
    cwd: "/tmp/codex-waiting",
    status: "active",
    attachedAt: staleSeenAt,
    detachedAt: null,
  }).run();

  const requesterToken = issueWsToken("mem_requester_codex_waiting", roomId);
  const response = await app.request(`http://localhost/api/rooms/${roomId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      senderMemberId: "mem_requester_codex_waiting",
      wsToken: requesterToken,
      content: "@WaitingCodex are you there?",
    }),
  });

  assert.equal(response.status, 201);

  const queuedTask = await waitFor(
    () =>
      db
        .select()
        .from(bridgeTasks)
        .where(eq(bridgeTasks.bridgeId, "brg_codex_waiting"))
        .get(),
    (value) => value?.status === "pending",
  );
  const roomMessages = await waitFor(
    () =>
      db
        .select()
        .from(messages)
        .where(eq(messages.roomId, roomId))
        .all(),
    (value) =>
      value.some(
        (message) =>
          message.messageType === "system_notice" &&
          /waiting for its local bridge to reconnect/i.test(message.content),
      ),
  );

  assert.equal(queuedTask?.status, "pending");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "system_notice" &&
        /waiting for its local bridge to reconnect/i.test(message.content),
    ),
  );

  const listedMessagesResponse = await app.request(`http://localhost/api/rooms/${roomId}/messages`);
  const listedMessages = (await listedMessagesResponse.json()) as Array<{
    messageType: string;
    systemData: { kind: string } | null;
  }>;
  assert.ok(
    listedMessages.some(
      (message) =>
        message.messageType === "system_notice" &&
        message.systemData?.kind === "bridge_waiting",
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
    currentInstanceId: "binst_reclaim_lease",
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
    assignedInstanceId: "binst_old_instance",
    acceptedAt: null,
    acceptedInstanceId: null,
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
        bridgeInstanceId: "binst_reclaim_lease",
      }),
    },
  );

  assert.equal(pullResponse.status, 200);
  const pulled = await pullResponse.json();
  assert.equal(pulled.task?.id, "btsk_reclaim_lease");
  assert.equal(pulled.task?.status, "assigned");
  assert.equal(pulled.task?.assignedInstanceId, "binst_reclaim_lease");
  assert.notEqual(pulled.task?.assignedAt, expiredAssignedAt);
});
