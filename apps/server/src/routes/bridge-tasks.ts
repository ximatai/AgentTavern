import { and, asc, eq, lt, or } from "drizzle-orm";
import { Hono } from "hono";

import type { AgentSession } from "@agent-tavern/shared";

import { db } from "../db/client";
import { agentBindings, agentSessions, bridgeTasks, localBridges, members } from "../db/schema";
import {
  commitSessionMessage,
  createStreamDeltaEvent,
  failSession,
  markSessionRunning,
  now,
} from "../agents/session-events";
import { broadcastToRoom } from "../realtime";

const bridgeTaskRoutes = new Hono();
const TASK_ASSIGNMENT_LEASE_MS = Number(
  process.env.AGENT_TAVERN_BRIDGE_TASK_LEASE_MS ?? 15_000,
);

function resolveBindingForAgentMember(agentMemberId: string) {
  const agentMember = db
    .select({
      principalId: members.principalId,
      sourcePrivateAssistantId: members.sourcePrivateAssistantId,
    })
    .from(members)
    .where(eq(members.id, agentMemberId))
    .get();

  if (!agentMember) {
    return null;
  }

  if (agentMember.sourcePrivateAssistantId) {
    return db
      .select()
      .from(agentBindings)
      .where(eq(agentBindings.privateAssistantId, agentMember.sourcePrivateAssistantId))
      .get();
  }

  if (agentMember.principalId) {
    return db
      .select()
      .from(agentBindings)
      .where(eq(agentBindings.principalId, agentMember.principalId))
      .get();
  }

  return null;
}

function loadAuthorizedBridge(
  bridgeId: string,
  bridgeToken: string,
  bridgeInstanceId?: string,
) {
  const bridge = db
    .select()
    .from(localBridges)
    .where(eq(localBridges.id, bridgeId))
    .get();

  if (!bridge) {
    return { error: { status: 404 as const, body: { error: "bridge not found" } }, bridge: null };
  }

  if (bridge.bridgeToken !== bridgeToken) {
    return { error: { status: 403 as const, body: { error: "invalid bridge credentials" } }, bridge: null };
  }

  if (bridgeInstanceId && bridge.currentInstanceId && bridge.currentInstanceId !== bridgeInstanceId) {
    return {
      error: { status: 409 as const, body: { error: "stale bridge instance" } },
      bridge: null,
    };
  }

  return { error: null, bridge };
}

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

bridgeTaskRoutes.post("/api/bridges/:bridgeId/tasks/pull", async (c) => {
  const bridgeId = c.req.param("bridgeId");
  const body = await c.req.json().catch(() => null);
  const bridgeToken = typeof body?.bridgeToken === "string" ? body.bridgeToken.trim() : "";
  const bridgeInstanceId =
    typeof body?.bridgeInstanceId === "string" ? body.bridgeInstanceId.trim() : "";

  if (!bridgeToken || !bridgeInstanceId) {
    return c.json({ error: "bridgeToken and bridgeInstanceId are required" }, 400);
  }

  const auth = loadAuthorizedBridge(bridgeId, bridgeToken, bridgeInstanceId);
  if (auth.error) {
    return c.json(auth.error.body, { status: auth.error.status });
  }

  const leaseCutoff = new Date(Date.now() - TASK_ASSIGNMENT_LEASE_MS).toISOString();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const task = db
      .select()
      .from(bridgeTasks)
      .where(
        and(
          eq(bridgeTasks.bridgeId, bridgeId),
          or(
            eq(bridgeTasks.status, "pending"),
            and(eq(bridgeTasks.status, "assigned"), lt(bridgeTasks.assignedAt, leaseCutoff)),
          ),
        ),
      )
      .orderBy(asc(bridgeTasks.createdAt))
      .get();

    if (!task) {
      return c.json({ task: null });
    }

    const assignedAt = now();
    const result = db
      .update(bridgeTasks)
      .set({
        status: "assigned",
        assignedAt,
        assignedInstanceId: bridgeInstanceId,
      })
      .where(
        and(
          eq(bridgeTasks.id, task.id),
          eq(bridgeTasks.bridgeId, bridgeId),
          or(
            eq(bridgeTasks.status, "pending"),
            and(eq(bridgeTasks.status, "assigned"), lt(bridgeTasks.assignedAt, leaseCutoff)),
          ),
        ),
      )
      .run();

    if (result.changes > 0) {
      return c.json({
        task: {
          ...task,
          status: "assigned",
          assignedAt,
          assignedInstanceId: bridgeInstanceId,
        },
      });
    }
  }

  return c.json({ task: null });
});

bridgeTaskRoutes.post("/api/bridges/:bridgeId/tasks/:taskId/accept", async (c) => {
  const bridgeId = c.req.param("bridgeId");
  const taskId = c.req.param("taskId");
  const body = await c.req.json().catch(() => null);
  const bridgeToken = typeof body?.bridgeToken === "string" ? body.bridgeToken.trim() : "";
  const bridgeInstanceId =
    typeof body?.bridgeInstanceId === "string" ? body.bridgeInstanceId.trim() : "";

  if (!bridgeToken || !bridgeInstanceId) {
    return c.json({ error: "bridgeToken and bridgeInstanceId are required" }, 400);
  }

  const auth = loadAuthorizedBridge(bridgeId, bridgeToken, bridgeInstanceId);
  if (auth.error) {
    return c.json(auth.error.body, { status: auth.error.status });
  }

  const task = db
    .select()
    .from(bridgeTasks)
    .where(and(eq(bridgeTasks.id, taskId), eq(bridgeTasks.bridgeId, bridgeId)))
    .get();

  if (!task) {
    return c.json({ error: "task not found" }, 404);
  }

  if (task.status !== "pending" && task.status !== "assigned") {
    return c.json({ error: "task is not available for acceptance" }, 409);
  }

  if (task.status === "assigned" && task.assignedInstanceId && task.assignedInstanceId !== bridgeInstanceId) {
    return c.json({ error: "task is assigned to another bridge instance" }, 409);
  }

  const acceptedAt = now();
  const result = db
    .update(bridgeTasks)
    .set({
      status: "accepted",
      acceptedAt,
      acceptedInstanceId: bridgeInstanceId,
    })
    .where(
      and(
        eq(bridgeTasks.id, taskId),
        eq(bridgeTasks.bridgeId, bridgeId),
        or(eq(bridgeTasks.status, "pending"), eq(bridgeTasks.status, "assigned")),
      ),
    )
    .run();

  if (result.changes === 0) {
    return c.json({ error: "task is not available for acceptance" }, 409);
  }

  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, task.sessionId))
    .get();

  if (!session) {
    return c.json({ error: "session not found" }, 404);
  }

  const runningSession = markSessionRunning(toAgentSession(session));

  return c.json({
    taskId,
    sessionId: runningSession.id,
    status: "accepted",
    acceptedAt,
    bridgeInstanceId,
  });
});

bridgeTaskRoutes.post("/api/bridges/:bridgeId/tasks/:taskId/delta", async (c) => {
  const bridgeId = c.req.param("bridgeId");
  const taskId = c.req.param("taskId");
  const body = await c.req.json().catch(() => null);
  const bridgeToken = typeof body?.bridgeToken === "string" ? body.bridgeToken.trim() : "";
  const bridgeInstanceId =
    typeof body?.bridgeInstanceId === "string" ? body.bridgeInstanceId.trim() : "";
  const delta = typeof body?.delta === "string" ? body.delta : "";

  if (!bridgeToken || !bridgeInstanceId || !delta) {
    return c.json({ error: "bridgeToken, bridgeInstanceId, and delta are required" }, 400);
  }

  const auth = loadAuthorizedBridge(bridgeId, bridgeToken, bridgeInstanceId);
  if (auth.error) {
    return c.json(auth.error.body, { status: auth.error.status });
  }

  const task = db
    .select()
    .from(bridgeTasks)
    .where(and(eq(bridgeTasks.id, taskId), eq(bridgeTasks.bridgeId, bridgeId)))
    .get();

  if (!task) {
    return c.json({ error: "task not found" }, 404);
  }

  if (task.status !== "accepted") {
    return c.json({ error: "task is not accepting deltas" }, 409);
  }

  if (task.acceptedInstanceId !== bridgeInstanceId) {
    return c.json({ error: "task is owned by another bridge instance" }, 409);
  }

  broadcastToRoom(
    task.roomId,
    createStreamDeltaEvent(task.roomId, task.sessionId, task.outputMessageId, delta),
  );

  return c.json({ ok: true });
});

bridgeTaskRoutes.post("/api/bridges/:bridgeId/tasks/:taskId/complete", async (c) => {
  const bridgeId = c.req.param("bridgeId");
  const taskId = c.req.param("taskId");
  const body = await c.req.json().catch(() => null);
  const bridgeToken = typeof body?.bridgeToken === "string" ? body.bridgeToken.trim() : "";
  const bridgeInstanceId =
    typeof body?.bridgeInstanceId === "string" ? body.bridgeInstanceId.trim() : "";
  const finalText = typeof body?.finalText === "string" ? body.finalText.trim() : "";
  const backendThreadId =
    typeof body?.backendThreadId === "string" ? body.backendThreadId.trim() : "";

  if (!bridgeToken || !bridgeInstanceId || !finalText) {
    return c.json({ error: "bridgeToken, bridgeInstanceId, and finalText are required" }, 400);
  }

  const auth = loadAuthorizedBridge(bridgeId, bridgeToken, bridgeInstanceId);
  if (auth.error) {
    return c.json(auth.error.body, { status: auth.error.status });
  }

  const task = db
    .select()
    .from(bridgeTasks)
    .where(and(eq(bridgeTasks.id, taskId), eq(bridgeTasks.bridgeId, bridgeId)))
    .get();

  if (!task) {
    return c.json({ error: "task not found" }, 404);
  }

  if (task.status !== "accepted") {
    return c.json({ error: "task is not ready to complete" }, 409);
  }

  if (task.acceptedInstanceId !== bridgeInstanceId) {
    return c.json({ error: "task is owned by another bridge instance" }, 409);
  }

  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, task.sessionId))
    .get();

  if (!session) {
    return c.json({ error: "session not found" }, 404);
  }

  const completedAt = now();
  db
    .update(bridgeTasks)
    .set({
      status: "completed",
      completedAt,
    })
    .where(eq(bridgeTasks.id, taskId))
    .run();

  if (backendThreadId) {
    const binding = resolveBindingForAgentMember(task.agentMemberId);

    if (binding && binding.backendThreadId !== backendThreadId) {
      db
        .update(agentBindings)
        .set({ backendThreadId })
        .where(eq(agentBindings.id, binding.id))
        .run();
    }
  }

  commitSessionMessage({
    session: toAgentSession(session),
    messageId: task.outputMessageId,
    content: finalText,
    replyToMessageId: session.triggerMessageId,
  });

  return c.json({
    taskId,
    status: "completed",
    completedAt,
  });
});

bridgeTaskRoutes.post("/api/bridges/:bridgeId/tasks/:taskId/fail", async (c) => {
  const bridgeId = c.req.param("bridgeId");
  const taskId = c.req.param("taskId");
  const body = await c.req.json().catch(() => null);
  const bridgeToken = typeof body?.bridgeToken === "string" ? body.bridgeToken.trim() : "";
  const bridgeInstanceId =
    typeof body?.bridgeInstanceId === "string" ? body.bridgeInstanceId.trim() : "";
  const errorMessage = typeof body?.error === "string" ? body.error.trim() : "";

  if (!bridgeToken || !bridgeInstanceId || !errorMessage) {
    return c.json({ error: "bridgeToken, bridgeInstanceId, and error are required" }, 400);
  }

  const auth = loadAuthorizedBridge(bridgeId, bridgeToken, bridgeInstanceId);
  if (auth.error) {
    return c.json(auth.error.body, { status: auth.error.status });
  }

  const task = db
    .select()
    .from(bridgeTasks)
    .where(and(eq(bridgeTasks.id, taskId), eq(bridgeTasks.bridgeId, bridgeId)))
    .get();

  if (!task) {
    return c.json({ error: "task not found" }, 404);
  }

  if (task.status !== "accepted") {
    return c.json({ error: "task is not ready to fail" }, 409);
  }

  if (task.acceptedInstanceId !== bridgeInstanceId) {
    return c.json({ error: "task is owned by another bridge instance" }, 409);
  }

  const session = db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, task.sessionId))
    .get();

  if (!session) {
    return c.json({ error: "session not found" }, 404);
  }

  const failedAt = now();
  db
    .update(bridgeTasks)
    .set({
      status: "failed",
      failedAt,
    })
    .where(eq(bridgeTasks.id, taskId))
    .run();

  failSession(toAgentSession(session), errorMessage);

  return c.json({
    taskId,
    status: "failed",
    failedAt,
  });
});

export { bridgeTaskRoutes };
