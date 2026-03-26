import { and, eq } from "drizzle-orm";

import type { Approval, Message } from "@agent-tavern/shared";

import { db, sqlite } from "../db/client";
import { agentSessions, approvals, mentions, messages } from "../db/schema";
import { createId } from "../lib/id";
import { cleanupExpiredDraftAttachments } from "../lib/message-attachments";

function now(): string {
  return new Date().toISOString();
}

export function recoverRuntimeState(): {
  expiredApprovals: number;
  rejectedSessions: number;
  systemMessages: number;
  expiredDraftAttachments: number;
} {
  const pendingApprovals = db.select().from(approvals).where(eq(approvals.status, "pending")).all();
  const expiredDraftAttachments = cleanupExpiredDraftAttachments();

  let rejectedSessions = 0;
  let systemMessages = 0;

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

      const systemMessage: Message = {
        id: createId("msg"),
        roomId: approval.roomId,
        senderMemberId: approval.agentMemberId,
        messageType: "approval_result",
        content: "Approval request expired because the server restarted.",
        attachments: [],
        replyToMessageId: approval.triggerMessageId,
        createdAt: resolvedAt,
      };

      db.insert(messages).values(systemMessage).run();
      systemMessages += 1;
    })();
  }

  return {
    expiredApprovals: pendingApprovals.length,
    rejectedSessions,
    systemMessages,
    expiredDraftAttachments,
  };
}
