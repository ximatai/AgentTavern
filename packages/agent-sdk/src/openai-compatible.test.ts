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

test("createOpenAICompatibleAdapter falls back to non-streaming JSON responses", async () => {
  const fetchFn: OpenAICompatibleFetch = (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl_sync",
        choices: [
          {
            message: {
              role: "assistant",
              content: "hello from json",
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as OpenAICompatibleFetch;

  const adapter = createOpenAICompatibleAdapter(
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen-local",
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

  assert.deepEqual(events, [{ type: "completed", finalText: "hello from json" }]);
});

test("createOpenAICompatibleAdapter reports JSON error payloads even when HTTP status is 200", async () => {
  const fetchFn: OpenAICompatibleFetch = (async () =>
    new Response(
      JSON.stringify({
        error: "Unexpected endpoint or method. (POST /chat/completions)",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )) as OpenAICompatibleFetch;

  const adapter = createOpenAICompatibleAdapter(
    {
      baseUrl: "http://127.0.0.1:1234",
      model: "qwen-local",
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
      error: "openai-compatible backend error: Unexpected endpoint or method. (POST /chat/completions)",
    },
  ]);
});

test("createOpenAICompatibleAdapter emits reasoning deltas separately", async () => {
  const fetchFn: OpenAICompatibleFetch = (async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"choices":[{"delta":{"reasoning_content":"think "},"finish_reason":null}]}\n',
              'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n',
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
    { type: "reasoning", text: "think " },
    { type: "delta", text: "answer" },
    { type: "completed" },
  ]);
});

test("createOpenAICompatibleAdapter sends image attachments as multimodal input", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: OpenAICompatibleFetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "looks like an image",
            },
            finish_reason: "stop",
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as OpenAICompatibleFetch;

  const adapter = createOpenAICompatibleAdapter(
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "gemma-local",
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
    prompt: "Describe the attached image.",
    triggerAttachments: [
      {
        name: "photo.png",
        mimeType: "image/png",
        url: "/api/attachments/att_1/content",
        dataUrl: "data:image/png;base64,AAAA",
      },
    ],
    contextMessages: [],
  })) {
    events.push(event);
  }

  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    model: "gemma-local",
    stream: true,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe the attached image." },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ],
  });
  assert.deepEqual(events, [{ type: "completed", finalText: "looks like an image" }]);
});
