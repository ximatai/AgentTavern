import assert from "node:assert/strict";
import test from "node:test";

import {
  createClaudeCodeAdapter,
  type ClaudeCodeSpawn,
} from "./claude-code";
import { FakeChildProcess } from "./test-helpers";

test("createClaudeCodeAdapter reports a clear failure when claude is not installed", async () => {
  const spawnProcess: ClaudeCodeSpawn = (() => {
    const child = new FakeChildProcess();
    child.stdout.end();

    queueMicrotask(() => {
      const error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      child.emit("error", error);
    });

    return child as never;
  }) as ClaudeCodeSpawn;

  const adapter = createClaudeCodeAdapter({}, spawnProcess);

  const events = [];
  for await (const event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "Claude Agent",
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
      error: "claude CLI not found — ensure Claude Code is installed",
    },
  ]);
});
