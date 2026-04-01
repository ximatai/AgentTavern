import { and, eq } from "drizzle-orm";

import type { Approval, Message } from "@agent-tavern/shared";

import { db, sqlite } from "../db/client";
import {
  expireStalePendingBridgeTasks,
  failAcceptedBridgeTasksAfterRuntimeReset,
} from "../lib/bridge-task-maintenance";
import { cleanupExpiredDraftAttachments } from "../lib/message-attachments";
import { insertMessage } from "../lib/message-records";
import {
  createApprovalResultSystemData,
  createStructuredSystemMessage,
} from "../lib/system-messages";
import {
  agentSessions,
  approvals,
  localBridges,
  members,
  mentions,
  citizens,
} from "../db/schema";

function now(): string {
  return new Date().toISOString();
}

export function recoverRuntimeState(): {
  expiredApprovals: number;
  rejectedSessions: number;
  systemMessages: number;
  expiredDraftAttachments: number;
  expiredBridgeTasks: number;
} {
  // On server restart, all in-memory sockets are gone. Persisted "online" state
  // must be folded back before runtime recovery continues.
  db.update(citizens)
    .set({ status: "offline" })
    .where(eq(citizens.status, "online"))
    .run();

  db.update(members)
    .set({ presenceStatus: "offline" })
    .where(eq(members.presenceStatus, "online"))
    .run();

  db.update(localBridges)
    .set({ status: "offline" })
    .where(eq(localBridges.status, "online"))
    .run();

  const pendingApprovals = db.select().from(approvals).where(eq(approvals.status, "pending")).all();
  const expiredDraftAttachments = cleanupExpiredDraftAttachments();
  const expiredBridgeTasksResult = expireStalePendingBridgeTasks();
  const failedAcceptedBridgeTasksResult = failAcceptedBridgeTasksAfterRuntimeReset();

  let rejectedSessions =
    expiredBridgeTasksResult.failedSessions + failedAcceptedBridgeTasksResult.failedSessions;
  let systemMessages =
    expiredBridgeTasksResult.failedSessions + failedAcceptedBridgeTasksResult.failedSessions;

  for (const approvalRow of pendingApprovals) {
    const approval = approvalRow as Approval;
    const resolvedAt = now();
    sqlite.transaction(() => {
      db
        .update(approvals)
        .set({
          status: "expired",
          resolvedAt,
        })
        .where(eq(approvals.id, approval.id))
        .run();

      const sessionResult = db
        .update(agentSessions)
        .set({
          status: "rejected",
          endedAt: resolvedAt,
        })
        .where(
          and(eq(agentSessions.approvalId, approval.id), eq(agentSessions.status, "waiting_approval")),
        )
        .run();

      rejectedSessions += sessionResult.changes;

      db
        .update(mentions)
        .set({ status: "expired" })
        .where(
          and(
            eq(mentions.messageId, approval.triggerMessageId),
            eq(mentions.targetMemberId, approval.agentMemberId),
          ),
        )
        .run();

      const systemMessage: Message = createStructuredSystemMessage({
        roomId: approval.roomId,
        senderMemberId: approval.agentMemberId,
        messageType: "approval_result",
        systemData: createApprovalResultSystemData({
          kind: "approval_expired",
          detail: "Approval request expired because the server restarted.",
          approvalId: approval.id,
          agentMemberId: approval.agentMemberId,
          ownerMemberId: approval.ownerMemberId,
          requesterMemberId: approval.requesterMemberId,
        }),
        replyToMessageId: approval.triggerMessageId,
        createdAt: resolvedAt,
      });

      insertMessage(systemMessage);
      systemMessages += 1;
    })();
  }

  return {
    expiredApprovals: pendingApprovals.length,
    rejectedSessions,
    systemMessages,
    expiredDraftAttachments,
    expiredBridgeTasks:
      expiredBridgeTasksResult.expiredTasks + failedAcceptedBridgeTasksResult.failedTasks,
  };
}
