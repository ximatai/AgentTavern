export type AgentRunInput = {
  roomId: string;
  agentMemberId: string;
  agentDisplayName: string;
  requesterMemberId: string;
  requesterDisplayName: string;
  triggerMessageId: string;
  prompt: string;
  contextMessages: Array<{
    senderName: string;
    content: string;
    createdAt: string;
  }>;
};

export type AgentStreamEvent =
  | { type: "delta"; text: string }
  | { type: "completed"; finalText?: string }
  | { type: "failed"; error: string };

export interface AgentAdapter {
  run(input: AgentRunInput): AsyncIterable<AgentStreamEvent>;
}

export * from "./local-process";
