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
  principals,
  rooms,
  members,
  messages,
  mentions,
  approvals,
  agentSessions,
  agentBindings,
  assistantInvites,
  agentAuthorizations,
  bridgeTasks,
  localBridges,
  messageAttachments,
  privateAssistants,
} = schema;
const { createInviteToken } = ids;
const { issuePrincipalToken, issueWsToken, registerSocket } = realtime;

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

function markPrincipalOnline(principalId: string, principalToken: string): () => void {
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
    url: `/?principalId=${principalId}&principalToken=${principalToken}`,
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

test("principal bootstrap creates or restores a human principal and room join can inherit global display name", async () => {
  const bootstrapResponse = await app.request("http://localhost/api/principals/bootstrap", {
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

  const restoredResponse = await app.request("http://localhost/api/principals/bootstrap", {
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
  assert.equal(restoredResult.principalId, bootstrapResult.principalId);
  assert.equal(restoredResult.globalDisplayName, "阿南二号");
  assert.equal(restoredResult.status, "offline");

  const persistedPrincipal = db
    .select()
    .from(principals)
    .where(eq(principals.id, bootstrapResult.principalId))
    .get();
  assert.equal(persistedPrincipal?.globalDisplayName, "阿南二号");

  const roomId = "room_principal_join";
  seedRoom({
    roomId,
    name: "Principal Join Room",
    inviteToken: createInviteToken(),
  });

  const joinResponse = await app.request(`http://localhost/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      principalId: bootstrapResult.principalId,
      principalToken: bootstrapResult.principalToken,
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
        principalId: bootstrapResult.principalId,
        principalToken: bootstrapResult.principalToken,
      }),
    },
  );

  assert.equal(invitedJoinResponse.status, 200);
  const joinResult = await invitedJoinResponse.json();
  assert.equal(joinResult.displayName, "阿南二号");

  const insertedMember = db.select().from(members).where(eq(members.id, joinResult.memberId)).get();
  assert.equal(insertedMember?.principalId, bootstrapResult.principalId);
  assert.equal(insertedMember?.displayName, "阿南二号");
});

test("principal lobby presence follows websocket connection instead of bootstrap", async () => {
  const bootstrapResponse = await app.request("http://localhost/api/principals/bootstrap", {
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
    initialLobby.principals.some((item: { id: string }) => item.id === principal.principalId),
    false,
  );

  const disconnect = markPrincipalOnline(principal.principalId, principal.principalToken);

  const onlinePrincipal = await waitFor(
    () =>
      db.select().from(principals).where(eq(principals.id, principal.principalId)).get(),
    (value) => value?.status === "online",
  );
  assert.equal(onlinePrincipal?.status, "online");

  const onlineLobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(onlineLobbyResponse.status, 200);
  const onlineLobby = await onlineLobbyResponse.json();
  assert.equal(
    onlineLobby.principals.some((item: { id: string }) => item.id === principal.principalId),
    true,
  );

  disconnect();

  const offlinePrincipal = await waitFor(
    () =>
      db.select().from(principals).where(eq(principals.id, principal.principalId)).get(),
    (value) => value?.status === "offline",
  );
  assert.equal(offlinePrincipal?.status, "offline");

  const offlineLobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(offlineLobbyResponse.status, 200);
  const offlineLobby = await offlineLobbyResponse.json();
  assert.equal(
    offlineLobby.principals.some((item: { id: string }) => item.id === principal.principalId),
    false,
  );
});

test("direct room reuses the same two-principal room and room pull adds a lobby principal into an existing room", async () => {
  const aliceResponse = await app.request("http://localhost/api/principals/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "alice-direct@example.com",
      globalDisplayName: "阿南",
    }),
  });
  const bobResponse = await app.request("http://localhost/api/principals/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "human",
      loginKey: "bob-direct@example.com",
      globalDisplayName: "小白",
    }),
  });
  const carolResponse = await app.request("http://localhost/api/principals/bootstrap", {
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
      actorPrincipalId: alice.principalId,
      actorPrincipalToken: alice.principalToken,
      peerPrincipalId: bob.principalId,
    }),
  });

  assert.equal(firstDirectRoomResponse.status, 200);
  const firstDirectRoom = await firstDirectRoomResponse.json();
  assert.equal(firstDirectRoom.reused, false);

  const secondDirectRoomResponse = await app.request("http://localhost/api/direct-rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorPrincipalId: alice.principalId,
      actorPrincipalToken: alice.principalToken,
      peerPrincipalId: bob.principalId,
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
        principalId: alice.principalId,
        principalToken: alice.principalToken,
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
      targetPrincipalId: carol.principalId,
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
  assert.ok(roomMembers.find((member) => member.principalId === carol.principalId));
});

test("agent principal bootstrap exposes runtime-capable lobby presence and creates an independent agent projection", async () => {
  const agentResponse = await app.request("http://localhost/api/principals/bootstrap", {
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
  const humanResponse = await app.request("http://localhost/api/principals/bootstrap", {
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

  const disconnectAgent = markPrincipalOnline(agent.principalId, agent.principalToken);

  const lobbyResponse = await app.request("http://localhost/api/presence/lobby");
  assert.equal(lobbyResponse.status, 200);
  const lobby = await lobbyResponse.json();
  const lobbyAgent = lobby.principals.find((item: { id: string }) => item.id === agent.principalId);
  assert.ok(lobbyAgent);
  assert.equal(lobbyAgent.backendType, "codex_cli");
  assert.equal(lobbyAgent.runtimeStatus, "pending_bridge");

  const directRoomResponse = await app.request("http://localhost/api/direct-rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      actorPrincipalId: agent.principalId,
      actorPrincipalToken: agent.principalToken,
      peerPrincipalId: human.principalId,
    }),
  });

  assert.equal(directRoomResponse.status, 200);
  const directRoom = await directRoomResponse.json();
  const agentMember = db
    .select()
    .from(members)
    .where(eq(members.id, directRoom.join.memberId))
    .get();
  assert.equal(agentMember?.type, "agent");
  assert.equal(agentMember?.roleKind, "independent");
  assert.equal(agentMember?.principalId, agent.principalId);
  assert.equal(agentMember?.adapterType, "codex_cli");

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.backendThreadId, "thread_agent_principal_finance"))
    .get();
  assert.equal(binding?.principalId, agent.principalId);

  disconnectAgent();
});

test("agent principal bootstrap rejects a bound backendThreadId without leaving a principal record", async () => {
  const createdAt = new Date("2026-03-25T00:30:00.000Z").toISOString();

  db.insert(principals).values({
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
    principalId: "prn_existing_bound_agent",
    privateAssistantId: null,
    bridgeId: null,
    backendType: "codex_cli",
    backendThreadId: "thread_bound_conflict",
    cwd: null,
    status: "pending_bridge",
    attachedAt: createdAt,
    detachedAt: null,
  }).run();

  const response = await app.request("http://localhost/api/principals/bootstrap", {
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
    .from(principals)
    .where(eq(principals.loginKey, "agent:new-conflict"))
    .get();
  assert.equal(leakedPrincipal, undefined);
});

test("agent principal bootstrap keeps an existing principal unchanged when backendThreadId is already bound elsewhere", async () => {
  const createdAt = new Date("2026-03-25T00:40:00.000Z").toISOString();

  db.insert(principals).values([
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
      principalId: "prn_existing_update_agent",
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
      principalId: "prn_existing_conflict_agent",
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

  const response = await app.request("http://localhost/api/principals/bootstrap", {
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
    .from(principals)
    .where(eq(principals.id, "prn_existing_update_agent"))
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

test("principal can invite a private codex assistant, accept it, and adopt it into a room", async () => {
  const bootstrapResponse = await app.request("http://localhost/api/principals/bootstrap", {
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
      principalId: principal.principalId,
      principalToken: principal.principalToken,
      name: "账本助理",
      backendType: "codex_cli",
    }),
  });

  assert.equal(inviteResponse.status, 201);
  const privateAssistantInvite = await inviteResponse.json();

  const listedInvitesResponse = await app.request(
    `http://localhost/api/me/assistants/invites?principalId=${principal.principalId}&principalToken=${principal.principalToken}`,
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
    `http://localhost/api/me/assistants?principalId=${principal.principalId}&principalToken=${principal.principalToken}`,
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
      principalId: principal.principalId,
      principalToken: principal.principalToken,
    }),
  });
  assert.equal(joinResponse.status, 403);
  const invitedJoinResponse = await app.request(
    `http://localhost/api/invites/${db.select().from(rooms).where(eq(rooms.id, roomId)).get()!.inviteToken}/join`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: principal.principalId,
        principalToken: principal.principalToken,
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
      principalId: principal.principalId,
      principalToken: principal.principalToken,
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
        principalId: principal.principalId,
        principalToken: principal.principalToken,
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
    `http://localhost/api/me/assistants/${privateAssistant.id}?principalId=${principal.principalId}&principalToken=${principal.principalToken}`,
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

test("single-use authorization is consumed after one reuse", async () => {
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

  await waitFor(
    () =>
      db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.roomId, roomId))
        .all(),
    (value) => value.filter((session) => session.status === "completed").length >= 2,
  );

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
    (value) => value.length >= 2,
  );
  const authorization = db
    .select()
    .from(agentAuthorizations)
    .where(eq(agentAuthorizations.roomId, roomId))
    .get();

  assert.equal(finalApproval.length, 2);
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
      principalId: null,
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
      principalId: null,
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
      principalId: null,
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
    error: "stale bridge instance",
  });
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

  db.insert(principals).values({
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
    principalId: "prn_attach_agent",
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
    principalId: "prn_attach_agent",
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

  db.insert(principals).values({
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
    principalId: "prn_attach_owner_conflict",
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
    principalId: "prn_attach_owner_conflict",
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
    error: "agent binding already attached to another bridge",
  });
});

test("accepted assistant invite can be attached to a bridge by privateAssistantId", async () => {
  const createdAt = new Date("2026-03-25T05:45:00.000Z").toISOString();

  db.insert(rooms).values({
    id: "room_invite_attach",
    name: "Invite Attach Room",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt,
  }).run();

  db.insert(principals).values({
    id: "prn_owner_invite_attach",
    kind: "human",
    loginKey: "owner-invite-attach@example.com",
    globalDisplayName: "OwnerInviteAttach",
    backendType: null,
    backendThreadId: null,
    status: "online",
    createdAt,
  }).run();

  db.insert(members).values({
    id: "mem_owner_invite_attach",
    roomId: "room_invite_attach",
    principalId: "prn_owner_invite_attach",
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
    acceptedPrivateAssistantId: null,
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
  assert.ok(accepted.privateAssistantId);

  const storedInvite = db
    .select()
    .from(assistantInvites)
    .where(eq(assistantInvites.id, "ainv_attach"))
    .get();
  assert.equal(storedInvite?.acceptedPrivateAssistantId, accepted.privateAssistantId);

  const storedAssistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.id, accepted.privateAssistantId))
    .get();
  assert.equal(storedAssistant?.ownerPrincipalId, "prn_owner_invite_attach");
  assert.equal(storedAssistant?.backendThreadId, "thread_invite_attach");

  const attachResponse = await app.request(
    "http://localhost/api/bridges/brg_invite_attach/agents/attach",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_invite_attach_token",
        privateAssistantId: accepted.privateAssistantId,
        cwd: "/tmp/invite-attach",
      }),
    },
  );

  assert.equal(attachResponse.status, 200);

  const binding = db
    .select()
    .from(agentBindings)
    .where(eq(agentBindings.privateAssistantId, accepted.privateAssistantId))
    .get();

  assert.equal(binding?.bridgeId, "brg_invite_attach");
  assert.equal(binding?.status, "active");
  assert.equal(binding?.cwd, "/tmp/invite-attach");
});

test("assistant invite accept reuses the same private assistant asset for the same owner and thread", async () => {
  const createdAt = new Date("2026-03-25T05:55:00.000Z").toISOString();

  db.insert(principals).values({
    id: "prn_owner_reuse",
    kind: "human",
    loginKey: "owner-reuse@example.com",
    globalDisplayName: "OwnerReuse",
    backendType: null,
    backendThreadId: null,
    status: "online",
    createdAt,
  }).run();

  db.insert(rooms).values([
    {
      id: "room_owner_reuse_a",
      name: "Owner Reuse A",
      inviteToken: createInviteToken(),
      status: "active",
      createdAt,
    },
    {
      id: "room_owner_reuse_b",
      name: "Owner Reuse B",
      inviteToken: createInviteToken(),
      status: "active",
      createdAt,
    },
  ]).run();

  db.insert(members).values([
    {
      id: "mem_owner_reuse_a",
      roomId: "room_owner_reuse_a",
      principalId: "prn_owner_reuse",
      type: "human",
      roleKind: "none",
      displayName: "OwnerReuseA",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_owner_reuse_b",
      roomId: "room_owner_reuse_b",
      principalId: "prn_owner_reuse",
      type: "human",
      roleKind: "none",
      displayName: "OwnerReuseB",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  db.insert(assistantInvites).values([
    {
      id: "ainv_reuse_a",
      roomId: "room_owner_reuse_a",
      ownerMemberId: "mem_owner_reuse_a",
      presetDisplayName: "账本助理",
      backendType: "codex_cli",
      inviteToken: "invite_reuse_a",
      status: "pending",
      acceptedMemberId: null,
      acceptedPrivateAssistantId: null,
      createdAt,
      expiresAt: null,
      acceptedAt: null,
    },
    {
      id: "ainv_reuse_b",
      roomId: "room_owner_reuse_b",
      ownerMemberId: "mem_owner_reuse_b",
      presetDisplayName: "另一个名字",
      backendType: "codex_cli",
      inviteToken: "invite_reuse_b",
      status: "pending",
      acceptedMemberId: null,
      acceptedPrivateAssistantId: null,
      createdAt,
      expiresAt: null,
      acceptedAt: null,
    },
  ]).run();

  const firstAcceptResponse = await app.request(
    "http://localhost/api/assistant-invites/invite_reuse_a/accept",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backendThreadId: "thread_owner_reuse",
      }),
    },
  );

  assert.equal(firstAcceptResponse.status, 201);
  const firstAccepted = await firstAcceptResponse.json();

  const secondAcceptResponse = await app.request(
    "http://localhost/api/assistant-invites/invite_reuse_b/accept",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backendThreadId: "thread_owner_reuse",
      }),
    },
  );

  assert.equal(secondAcceptResponse.status, 201);
  const secondAccepted = await secondAcceptResponse.json();

  assert.equal(secondAccepted.privateAssistantId, firstAccepted.privateAssistantId);

  const storedAssistants = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.ownerPrincipalId, "prn_owner_reuse"))
    .all();
  assert.equal(storedAssistants.length, 1);
  assert.equal(storedAssistants[0]?.name, "账本助理");
  assert.equal(storedAssistants[0]?.backendThreadId, "thread_owner_reuse");

  const secondProjection = db
    .select()
    .from(members)
    .where(eq(members.id, secondAccepted.memberId))
    .get();
  assert.equal(secondProjection?.sourcePrivateAssistantId, firstAccepted.privateAssistantId);
  assert.equal(secondProjection?.displayName, "账本助理");

  const firstInvite = db
    .select()
    .from(assistantInvites)
    .where(eq(assistantInvites.id, "ainv_reuse_a"))
    .get();
  const secondInvite = db
    .select()
    .from(assistantInvites)
    .where(eq(assistantInvites.id, "ainv_reuse_b"))
    .get();
  assert.equal(firstInvite?.acceptedPrivateAssistantId, firstAccepted.privateAssistantId);
  assert.equal(secondInvite?.acceptedPrivateAssistantId, firstAccepted.privateAssistantId);
});

test("assistant invite accept does not leak a private assistant asset when room displayName conflicts", async () => {
  const createdAt = new Date("2026-03-25T05:56:00.000Z").toISOString();

  db.insert(principals).values({
    id: "prn_owner_display_conflict",
    kind: "human",
    loginKey: "owner-display-conflict@example.com",
    globalDisplayName: "OwnerDisplayConflict",
    backendType: null,
    backendThreadId: null,
    status: "online",
    createdAt,
  }).run();

  db.insert(rooms).values({
    id: "room_owner_display_conflict",
    name: "Owner Display Conflict",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_owner_display_conflict",
      roomId: "room_owner_display_conflict",
      principalId: "prn_owner_display_conflict",
      type: "human",
      roleKind: "none",
      displayName: "OwnerDisplayConflict",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_conflicting_name",
      roomId: "room_owner_display_conflict",
      principalId: null,
      type: "human",
      roleKind: "none",
      displayName: "冲突助理",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  db.insert(assistantInvites).values({
    id: "ainv_display_conflict",
    roomId: "room_owner_display_conflict",
    ownerMemberId: "mem_owner_display_conflict",
    presetDisplayName: "冲突助理",
    backendType: "codex_cli",
    inviteToken: "invite_display_conflict",
    status: "pending",
    acceptedMemberId: null,
    acceptedPrivateAssistantId: null,
    createdAt,
    expiresAt: null,
    acceptedAt: null,
  }).run();

  const response = await app.request(
    "http://localhost/api/assistant-invites/invite_display_conflict/accept",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backendThreadId: "thread_display_conflict",
      }),
    },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "displayName already exists in room",
  });

  const leakedAssistant = db
    .select()
    .from(privateAssistants)
    .where(eq(privateAssistants.backendThreadId, "thread_display_conflict"))
    .get();
  const inviteAfter = db
    .select()
    .from(assistantInvites)
    .where(eq(assistantInvites.id, "ainv_display_conflict"))
    .get();

  assert.equal(leakedAssistant, undefined);
  assert.equal(inviteAfter?.status, "pending");
  assert.equal(inviteAfter?.acceptedPrivateAssistantId, null);
});

test("assistant invite accept rejects reusing a private assistant thread across different owners", async () => {
  const createdAt = new Date("2026-03-25T05:58:00.000Z").toISOString();

  db.insert(principals).values([
    {
      id: "prn_owner_conflict_a",
      kind: "human",
      loginKey: "owner-conflict-a@example.com",
      globalDisplayName: "OwnerConflictA",
      backendType: null,
      backendThreadId: null,
      status: "online",
      createdAt,
    },
    {
      id: "prn_owner_conflict_b",
      kind: "human",
      loginKey: "owner-conflict-b@example.com",
      globalDisplayName: "OwnerConflictB",
      backendType: null,
      backendThreadId: null,
      status: "online",
      createdAt,
    },
  ]).run();

  db.insert(rooms).values([
    {
      id: "room_owner_conflict_a",
      name: "Owner Conflict A",
      inviteToken: createInviteToken(),
      status: "active",
      createdAt,
    },
    {
      id: "room_owner_conflict_b",
      name: "Owner Conflict B",
      inviteToken: createInviteToken(),
      status: "active",
      createdAt,
    },
  ]).run();

  db.insert(members).values([
    {
      id: "mem_owner_conflict_a",
      roomId: "room_owner_conflict_a",
      principalId: "prn_owner_conflict_a",
      type: "human",
      roleKind: "none",
      displayName: "OwnerConflictA",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
    {
      id: "mem_owner_conflict_b",
      roomId: "room_owner_conflict_b",
      principalId: "prn_owner_conflict_b",
      type: "human",
      roleKind: "none",
      displayName: "OwnerConflictB",
      ownerMemberId: null,
      adapterType: null,
      adapterConfig: null,
      presenceStatus: "online",
      createdAt,
    },
  ]).run();

  db.insert(assistantInvites).values([
    {
      id: "ainv_conflict_a",
      roomId: "room_owner_conflict_a",
      ownerMemberId: "mem_owner_conflict_a",
      presetDisplayName: "共享助理",
      backendType: "codex_cli",
      inviteToken: "invite_conflict_a",
      status: "pending",
      acceptedMemberId: null,
      acceptedPrivateAssistantId: null,
      createdAt,
      expiresAt: null,
      acceptedAt: null,
    },
    {
      id: "ainv_conflict_b",
      roomId: "room_owner_conflict_b",
      ownerMemberId: "mem_owner_conflict_b",
      presetDisplayName: "共享助理",
      backendType: "codex_cli",
      inviteToken: "invite_conflict_b",
      status: "pending",
      acceptedMemberId: null,
      acceptedPrivateAssistantId: null,
      createdAt,
      expiresAt: null,
      acceptedAt: null,
    },
  ]).run();

  const firstAcceptResponse = await app.request(
    "http://localhost/api/assistant-invites/invite_conflict_a/accept",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backendThreadId: "thread_owner_conflict",
      }),
    },
  );

  assert.equal(firstAcceptResponse.status, 201);

  const secondAcceptResponse = await app.request(
    "http://localhost/api/assistant-invites/invite_conflict_b/accept",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        backendThreadId: "thread_owner_conflict",
      }),
    },
  );

  assert.equal(secondAcceptResponse.status, 409);
  assert.deepEqual(await secondAcceptResponse.json(), {
    error: "backendThreadId already bound",
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

  db.insert(principals).values({
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
      principalId: "prn_codex_agent",
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
    principalId: "prn_codex_agent",
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

  db.insert(principals).values({
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
      principalId: "prn_codex_bridge_task",
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
    principalId: "prn_codex_bridge_task",
    privateAssistantId: null,
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

  const completeResponse = await app.request(
    `http://localhost/api/bridges/brg_codex_task/tasks/${pulled.task.id}/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bridgeToken: "bridge_codex_task_token",
        bridgeInstanceId: "binst_codex_task",
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
        bridgeInstanceId: "binst_codex_task",
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
  assert.equal(task?.acceptedInstanceId, "binst_codex_task");
  assert.equal(task?.status, "completed");
  assert.ok(
    roomMessages.some(
      (message) =>
        message.messageType === "agent_text" &&
        message.content === "final bridge output",
    ),
  );
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

  db.insert(principals).values({
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
      principalId: "prn_codex_waiting",
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
    principalId: "prn_codex_waiting",
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
