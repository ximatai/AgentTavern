import type { IncomingMessage } from "node:http";

import { eq } from "drizzle-orm";
import type { RealtimeEvent } from "@agent-tavern/shared";
import { WebSocket } from "ws";

import { db } from "./db/client";
import { members, principals } from "./db/schema";
import { now } from "./routes/support";

type ConnectionContext = {
  memberId?: string;
  roomId?: string;
  principalId?: string;
};

const roomSockets = new Map<string, Set<WebSocket>>();
const principalSockets = new Map<string, Set<WebSocket>>();
const socketContexts = new Map<WebSocket, ConnectionContext>();
const wsTokens = new Map<string, { memberId: string; roomId: string; active: boolean }>();
const principalTokens = new Map<string, { principalId: string; active: boolean }>();

function syncPrincipalPresence(principalId: string, status: "online" | "offline"): void {
  db.update(principals).set({ status }).where(eq(principals.id, principalId)).run();
  db.update(members).set({ presenceStatus: status }).where(eq(members.principalId, principalId)).run();
}

function broadcastLobbyPresenceChanged(
  changedPrincipalId: string,
  status: "online" | "offline",
): void {
  const serialized = JSON.stringify({
    type: "lobby.presence.changed",
    principalId: changedPrincipalId,
    timestamp: now(),
    payload: {
      changedPrincipalId,
      status,
    },
  } satisfies RealtimeEvent);

  for (const sockets of principalSockets.values()) {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(serialized);
      }
    }
  }
}

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

export function revokePrincipalTokensForPrincipal(principalId: string): void {
  for (const [token, entry] of principalTokens.entries()) {
    if (entry.principalId === principalId) {
      principalTokens.set(token, { ...entry, active: false });
    }
  }
}

export function registerSocket(socket: WebSocket, request: IncomingMessage): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  const roomId = url.searchParams.get("roomId");
  const memberId = url.searchParams.get("memberId");
  const wsToken = url.searchParams.get("wsToken");
  const principalId = url.searchParams.get("principalId");
  const principalToken = url.searchParams.get("principalToken");

  if (principalId && principalToken) {
    const tokenEntry = principalTokens.get(principalToken);

    if (!tokenEntry || !tokenEntry.active || tokenEntry.principalId !== principalId) {
      socket.close(1008, "invalid principal token");
      return false;
    }

    let sockets = principalSockets.get(principalId);

    if (!sockets) {
      sockets = new Set();
      principalSockets.set(principalId, sockets);
    }

    sockets.add(socket);
    socketContexts.set(socket, { principalId });
    syncPrincipalPresence(principalId, "online");
    broadcastLobbyPresenceChanged(principalId, "online");

    socket.on("close", () => {
      const context = socketContexts.get(socket);

      if (!context?.principalId) {
        return;
      }

      const principalSet = principalSockets.get(context.principalId);
      principalSet?.delete(socket);

      if (principalSet?.size === 0) {
        principalSockets.delete(context.principalId);
        syncPrincipalPresence(context.principalId, "offline");
        broadcastLobbyPresenceChanged(context.principalId, "offline");
      }

      socketContexts.delete(socket);
    });

    return true;
  }

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

    if (!context?.roomId) {
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

export function broadcastToPrincipal(principalId: string, event: RealtimeEvent): void {
  const sockets = principalSockets.get(principalId);

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

export function isPrincipalOnline(principalId: string): boolean {
  return (principalSockets.get(principalId)?.size ?? 0) > 0;
}
