import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const principals = sqliteTable("principals", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  loginKey: text("login_key").notNull(),
  globalDisplayName: text("global_display_name").notNull(),
  backendType: text("backend_type"),
  backendThreadId: text("backend_thread_id"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  kindLoginKeyUniqueIdx: uniqueIndex("principals_kind_login_key_unique_idx").on(
    table.kind,
    table.loginKey,
  ),
  statusIdx: index("principals_status_idx").on(table.status),
}));

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
  principalId: text("principal_id").references(() => principals.id),
  type: text("type").notNull(),
  roleKind: text("role_kind").notNull(),
  displayName: text("display_name").notNull(),
  ownerMemberId: text("owner_member_id"),
  sourcePrivateAssistantId: text("source_private_assistant_id"),
  adapterType: text("adapter_type"),
  adapterConfig: text("adapter_config"),
  presenceStatus: text("presence_status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  roomIdIdx: index("members_room_id_idx").on(table.roomId),
  principalIdIdx: index("members_principal_id_idx").on(table.principalId),
  ownerMemberIdIdx: index("members_owner_member_id_idx").on(table.ownerMemberId),
  roomDisplayNameUniqueIdx: uniqueIndex("members_room_display_name_unique_idx").on(
    table.roomId,
    table.displayName,
  ),
}));

export const privateAssistants = sqliteTable("private_assistants", {
  id: text("id").primaryKey(),
  ownerPrincipalId: text("owner_principal_id")
    .notNull()
    .references(() => principals.id),
  name: text("name").notNull(),
  backendType: text("backend_type").notNull(),
  backendThreadId: text("backend_thread_id"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  ownerPrincipalIdIdx: index("private_assistants_owner_principal_id_idx").on(
    table.ownerPrincipalId,
  ),
  ownerNameUniqueIdx: uniqueIndex("private_assistants_owner_name_unique_idx").on(
    table.ownerPrincipalId,
    table.name,
  ),
}));

export const privateAssistantInvites = sqliteTable("private_assistant_invites", {
  id: text("id").primaryKey(),
  ownerPrincipalId: text("owner_principal_id")
    .notNull()
    .references(() => principals.id),
  name: text("name").notNull(),
  backendType: text("backend_type").notNull(),
  inviteToken: text("invite_token").notNull(),
  status: text("status").notNull(),
  acceptedPrivateAssistantId: text("accepted_private_assistant_id").references(
    () => privateAssistants.id,
  ),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  acceptedAt: text("accepted_at"),
}, (table) => ({
  ownerPrincipalIdIdx: index("private_assistant_invites_owner_principal_id_idx").on(
    table.ownerPrincipalId,
  ),
  statusIdx: index("private_assistant_invites_status_idx").on(table.status),
  inviteTokenUniqueIdx: uniqueIndex("private_assistant_invites_invite_token_unique_idx").on(
    table.inviteToken,
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
  senderDisplayName: text("sender_display_name"),
  senderType: text("sender_type"),
  senderRoleKind: text("sender_role_kind"),
  messageType: text("message_type").notNull(),
  content: text("content").notNull(),
  systemData: text("system_data"),
  replyToMessageId: text("reply_to_message_id"),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  roomIdIdx: index("messages_room_id_idx").on(table.roomId),
  senderMemberIdIdx: index("messages_sender_member_id_idx").on(table.senderMemberId),
  createdAtIdx: index("messages_created_at_idx").on(table.createdAt),
}));

export const messageAttachments = sqliteTable("message_attachments", {
  id: text("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  uploaderMemberId: text("uploader_member_id")
    .notNull()
    .references(() => members.id),
  messageId: text("message_id").references(() => messages.id),
  storagePath: text("storage_path").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  roomIdIdx: index("message_attachments_room_id_idx").on(table.roomId),
  uploaderMemberIdIdx: index("message_attachments_uploader_member_id_idx").on(table.uploaderMemberId),
  messageIdIdx: index("message_attachments_message_id_idx").on(table.messageId),
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
  grantDuration: text("grant_duration").notNull().default("once"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (table) => ({
  roomIdIdx: index("approvals_room_id_idx").on(table.roomId),
  ownerMemberIdIdx: index("approvals_owner_member_id_idx").on(table.ownerMemberId),
  agentMemberIdIdx: index("approvals_agent_member_id_idx").on(table.agentMemberId),
  statusIdx: index("approvals_status_idx").on(table.status),
}));

export const agentAuthorizations = sqliteTable("agent_authorizations", {
  id: text("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  ownerMemberId: text("owner_member_id")
    .notNull()
    .references(() => members.id),
  requesterMemberId: text("requester_member_id")
    .notNull()
    .references(() => members.id),
  agentMemberId: text("agent_member_id")
    .notNull()
    .references(() => members.id),
  grantDuration: text("grant_duration").notNull(),
  remainingUses: integer("remaining_uses"),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  roomIdIdx: index("agent_authorizations_room_id_idx").on(table.roomId),
  ownerMemberIdIdx: index("agent_authorizations_owner_member_id_idx").on(table.ownerMemberId),
  requesterMemberIdIdx: index("agent_authorizations_requester_member_id_idx").on(table.requesterMemberId),
  agentMemberIdIdx: index("agent_authorizations_agent_member_id_idx").on(table.agentMemberId),
  activeTupleIdx: index("agent_authorizations_active_tuple_idx").on(
    table.roomId,
    table.ownerMemberId,
    table.requesterMemberId,
    table.agentMemberId,
    table.revokedAt,
  ),
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

export const assistantInvites = sqliteTable("assistant_invites", {
  id: text("id").primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  ownerMemberId: text("owner_member_id")
    .notNull()
    .references(() => members.id),
  presetDisplayName: text("preset_display_name"),
  backendType: text("backend_type").notNull(),
  inviteToken: text("invite_token").notNull(),
  status: text("status").notNull(),
  acceptedMemberId: text("accepted_member_id").references(() => members.id),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at"),
  acceptedAt: text("accepted_at"),
}, (table) => ({
  roomIdIdx: index("assistant_invites_room_id_idx").on(table.roomId),
  ownerMemberIdIdx: index("assistant_invites_owner_member_id_idx").on(table.ownerMemberId),
  statusIdx: index("assistant_invites_status_idx").on(table.status),
  inviteTokenUniqueIdx: uniqueIndex("assistant_invites_invite_token_unique_idx").on(
    table.inviteToken,
  ),
}));

export const localBridges = sqliteTable("local_bridges", {
  id: text("id").primaryKey(),
  bridgeName: text("bridge_name").notNull(),
  bridgeToken: text("bridge_token").notNull(),
  currentInstanceId: text("current_instance_id"),
  status: text("status").notNull(),
  platform: text("platform"),
  version: text("version"),
  metadata: text("metadata"),
  lastSeenAt: text("last_seen_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => ({
  bridgeTokenUniqueIdx: uniqueIndex("local_bridges_bridge_token_unique_idx").on(table.bridgeToken),
  statusIdx: index("local_bridges_status_idx").on(table.status),
  lastSeenAtIdx: index("local_bridges_last_seen_at_idx").on(table.lastSeenAt),
}));

export const agentBindings = sqliteTable("agent_bindings", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => members.id),
  bridgeId: text("bridge_id").references(() => localBridges.id),
  backendType: text("backend_type").notNull(),
  backendThreadId: text("backend_thread_id").notNull(),
  cwd: text("cwd"),
  status: text("status").notNull(),
  attachedAt: text("attached_at").notNull(),
  detachedAt: text("detached_at"),
}, (table) => ({
  memberIdUniqueIdx: uniqueIndex("agent_bindings_member_id_unique_idx").on(table.memberId),
  backendThreadIdUniqueIdx: uniqueIndex(
    "agent_bindings_backend_thread_id_unique_idx",
  ).on(table.backendThreadId),
  bridgeIdIdx: index("agent_bindings_bridge_id_idx").on(table.bridgeId),
  statusIdx: index("agent_bindings_status_idx").on(table.status),
}));

export const bridgeTasks = sqliteTable("bridge_tasks", {
  id: text("id").primaryKey(),
  bridgeId: text("bridge_id")
    .notNull()
    .references(() => localBridges.id),
  sessionId: text("session_id")
    .notNull()
    .references(() => agentSessions.id),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  agentMemberId: text("agent_member_id")
    .notNull()
    .references(() => members.id),
  requesterMemberId: text("requester_member_id")
    .notNull()
    .references(() => members.id),
  backendType: text("backend_type").notNull(),
  backendThreadId: text("backend_thread_id").notNull(),
  cwd: text("cwd"),
  outputMessageId: text("output_message_id").notNull(),
  prompt: text("prompt").notNull(),
  contextPayload: text("context_payload"),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  assignedAt: text("assigned_at"),
  assignedInstanceId: text("assigned_instance_id"),
  acceptedAt: text("accepted_at"),
  acceptedInstanceId: text("accepted_instance_id"),
  completedAt: text("completed_at"),
  failedAt: text("failed_at"),
}, (table) => ({
  bridgeIdIdx: index("bridge_tasks_bridge_id_idx").on(table.bridgeId),
  sessionIdUniqueIdx: uniqueIndex("bridge_tasks_session_id_unique_idx").on(table.sessionId),
  statusIdx: index("bridge_tasks_status_idx").on(table.status),
}));
