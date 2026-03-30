import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAICompatibleAdapter, type OpenAICompatibleFetch } from "./openai-compatible";

test("createOpenAICompatibleAdapter streams SSE deltas", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchFn: OpenAICompatibleFetch = (async (url, init) => {
    calls.push({ url: String(url), init });

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"Hello "}}]}\n',
              'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"world"}}]}\n',
              "data: [DONE]\n",
            ].join(""),
          ),
        );
        controller.close();
      },
    });

    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as OpenAICompatibleFetch;

  const adapter = createOpenAICompatibleAdapter(
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen-local",
      apiKey: "demo-key",
      headers: { "x-demo": "1" },
      temperature: 0.2,
      maxTokens: 512,
    },
    fetchFn,
  );

  const events = [];
  for await (const event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "Local Model",
    requesterMemberId: "user_1",
    requesterDisplayName: "Requester",
    triggerMessageId: "msg_1",
    prompt: "say hello",
    contextMessages: [],
  })) {
    events.push(event);
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:1234/v1/chat/completions");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    model: "qwen-local",
    stream: true,
    messages: [{ role: "user", content: "say hello" }],
    temperature: 0.2,
    max_tokens: 512,
  });
  assert.deepEqual(calls[0]?.init?.headers, {
    "content-type": "application/json",
    accept: "text/event-stream",
    "x-demo": "1",
    authorization: "Bearer demo-key",
  });
  assert.deepEqual(events, [
    { type: "delta", text: "Hello " },
    { type: "delta", text: "world" },
    { type: "completed" },
  ]);
});

test("createOpenAICompatibleAdapter reports non-2xx responses clearly", async () => {
  const fetchFn: OpenAICompatibleFetch = (async () =>
    new Response('{"error":"bad model"}', {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as OpenAICompatibleFetch;

  const adapter = createOpenAICompatibleAdapter(
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "missing-model",
    },
    fetchFn,
  );

  const events = [];
  for await (const event of adapter.run({
    roomId: "room_1",
    agentMemberId: "agent_1",
    agentDisplayName: "Local Model",
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
      error: 'openai-compatible backend request failed (400): {"error":"bad model"}',
    },
  ]);
});
