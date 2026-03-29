import { request } from "./client";

export type PrincipalSession = {
  principalId: string;
  principalToken: string;
  kind: "human" | "agent";
  loginKey: string;
  globalDisplayName: string;
  backendType: "codex_cli" | "claude_code" | "local_process" | "opencode" | null;
  backendThreadId: string | null;
  status: "online" | "offline";
};

export type LobbyPrincipal = PrincipalSession & {
  id: string;
  createdAt: string;
  runtimeStatus: "ready" | "pending_bridge" | "waiting_bridge" | null;
};

async function bootstrapPrincipal(params: {
  kind: "human" | "agent";
  loginKey: string;
  globalDisplayName: string;
  backendType: "codex_cli" | "claude_code" | "local_process" | "opencode" | null;
  backendThreadId: string | null;
}): Promise<PrincipalSession> {
  return request<PrincipalSession>("/api/principals/bootstrap", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

async function getLobbyPresence(): Promise<{ principals: LobbyPrincipal[] }> {
  return request<{ principals: LobbyPrincipal[] }>("/api/presence/lobby");
}

export { bootstrapPrincipal, getLobbyPresence };
