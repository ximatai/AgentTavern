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
    messageAttachments,
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
    grantDuration: "once",
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
  assert.equal(result.expiredDraftAttachments, 0);

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

test("recoverRuntimeState removes expired draft attachments and keeps committed ones", async () => {
  const databasePath = uniqueTempDbPath();
  process.env.AGENT_TAVERN_DB_PATH = databasePath;

  const [{ runMigrations }, dbClient, schema, recovery] = await Promise.all([
    import("../db/migrate.js"),
    import("../db/client.js"),
    import("../db/schema.js"),
    import("./recovery.js"),
  ]);

  runMigrations();

  const { dataDir, db } = dbClient;
  const { rooms, members, messages, messageAttachments } = schema;

  const nowIso = new Date("2026-03-25T12:00:00.000Z").toISOString();
  const staleIso = new Date(Date.parse(nowIso) - 25 * 60 * 60 * 1000).toISOString();
  const attachmentsDir = path.join(dataDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });

  db.insert(rooms).values({
    id: "room_attach_recovery",
    name: "Attachment Recovery Room",
    inviteToken: "inv_attach_recovery",
    status: "active",
    createdAt: nowIso,
  }).run();

  db.insert(members).values({
    id: "mem_attach_owner",
    roomId: "room_attach_recovery",
    type: "human",
    roleKind: "none",
    displayName: "Owner",
    ownerMemberId: null,
    adapterType: null,
    adapterConfig: null,
    presenceStatus: "offline",
    createdAt: nowIso,
  }).run();

  db.insert(messages).values({
    id: "msg_attach_committed",
    roomId: "room_attach_recovery",
    senderMemberId: "mem_attach_owner",
    messageType: "user_text",
    content: "hello",
    replyToMessageId: null,
    createdAt: nowIso,
  }).run();

  const stalePath = path.join(attachmentsDir, "att_stale");
  const committedPath = path.join(attachmentsDir, "att_committed");
  fs.writeFileSync(stalePath, "stale");
  fs.writeFileSync(committedPath, "committed");

  db.insert(messageAttachments).values([
    {
      id: "att_stale",
      roomId: "room_attach_recovery",
      uploaderMemberId: "mem_attach_owner",
      messageId: null,
      storagePath: stalePath,
      originalName: "stale.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      createdAt: staleIso,
    },
    {
      id: "att_committed",
      roomId: "room_attach_recovery",
      uploaderMemberId: "mem_attach_owner",
      messageId: "msg_attach_committed",
      storagePath: committedPath,
      originalName: "committed.txt",
      mimeType: "text/plain",
      sizeBytes: 9,
      createdAt: staleIso,
    },
  ]).run();

  const originalNow = Date.now;
  Date.now = () => Date.parse(nowIso);

  try {
    const result = recovery.recoverRuntimeState();

    assert.equal(result.expiredApprovals, 0);
    assert.equal(result.systemMessages, 0);
    assert.equal(result.expiredDraftAttachments, 1);
  } finally {
    Date.now = originalNow;
  }

  const remainingAttachments = db.select().from(messageAttachments).all();
  assert.equal(remainingAttachments.length, 1);
  assert.equal(remainingAttachments[0]?.id, "att_committed");
  assert.equal(fs.existsSync(stalePath), false);
  assert.equal(fs.existsSync(committedPath), true);
});
