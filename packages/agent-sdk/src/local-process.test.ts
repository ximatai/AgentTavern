import assert from "node:assert/strict";
import test from "node:test";

import { createLocalProcessAdapter } from "./local-process";

test("createLocalProcessAdapter supports jsonl output with generated attachments", async () => {
  const adapter = createLocalProcessAdapter({
    command: "node",
    args: [
      "-e",
      [
        "const lines = [",
        "  JSON.stringify({ type: 'delta', text: 'hello ' }),",
        "  JSON.stringify({ type: 'completed', finalText: 'hello world', attachments: [{ name: 'report.txt', mimeType: 'text/plain', contentBase64: Buffer.from('report body').toString('base64') }] })",
        "];",
        "process.stdout.write(lines.join('\\n'));",
      ].join(" "),
    ],
    outputFormat: "jsonl",
  });

  const events = [];
  for await (const event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "Local Agent",
    requesterMemberId: "user_1",
    requesterDisplayName: "Requester",
    triggerMessageId: "msg_1",
    prompt: "say hello",
    contextMessages: [],
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: "delta", text: "hello " },
    {
      type: "completed",
      finalText: "hello world",
      attachments: [
        {
          name: "report.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from("report body").toString("base64"),
        },
      ],
    },
  ]);
});

test("createLocalProcessAdapter supports jsonl structured room summaries", async () => {
  const adapter = createLocalProcessAdapter({
    command: "node",
    args: [
      "-e",
      [
        "const lines = [",
        "  JSON.stringify({ type: 'completed', finalText: 'I will ask @Planner next.', summaryText: 'Need planner draft and owner confirmation.' })",
        "];",
        "process.stdout.write(lines.join('\\n'));",
      ].join(" "),
    ],
    outputFormat: "jsonl",
  });

  const events = [];
  for await (const event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "Local Agent",
    requesterMemberId: "user_1",
    requesterDisplayName: "Requester",
    triggerMessageId: "msg_1",
    prompt: "summarize",
    contextMessages: [],
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    {
      type: "completed",
      finalText: "I will ask @Planner next.",
      summaryText: "Need planner draft and owner confirmation.",
    },
  ]);
});

test("createLocalProcessAdapter supports structured mention targets", async () => {
  const adapter = createLocalProcessAdapter({
    command: "node",
    args: [
      "-e",
      [
        "const lines = [",
        "  JSON.stringify({ type: 'completed', finalText: 'Please take the next turn.', mentionedDisplayNames: ['Planner'] })",
        "];",
        "process.stdout.write(lines.join('\\n'));",
      ].join(" "),
    ],
    outputFormat: "jsonl",
  });

  const events = [];
  for await (const event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "Local Agent",
    requesterMemberId: "user_1",
    requesterDisplayName: "Requester",
    triggerMessageId: "msg_1",
    prompt: "handoff",
    contextMessages: [],
  })) {
    events.push(event);
  }

  assert.deepEqual(events, [
    {
      type: "completed",
      finalText: "Please take the next turn.",
      mentionedDisplayNames: ["Planner"],
    },
  ]);
});
