import type { AgentSession } from "./domain";
import type { PublicApproval, PublicMember, PublicMessage } from "./dto";

export type RoomEvent =
  | {
      type: "member.joined";
      roomId: string;
      timestamp: string;
      payload: { member: PublicMember };
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
      payload: { member: PublicMember };
    };

export type MessageEvent =
  | {
      type: "message.created";
      roomId: string;
      timestamp: string;
      payload: { message: PublicMessage };
    }
  | {
      type: "message.updated";
      roomId: string;
      timestamp: string;
      payload: { message: PublicMessage };
    };

export type ApprovalEvent =
  | {
      type: "approval.requested";
      roomId: string;
      timestamp: string;
      payload: { approval: PublicApproval };
    }
  | {
      type: "approval.resolved";
      roomId: string;
      timestamp: string;
      payload: { approval: PublicApproval };
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
        message: PublicMessage;
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
