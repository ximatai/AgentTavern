export type AgentGeneratedAttachment = {
  name: string;
  mimeType: string;
  contentBase64: string;
};

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
  | {
      type: "completed";
      finalText?: string;
      sessionId?: string;
      attachments?: AgentGeneratedAttachment[];
    }
  | { type: "failed"; error: string };

export interface AgentAdapter {
  run(input: AgentRunInput): AsyncIterable<AgentStreamEvent>;
}

export * from "./claude-code";
export * from "./codex-cli";
export * from "./local-process";
export * from "./opencode";
