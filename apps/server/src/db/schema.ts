import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  inviteToken: text("invite_token").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  inviteTokenUniqueIdx: uniqueIndex("rooms_invite_token_unique_idx").on(
    table.inviteToken,
  ),
}));

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  type: text("type").notNull(),
  roleKind: text("role_kind").notNull(),
  displayName: text("display_name").notNull(),
  ownerMemberId: text("owner_member_id"),
  presenceStatus: text("presence_status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  roomIdIdx: index("members_room_id_idx").on(table.roomId),
  ownerMemberIdIdx: index("members_owner_member_id_idx").on(table.ownerMemberId),
  roomDisplayNameUniqueIdx: uniqueIndex("members_room_display_name_unique_idx").on(
    table.roomId,
    table.displayName,
  ),
}));

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  senderMemberId: text("sender_member_id")
    .notNull()
    .references(() => members.id),
  messageType: text("message_type").notNull(),
  content: text("content").notNull(),
  replyToMessageId: text("reply_to_message_id"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  roomIdIdx: index("messages_room_id_idx").on(table.roomId),
  senderMemberIdIdx: index("messages_sender_member_id_idx").on(table.senderMemberId),
  createdAtIdx: index("messages_created_at_idx").on(table.createdAt),
}));

export const mentions = sqliteTable("mentions", {
  id: text("id").primaryKey(),
  messageId: text("message_id")
    .notNull()
    .references(() => messages.id),
  targetMemberId: text("target_member_id")
    .notNull()
    .references(() => members.id),
  triggerText: text("trigger_text").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  messageIdIdx: index("mentions_message_id_idx").on(table.messageId),
  targetMemberIdIdx: index("mentions_target_member_id_idx").on(table.targetMemberId),
}));

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  requesterMemberId: text("requester_member_id")
    .notNull()
    .references(() => members.id),
  ownerMemberId: text("owner_member_id")
    .notNull()
    .references(() => members.id),
  agentMemberId: text("agent_member_id")
    .notNull()
    .references(() => members.id),
  triggerMessageId: text("trigger_message_id")
    .notNull()
    .references(() => messages.id),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (table) => ({
  roomIdIdx: index("approvals_room_id_idx").on(table.roomId),
  ownerMemberIdIdx: index("approvals_owner_member_id_idx").on(table.ownerMemberId),
  agentMemberIdIdx: index("approvals_agent_member_id_idx").on(table.agentMemberId),
  statusIdx: index("approvals_status_idx").on(table.status),
}));

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  agentMemberId: text("agent_member_id")
    .notNull()
    .references(() => members.id),
  triggerMessageId: text("trigger_message_id")
    .notNull()
    .references(() => messages.id),
  requesterMemberId: text("requester_member_id")
    .notNull()
    .references(() => members.id),
  approvalId: text("approval_id").references(() => approvals.id),
  approvalRequired: integer("approval_required", { mode: "boolean" }).notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
}, (table) => ({
  roomIdIdx: index("agent_sessions_room_id_idx").on(table.roomId),
  agentMemberIdIdx: index("agent_sessions_agent_member_id_idx").on(table.agentMemberId),
  statusIdx: index("agent_sessions_status_idx").on(table.status),
}));
