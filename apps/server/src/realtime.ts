import type { IncomingMessage } from "node:http";

import { eq } from "drizzle-orm";
import type { RealtimeEvent } from "@agent-tavern/shared";
import { WebSocket } from "ws";

import { db } from "./db/client";
import { members, citizens } from "./db/schema";
import { now } from "./routes/support";

type ConnectionContext = {
  memberId?: string;
  roomId?: string;
  citizenId?: string;
};

const roomSockets = new Map<string, Set<WebSocket>>();
const citizenSockets = new Map<string, Set<WebSocket>>();
const socketContexts = new Map<WebSocket, ConnectionContext>();
const wsTokens = new Map<string, { memberId: string; roomId: string; active: boolean }>();
const citizenTokens = new Map<string, { citizenId: string; active: boolean }>();

function syncCitizenPresence(citizenId: string, status: "online" | "offline"): void {
  db.update(citizens).set({ status }).where(eq(citizens.id, citizenId)).run();
  db.update(members).set({ presenceStatus: status }).where(eq(members.citizenId, citizenId)).run();
}

function broadcastLobbyPresenceChanged(
  changedCitizenId: string,
  status: "online" | "offline",
): void {
  const serialized = JSON.stringify({
    type: "lobby.presence.changed",
    citizenId: changedCitizenId,
    timestamp: now(),
    payload: {
      changedCitizenId,
      status,
    },
  } satisfies RealtimeEvent);

  for (const sockets of citizenSockets.values()) {
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

export function issueCitizenToken(citizenId: string): string {
  const token = crypto.randomUUID();

  citizenTokens.set(token, {
    citizenId,
    active: true,
  });

  return token;
}

export function verifyCitizenToken(citizenToken: string, citizenId: string): boolean {
  const tokenEntry = citizenTokens.get(citizenToken);

  return Boolean(tokenEntry && tokenEntry.active && tokenEntry.citizenId === citizenId);
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

export function revokeCitizenTokensForCitizen(citizenId: string): void {
  for (const [token, entry] of citizenTokens.entries()) {
    if (entry.citizenId === citizenId) {
      citizenTokens.set(token, { ...entry, active: false });
    }
  }
}

export function registerSocket(socket: WebSocket, request: IncomingMessage): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  const roomId = url.searchParams.get("roomId");
  const memberId = url.searchParams.get("memberId");
  const wsToken = url.searchParams.get("wsToken");
  const citizenId = url.searchParams.get("citizenId");
  const citizenToken = url.searchParams.get("citizenToken");

  if (citizenId && citizenToken) {
    const tokenEntry = citizenTokens.get(citizenToken);

    if (!tokenEntry || !tokenEntry.active || tokenEntry.citizenId !== citizenId) {
      socket.close(1008, "invalid citizen token");
      return false;
    }

    let sockets = citizenSockets.get(citizenId);

    if (!sockets) {
      sockets = new Set();
      citizenSockets.set(citizenId, sockets);
    }

    sockets.add(socket);
    socketContexts.set(socket, { citizenId });
    syncCitizenPresence(citizenId, "online");
    broadcastLobbyPresenceChanged(citizenId, "online");

    socket.on("close", () => {
      const context = socketContexts.get(socket);

      if (!context?.citizenId) {
        return;
      }

      const citizenSet = citizenSockets.get(context.citizenId);
      citizenSet?.delete(socket);

      if (citizenSet?.size === 0) {
        citizenSockets.delete(context.citizenId);
        syncCitizenPresence(context.citizenId, "offline");
        broadcastLobbyPresenceChanged(context.citizenId, "offline");
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

export function broadcastToCitizen(citizenId: string, event: RealtimeEvent): void {
  const sockets = citizenSockets.get(citizenId);

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

export function isCitizenOnline(citizenId: string): boolean {
  return (citizenSockets.get(citizenId)?.size ?? 0) > 0;
}
