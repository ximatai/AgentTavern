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
  kind: string;
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

function failAcceptedBridgeTasks(params: {
  bridgeId?: string;
  acceptedInstanceId?: string | null;
  failureMessage: (agentDisplayName: string) => string;
}): {
  failedTasks: number;
  failedSessions: number;
} {
  const staleTasks = db
    .select()
    .from(bridgeTasks)
    .where(
      and(
        eq(bridgeTasks.status, "accepted"),
        ...(params.bridgeId ? [eq(bridgeTasks.bridgeId, params.bridgeId)] : []),
        ...(params.acceptedInstanceId
          ? [eq(bridgeTasks.acceptedInstanceId, params.acceptedInstanceId)]
          : []),
      ),
    )
    .all();

  let failedTasks = 0;
  let failedSessions = 0;

  for (const task of staleTasks) {
    const failedAt = now();
    const taskResult = db
      .update(bridgeTasks)
      .set({
        status: "failed",
        failedAt,
      })
      .where(and(eq(bridgeTasks.id, task.id), eq(bridgeTasks.status, "accepted")))
      .run();

    if (taskResult.changes === 0) {
      continue;
    }

    failedTasks += 1;

    const session = db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.id, task.sessionId), eq(agentSessions.status, "running")))
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
      params.failureMessage(agentDisplayName),
    );
    failedSessions += 1;
  }

  return { failedTasks, failedSessions };
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

export function failAcceptedBridgeTasksAfterRuntimeReset(): {
  failedTasks: number;
  failedSessions: number;
} {
  return failAcceptedBridgeTasks({
    failureMessage: (agentDisplayName) =>
      `${agentDisplayName} stopped because the server restarted while its local bridge task was running.`,
  });
}

export function failAcceptedBridgeTasksForBridgeReconnect(params: {
  bridgeId: string;
  previousInstanceId: string;
}): {
  failedTasks: number;
  failedSessions: number;
} {
  return failAcceptedBridgeTasks({
    bridgeId: params.bridgeId,
    acceptedInstanceId: params.previousInstanceId,
    failureMessage: (agentDisplayName) =>
      `${agentDisplayName} stopped because its local bridge reconnected and the running task could not be resumed automatically.`,
  });
}
