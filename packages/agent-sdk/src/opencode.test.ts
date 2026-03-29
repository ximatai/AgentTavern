import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createOpenCodeAdapter,
  type OpenCodeSpawn,
} from "./opencode";
import { FakeChildProcess } from "./test-helpers";

test("createOpenCodeAdapter streams deltas and returns session id", async () => {
  const child = new FakeChildProcess();
  const stdinChunks: string[] = [];
  child.stdin.on("data", (chunk: Buffer | string) => {
    stdinChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  });

  let observedSpawn:
    | {
        command: string;
        args: ReadonlyArray<string>;
        options: { stdio: ["pipe", "pipe", "pipe"]; cwd?: string };
      }
    | undefined;

  const spawnProcess: OpenCodeSpawn = ((command, args, options) => {
    observedSpawn = { command, args, options };

    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: "step_start",
          sessionID: "ses_from_event",
          part: { type: "step-start" },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "text",
          sessionID: "ses_from_event",
          part: {
            type: "text",
            text: "Hello from OpenCode",
            time: { start: 1, end: 1 },
          },
        })}\n`,
      );
      child.stdout.end();
      child.emit("close", 0);
    });

    return child as never;
  }) as OpenCodeSpawn;

  const adapter = createOpenCodeAdapter(
    {
      sessionId: "ses_previous",
      cwd: "/tmp/opencode-project",
      model: "demo/model",
      agent: "helper",
    },
    spawnProcess,
  );

  const events = [];
  for await (const event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "OpenCode Agent",
    requesterMemberId: "user_1",
    requesterDisplayName: "Requester",
    triggerMessageId: "msg_1",
    prompt: "say hello",
    contextMessages: [],
  })) {
    events.push(event);
  }

  assert.deepEqual(observedSpawn, {
    command: "opencode",
    args: [
      "run",
      "--format",
      "json",
      "--session",
      "ses_previous",
      "--model",
      "demo/model",
      "--agent",
      "helper",
    ],
    options: {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/tmp/opencode-project",
    },
  });
  assert.equal(stdinChunks.join(""), "say hello");
  assert.deepEqual(events, [
    { type: "delta", text: "Hello from OpenCode" },
    { type: "completed", finalText: undefined, sessionId: "ses_from_event" },
  ]);
});

test("createOpenCodeAdapter reports a clear failure when opencode is not installed", async () => {
  const spawnProcess: OpenCodeSpawn = (() => {
    const child = new FakeChildProcess();
    child.stdout.end();

    queueMicrotask(() => {
      const error = Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" });
      child.emit("error", error);
    });

    return child as never;
  }) as OpenCodeSpawn;

  const adapter = createOpenCodeAdapter({}, spawnProcess);

  const events = [];
  for await (const event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "OpenCode Agent",
    requesterMemberId: "user_1",
    requesterDisplayName: "Requester",
    triggerMessageId: "msg_1",
    prompt: "say hello",
    contextMessages: [],
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    {
      type: "failed",
      error: "opencode CLI not found — ensure OpenCode is installed",
    },
  ]);
});
