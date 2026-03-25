import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function uniqueTempDbPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const tempRoot = path.resolve(currentDir, "../../.tmp-tests");
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tempRoot, "agent-tavern-recovery-"));
  return path.join(tempDir, "agent-tavern.db");
}

test("recoverRuntimeState expires pending approvals and rejects waiting sessions", async () => {
  const databasePath = uniqueTempDbPath();
  process.env.AGENT_TAVERN_DB_PATH = databasePath;

  const [{ runMigrations }, dbClient, schema, ids, recovery] = await Promise.all([
    import("../db/migrate.js"),
    import("../db/client.js"),
    import("../db/schema.js"),
    import("../lib/id.js"),
    import("./recovery.js"),
  ]);

  runMigrations();

  const { db } = dbClient;
  const {
    rooms,
    members,
    messages,
    mentions,
    approvals,
    agentSessions,
  } = schema;
  const { createId, createInviteToken } = ids;

  const createdAt = new Date("2026-03-25T00:00:00.000Z").toISOString();

  db.insert(rooms).values({
    id: "room_test",
    name: "Recovery Room",
    inviteToken: createInviteToken(),
    status: "active",
    createdAt,
  }).run();

  db.insert(members).values([
    {
      id: "mem_owner",
      roomId: "room_test",
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
      id: "mem_agent",
      roomId: "room_test",
      type: "agent",
      roleKind: "assistant",
      displayName: "AssistA",
      ownerMemberId: "mem_owner",
      adapterType: "local_process",
      adapterConfig: "{\"command\":\"node\"}",
      presenceStatus: "offline",
      createdAt,
    },
  ]).run();

  db.insert(messages).values({
    id: "msg_trigger",
    roomId: "room_test",
    senderMemberId: "mem_owner",
    messageType: "user_text",
    content: "@AssistA please help",
    replyToMessageId: null,
    createdAt,
  }).run();

  db.insert(mentions).values({
    id: createId("men"),
    messageId: "msg_trigger",
    targetMemberId: "mem_agent",
    triggerText: "@AssistA",
    status: "pending_approval",
    createdAt,
  }).run();

  db.insert(approvals).values({
    id: "apr_pending",
    roomId: "room_test",
    requesterMemberId: "mem_owner",
    ownerMemberId: "mem_owner",
    agentMemberId: "mem_agent",
    triggerMessageId: "msg_trigger",
    status: "pending",
    createdAt,
    resolvedAt: null,
  }).run();

  db.insert(agentSessions).values({
    id: "as_waiting",
    roomId: "room_test",
    agentMemberId: "mem_agent",
    triggerMessageId: "msg_trigger",
    requesterMemberId: "mem_owner",
    approvalId: "apr_pending",
    approvalRequired: true,
    status: "waiting_approval",
    startedAt: null,
    endedAt: null,
  }).run();

  const result = recovery.recoverRuntimeState();

  assert.equal(result.expiredApprovals, 1);
  assert.equal(result.rejectedSessions, 1);
  assert.equal(result.systemMessages, 1);

  const approval = db.select().from(approvals).get();
  const session = db.select().from(agentSessions).get();
  const mention = db.select().from(mentions).get();
  const allMessages = db.select().from(messages).all();

  assert.equal(approval?.status, "expired");
  assert.equal(session?.status, "rejected");
  assert.equal(mention?.status, "expired");
  assert.equal(allMessages.length, 2);
  assert.equal(allMessages.at(-1)?.messageType, "approval_result");
  assert.match(allMessages.at(-1)?.content ?? "", /server restarted/i);
});
