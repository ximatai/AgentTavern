import assert from "node:assert/strict";
import test from "node:test";

import type { AgentSession } from "@agent-tavern/shared";

import { handleEvent } from "./useRoomWebSocket";
import { useMessageStore } from "../stores/message";
import { useSessionStore } from "../stores/session";

const session: AgentSession = {
  id: "sess_reasoning_ui",
  roomId: "room_reasoning_ui",
  agentMemberId: "mem_agent_reasoning_ui",
  triggerMessageId: "msg_trigger_reasoning_ui",
  requesterMemberId: "mem_requester_reasoning_ui",
  approvalId: null,
  approvalRequired: false,
  kind: "message_reply",
  status: "running",
  startedAt: "2026-04-01T08:00:00.000Z",
  endedAt: null,
};

test("handleEvent routes reasoning deltas into the session and message stores", () => {
  useMessageStore.getState().reset();
  useSessionStore.getState().reset();
  useSessionStore.getState().startSession(session);

  handleEvent({
    type: "agent.stream.reasoning",
    roomId: session.roomId,
    timestamp: "2026-04-01T08:00:01.000Z",
    payload: {
      sessionId: session.id,
      messageId: "msg_reasoning_ui",
      delta: "thinking...",
    },
  });

  handleEvent({
    type: "agent.stream.reasoning",
    roomId: session.roomId,
    timestamp: "2026-04-01T08:00:02.000Z",
    payload: {
      sessionId: session.id,
      messageId: "msg_reasoning_ui",
      delta: " more",
    },
  });

  const snapshot = useSessionStore.getState().sessionSnapshots[session.id];
  const stream = useMessageStore.getState().streams.msg_reasoning_ui;

  assert.equal(snapshot?.reasoningText, "thinking... more");
  assert.equal(stream?.reasoningContent, "thinking... more");
  assert.equal(stream?.content, "");
  assert.equal(stream?.sessionId, session.id);
  assert.equal(stream?.senderMemberId, session.agentMemberId);
});
