import assert from "node:assert/strict";
import test from "node:test";

import type { AgentBackendType } from "@agent-tavern/shared";
import type { AgentStreamEvent } from "@agent-tavern/agent-sdk";

import type { BridgeDriver, BridgeTask } from "./drivers.js";
import { pollAndProcessTask, processTask, type PostJson } from "./task-processor.js";

function createTask(overrides?: Partial<BridgeTask>): BridgeTask {
  return {
    id: "btsk_1",
    sessionId: "ags_1",
    roomId: "room_1",
    agentMemberId: "mem_agent",
    requesterMemberId: "mem_requester",
    kind: "message_reply",
    backendType: "codex_cli",
    backendThreadId: "thread_1",
    cwd: "/tmp/task-cwd",
    outputMessageId: "msg_1",
    prompt: "help",
    contextPayload: null,
    status: "assigned",
    createdAt: "2026-03-25T00:00:00.000Z",
    assignedAt: "2026-03-25T00:00:01.000Z",
    ...overrides,
  };
}

function createDriver(
  backendType: AgentBackendType,
  factory: (task: BridgeTask) => AsyncIterable<AgentStreamEvent>,
): BridgeDriver {
  return {
    backendType,
    run(task: BridgeTask) {
      return factory(task);
    },
  };
}

function createPostJsonRecorder(options?: {
  pulledTask?: BridgeTask | null;
}): { calls: Array<{ path: string; body: Record<string, unknown> }>; postJson: PostJson } {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];

  return {
    calls,
    postJson: async <T>(path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });

      if (path.endsWith("/tasks/pull")) {
        return { task: options?.pulledTask ?? null } as T;
      }

      return {} as T;
    },
  };
}

test("processTask accepts, streams deltas, and completes", async () => {
  const task = createTask();
  const { calls, postJson } = createPostJsonRecorder();
  const drivers = new Map<AgentBackendType, BridgeDriver>([
    [
      "codex_cli",
      createDriver("codex_cli", async function* () {
        yield { type: "delta", text: "hello " };
        yield { type: "delta", text: "world" };
        yield { type: "completed" };
      }),
    ],
  ]);

  await processTask({
    bridgeId: "brg_1",
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    task,
    postJson,
    drivers,
  });

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/bridges/brg_1/tasks/btsk_1/accept",
      "/api/bridges/brg_1/tasks/btsk_1/delta",
      "/api/bridges/brg_1/tasks/btsk_1/delta",
      "/api/bridges/brg_1/tasks/btsk_1/complete",
    ],
  );
  assert.deepEqual(calls.at(-1)?.body, {
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    finalText: "hello world",
  });
});

test("processTask persists backend thread id returned by the driver", async () => {
  const task = createTask({ backendType: "opencode", backendThreadId: "ses_initial" });
  const { calls, postJson } = createPostJsonRecorder();
  const drivers = new Map<AgentBackendType, BridgeDriver>([
    [
      "opencode",
      createDriver("opencode", async function* () {
        yield { type: "completed", finalText: "done", sessionId: "ses_updated" };
      }),
    ],
  ]);

  await processTask({
    bridgeId: "brg_1",
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    task,
    postJson,
    drivers,
  });

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/bridges/brg_1/tasks/btsk_1/accept",
      "/api/bridges/brg_1/tasks/btsk_1/complete",
    ],
  );
  assert.deepEqual(calls.at(-1)?.body, {
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    finalText: "done",
    backendThreadId: "ses_updated",
  });
});

test("processTask uploads generated attachments before completing", async () => {
  const task = createTask({ backendType: "opencode" });
  const { calls, postJson } = createPostJsonRecorder();
  const drivers = new Map<AgentBackendType, BridgeDriver>([
    [
      "opencode",
      createDriver("opencode", async function* () {
        yield {
          type: "completed",
          finalText: "done with file",
          attachments: [
            {
              name: "report.txt",
              mimeType: "text/plain",
              contentBase64: Buffer.from("report body", "utf8").toString("base64"),
            },
          ],
        };
      }),
    ],
  ]);

  const postJsonWithAttachmentId: PostJson = async <T>(
    path: string,
    body: Record<string, unknown>,
  ) => {
    calls.push({ path, body });

    if (path.endsWith("/attachments")) {
      return { attachmentId: "att_generated_1" } as T;
    }

    return {} as T;
  };

  await processTask({
    bridgeId: "brg_1",
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    task,
    postJson: postJsonWithAttachmentId,
    drivers,
  });

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/bridges/brg_1/tasks/btsk_1/accept",
      "/api/bridges/brg_1/tasks/btsk_1/attachments",
      "/api/bridges/brg_1/tasks/btsk_1/complete",
    ],
  );
  assert.deepEqual(calls.at(1)?.body, {
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    name: "report.txt",
    mimeType: "text/plain",
    contentBase64: Buffer.from("report body", "utf8").toString("base64"),
  });
  assert.deepEqual(calls.at(2)?.body, {
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    finalText: "done with file",
    attachmentIds: ["att_generated_1"],
  });
});

test("processTask fails when no driver is configured", async () => {
  const task = createTask();
  const { calls, postJson } = createPostJsonRecorder();

  await processTask({
    bridgeId: "brg_1",
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    task,
    postJson,
    drivers: new Map(),
  });

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/bridges/brg_1/tasks/btsk_1/accept",
      "/api/bridges/brg_1/tasks/btsk_1/fail",
    ],
  );
});

test("processTask reports fail when driver throws after accept", async () => {
  const task = createTask();
  const { calls, postJson } = createPostJsonRecorder();
  const drivers = new Map<AgentBackendType, BridgeDriver>([
    [
      "codex_cli",
      createDriver("codex_cli", async function* () {
        yield { type: "delta", text: "partial" };
        throw new Error("driver exploded");
      }),
    ],
  ]);

  await assert.rejects(() =>
    processTask({
      bridgeId: "brg_1",
      bridgeToken: "tok_1",
      bridgeInstanceId: "binst_1",
      task,
      postJson,
      drivers,
    }),
  );

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/bridges/brg_1/tasks/btsk_1/accept",
      "/api/bridges/brg_1/tasks/btsk_1/delta",
      "/api/bridges/brg_1/tasks/btsk_1/fail",
    ],
  );
});

test("processTask reports a failed event without crashing when the CLI is unavailable", async () => {
  const task = createTask({ backendType: "opencode" });
  const { calls, postJson } = createPostJsonRecorder();
  const drivers = new Map<AgentBackendType, BridgeDriver>([
    [
      "opencode",
      createDriver("opencode", async function* () {
        yield {
          type: "failed",
          error: "opencode CLI not found — ensure OpenCode is installed",
        };
      }),
    ],
  ]);

  await processTask({
    bridgeId: "brg_1",
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    task,
    postJson,
    drivers,
  });

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "/api/bridges/brg_1/tasks/btsk_1/accept",
      "/api/bridges/brg_1/tasks/btsk_1/fail",
    ],
  );
  assert.deepEqual(calls.at(-1)?.body, {
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    error: "opencode CLI not found — ensure OpenCode is installed",
  });
});

test("pollAndProcessTask returns false when no task is available", async () => {
  const { calls, postJson } = createPostJsonRecorder({ pulledTask: null });

  const didWork = await pollAndProcessTask({
    enabled: true,
    bridgeId: "brg_1",
    bridgeToken: "tok_1",
    bridgeInstanceId: "binst_1",
    postJson,
    drivers: new Map(),
  });

  assert.equal(didWork, false);
  assert.deepEqual(calls.map((call) => call.path), ["/api/bridges/brg_1/tasks/pull"]);
});
