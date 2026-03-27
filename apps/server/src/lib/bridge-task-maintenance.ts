import { and, eq, lt } from "drizzle-orm";

import type { AgentSession } from "@agent-tavern/shared";

import { failSession, now } from "../agents/session-events";
import { db } from "../db/client";
import { agentSessions, bridgeTasks, members } from "../db/schema";

const BRIDGE_TASK_PENDING_TIMEOUT_MS = Number(
  process.env.AGENT_TAVERN_BRIDGE_TASK_PENDING_TIMEOUT_MS ?? 60_000,
);

function toAgentSession(row: {
  id: string;
  roomId: string;
  agentMemberId: string;
  triggerMessageId: string;
  requesterMemberId: string;
  approvalId: string | null;
  approvalRequired: boolean;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
}): AgentSession {
  return row as AgentSession;
}

export function expireStalePendingBridgeTasks(referenceTime = Date.now()): {
  expiredTasks: number;
  failedSessions: number;
} {
  const cutoff = new Date(referenceTime - BRIDGE_TASK_PENDING_TIMEOUT_MS).toISOString();
  const staleTasks = db
    .select()
    .from(bridgeTasks)
    .where(and(eq(bridgeTasks.status, "pending"), lt(bridgeTasks.createdAt, cutoff)))
    .all();

  let expiredTasks = 0;
  let failedSessions = 0;

  for (const task of staleTasks) {
    const failedAt = now();
    const taskResult = db
      .update(bridgeTasks)
      .set({
        status: "failed",
        failedAt,
      })
      .where(and(eq(bridgeTasks.id, task.id), eq(bridgeTasks.status, "pending")))
      .run();

    if (taskResult.changes === 0) {
      continue;
    }

    expiredTasks += 1;

    const session = db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, task.sessionId), eq(agentSessions.status, "pending")))
      .get();

    if (!session) {
      continue;
    }

    const agent = db
      .select()
      .from(members)
      .where(eq(members.id, session.agentMemberId))
      .get();
    const agentDisplayName = agent?.displayName ?? session.agentMemberId;

    failSession(
      toAgentSession(session),
      `${agentDisplayName} did not start because the local bridge did not accept the task in time.`,
    );
    failedSessions += 1;
  }

  return { expiredTasks, failedSessions };
}
