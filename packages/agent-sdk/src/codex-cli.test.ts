import assert from "node:assert/strict";
import test from "node:test";

import { createCodexCliAdapter, type CodexCliSpawn } from "./codex-cli";
import { FakeChildProcess } from "./test-helpers";

test("createCodexCliAdapter reports a clear failure when codex is not installed", async () => {
  const spawnProcess: CodexCliSpawn = (() => {
    const child = new FakeChildProcess();
    child.stdout.end();

    queueMicrotask(() => {
      const error = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
      child.emit("error", error);
    });

    return child as never;
  }) as CodexCliSpawn;

  const adapter = createCodexCliAdapter({ threadId: "thread_test" }, spawnProcess);

  const events = [];
  for await (const event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "Codex Agent",
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
      error: "codex CLI not found — ensure Codex is installed",
    },
  ]);
});
