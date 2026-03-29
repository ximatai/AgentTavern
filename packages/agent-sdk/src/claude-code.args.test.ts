import assert from "node:assert/strict";
import test from "node:test";

import {
  createClaudeCodeAdapter,
  type ClaudeCodeSpawn,
} from "./claude-code";
import { FakeChildProcess } from "./test-helpers";

test("createClaudeCodeAdapter includes --verbose for stream-json mode", async () => {
  let observedArgs: ReadonlyArray<string> | undefined;

  const spawnProcess: ClaudeCodeSpawn = ((_, args) => {
    observedArgs = args;
    const child = new FakeChildProcess();

    queueMicrotask(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          result: "OK",
          session_id: "session_1",
        })}\n`,
      );
      child.stdout.end();
      child.emit("close", 0);
    });

    return child as never;
  }) as ClaudeCodeSpawn;

  const adapter = createClaudeCodeAdapter({}, spawnProcess);

  for await (const _event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "Claude Agent",
    requesterMemberId: "user_1",
    requesterDisplayName: "Requester",
    triggerMessageId: "msg_1",
    prompt: "say hello",
    contextMessages: [],
  })) {
    // consume stream
  }

  assert.ok(observedArgs);
  assert.deepEqual(observedArgs?.slice(0, 6), [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--dangerously-skip-permissions",
  ]);
});
