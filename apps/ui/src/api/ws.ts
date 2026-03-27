import type { RealtimeEvent } from "@agent-tavern/shared";

function buildWsUrl(params: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws?${params}`;
}

function createRoomSocket(roomId: string, memberId: string, wsToken: string): WebSocket {
  return new WebSocket(buildWsUrl(`roomId=${roomId}&memberId=${memberId}&wsToken=${wsToken}`));
}

function createPrincipalSocket(principalId: string, principalToken: string): WebSocket {
  return new WebSocket(buildWsUrl(`principalId=${principalId}&principalToken=${principalToken}`));
}

function isRealtimeEvent(payload: unknown): payload is RealtimeEvent {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return "type" in payload && typeof payload.type === "string" && "payload" in payload;
}

export { createRoomSocket, createPrincipalSocket, isRealtimeEvent };
