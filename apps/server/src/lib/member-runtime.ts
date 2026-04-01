import { localBridges } from "../db/schema";

export const BRIDGE_STALE_AFTER_MS = Number(process.env.AGENT_TAVERN_BRIDGE_STALE_AFTER_MS ?? 20_000);

type RuntimeMember = {
  type: string;
  adapterType: string | null;
};

type RuntimeBinding = {
  bridgeId: string | null;
  status: string;
} | null;

type RuntimeBridge = typeof localBridges.$inferSelect | null;

export function backendRequiresBridge(adapterType: string | null): boolean {
  return adapterType === "codex_cli" || adapterType === "claude_code" || adapterType === "opencode";
}

export function isBridgeFresh(bridge?: RuntimeBridge): boolean {
  if (!bridge || bridge.status !== "online") {
    return false;
  }

  return Date.now() - new Date(bridge.lastSeenAt).getTime() <= BRIDGE_STALE_AFTER_MS;
}

export function resolveMemberRuntimeStatus(
  member: RuntimeMember,
  binding?: RuntimeBinding,
  bridge?: RuntimeBridge,
): "ready" | "pending_bridge" | "waiting_bridge" | null {
  if (member.type !== "agent") {
    return null;
  }

  if (member.adapterType === "local_process" || member.adapterType === "openai_compatible") {
    return "ready";
  }

  if (!backendRequiresBridge(member.adapterType)) {
    return null;
  }

  if (!binding || binding.status === "pending_bridge" || !binding.bridgeId) {
    return "pending_bridge";
  }

  if (binding.status !== "active") {
    return "waiting_bridge";
  }

  if (!bridge || bridge.status !== "online") {
    return "waiting_bridge";
  }

  return isBridgeFresh(bridge) ? "ready" : "waiting_bridge";
}
