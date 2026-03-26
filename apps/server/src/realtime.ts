import type { IncomingMessage } from "node:http";

import type { RealtimeEvent } from "@agent-tavern/shared";
import { WebSocket } from "ws";

type ConnectionContext = {
  memberId: string;
  roomId: string;
};

const roomSockets = new Map<string, Set<WebSocket>>();
const socketContexts = new Map<WebSocket, ConnectionContext>();
const wsTokens = new Map<string, { memberId: string; roomId: string; active: boolean }>();
const principalTokens = new Map<string, { principalId: string; active: boolean }>();

export function issueWsToken(memberId: string, roomId: string): string {
  const token = crypto.randomUUID();

  wsTokens.set(token, {
    memberId,
    roomId,
    active: true,
  });

  return token;
}

export function issuePrincipalToken(principalId: string): string {
  const token = crypto.randomUUID();

  principalTokens.set(token, {
    principalId,
    active: true,
  });

  return token;
}

export function verifyPrincipalToken(principalToken: string, principalId: string): boolean {
  const tokenEntry = principalTokens.get(principalToken);

  return Boolean(tokenEntry && tokenEntry.active && tokenEntry.principalId === principalId);
}

export function verifyWsToken(
  wsToken: string,
  memberId: string,
  roomId: string,
): boolean {
  const tokenEntry = wsTokens.get(wsToken);

  return Boolean(
    tokenEntry &&
      tokenEntry.active &&
      tokenEntry.memberId === memberId &&
      tokenEntry.roomId === roomId,
  );
}

export function revokeWsTokensForMember(memberId: string, roomId: string): void {
  for (const [token, entry] of wsTokens.entries()) {
    if (entry.memberId === memberId && entry.roomId === roomId) {
      wsTokens.set(token, { ...entry, active: false });
    }
  }
}

export function registerSocket(socket: WebSocket, request: IncomingMessage): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  const roomId = url.searchParams.get("roomId");
  const memberId = url.searchParams.get("memberId");
  const wsToken = url.searchParams.get("wsToken");

  if (!roomId || !memberId || !wsToken) {
    socket.close(1008, "missing connection params");
    return false;
  }

  const tokenEntry = wsTokens.get(wsToken);

  if (
    !tokenEntry ||
    !tokenEntry.active ||
    tokenEntry.memberId !== memberId ||
    tokenEntry.roomId !== roomId
  ) {
    socket.close(1008, "invalid ws token");
    return false;
  }

  let sockets = roomSockets.get(roomId);

  if (!sockets) {
    sockets = new Set();
    roomSockets.set(roomId, sockets);
  }

  sockets.add(socket);
  socketContexts.set(socket, { roomId, memberId });

  socket.on("close", () => {
    const context = socketContexts.get(socket);

    if (!context) {
      return;
    }

    const roomSet = roomSockets.get(context.roomId);
    roomSet?.delete(socket);

    if (roomSet?.size === 0) {
      roomSockets.delete(context.roomId);
    }

    socketContexts.delete(socket);
  });

  return true;
}

export function broadcastToRoom(roomId: string, event: RealtimeEvent): void {
  const sockets = roomSockets.get(roomId);

  if (!sockets) {
    return;
  }

  const serialized = JSON.stringify(event);

  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(serialized);
    }
  }
}

export function isMemberOnline(memberId: string, roomId: string): boolean {
  for (const context of socketContexts.values()) {
    if (context.memberId === memberId && context.roomId === roomId) {
      return true;
    }
  }

  return false;
}
