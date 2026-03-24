import type { AgentSession, Approval, Member, Message } from "./domain";

export type RoomEvent =
  | {
      type: "member.joined";
      roomId: string;
      timestamp: string;
      payload: { member: Member };
    }
  | {
      type: "member.left";
      roomId: string;
      timestamp: string;
      payload: { memberId: string };
    }
  | {
      type: "member.updated";
      roomId: string;
      timestamp: string;
      payload: { member: Member };
    };

export type MessageEvent =
  | {
      type: "message.created";
      roomId: string;
      timestamp: string;
      payload: { message: Message };
    }
  | {
      type: "message.updated";
      roomId: string;
      timestamp: string;
      payload: { message: Message };
    };

export type ApprovalEvent =
  | {
      type: "approval.requested";
      roomId: string;
      timestamp: string;
      payload: { approval: Approval };
    }
  | {
      type: "approval.resolved";
      roomId: string;
      timestamp: string;
      payload: { approval: Approval };
    };

export type AgentSessionEvent =
  | {
      type: "agent.session.started";
      roomId: string;
      timestamp: string;
      payload: { session: AgentSession };
    }
  | {
      type: "agent.stream.delta";
      roomId: string;
      timestamp: string;
      payload: {
        sessionId: string;
        messageId: string;
        delta: string;
      };
    }
  | {
      type: "agent.message.committed";
      roomId: string;
      timestamp: string;
      payload: {
        sessionId: string;
        message: Message;
      };
    }
  | {
      type: "agent.session.completed";
      roomId: string;
      timestamp: string;
      payload: { session: AgentSession };
    }
  | {
      type: "agent.session.failed";
      roomId: string;
      timestamp: string;
      payload: {
        session: AgentSession;
        error: string;
      };
    };

export type RealtimeEvent =
  | RoomEvent
  | MessageEvent
  | ApprovalEvent
  | AgentSessionEvent;
