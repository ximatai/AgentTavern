import type { RealtimeEvent } from "@agent-tavern/shared";

function resolveWsBaseUrl(): string {
  const explicitBase = import.meta.env.VITE_WS_BASE_URL as string | undefined;
  if (explicitBase) {
    return explicitBase.replace(/\/$/, "");
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  // Safari can drop proxied WS connections through the Vite dev server.
  // In local dev, connect to the backend WS endpoint directly instead.
  if (import.meta.env.DEV) {
    return `${protocol}//${window.location.hostname}:8787`;
  }

  return `${protocol}//${window.location.host}`;
}

function buildWsUrl(params: string): string {
  return `${resolveWsBaseUrl()}/ws?${params}`;
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
