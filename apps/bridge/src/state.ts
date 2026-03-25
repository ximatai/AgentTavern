import fs from "node:fs";
import path from "node:path";

export type BridgeIdentity = {
  bridgeId: string;
  bridgeToken: string;
};

export function readStoredBridgeIdentity(input: {
  bridgeStatePath: string;
  configuredBridgeId?: string;
  configuredBridgeToken?: string;
  logger?: Pick<Console, "warn">;
}): BridgeIdentity | null {
  const configuredBridgeId = input.configuredBridgeId?.trim() ?? "";
  const configuredBridgeToken = input.configuredBridgeToken?.trim() ?? "";

  if (configuredBridgeId && configuredBridgeToken) {
    return {
      bridgeId: configuredBridgeId,
      bridgeToken: configuredBridgeToken,
    };
  }

  if (!fs.existsSync(input.bridgeStatePath)) {
    return null;
  }

  try {
    const raw = JSON.parse(
      fs.readFileSync(input.bridgeStatePath, "utf8"),
    ) as Partial<BridgeIdentity>;

    if (
      typeof raw.bridgeId === "string" &&
      raw.bridgeId.trim() &&
      typeof raw.bridgeToken === "string" &&
      raw.bridgeToken.trim()
    ) {
      return {
        bridgeId: raw.bridgeId.trim(),
        bridgeToken: raw.bridgeToken.trim(),
      };
    }
  } catch (error) {
    input.logger?.warn(
      `[bridge] failed to read persisted identity at ${input.bridgeStatePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return null;
}

export function persistBridgeIdentity(
  bridgeStatePath: string,
  identity: BridgeIdentity,
): void {
  fs.mkdirSync(path.dirname(bridgeStatePath), { recursive: true });
  fs.writeFileSync(bridgeStatePath, JSON.stringify(identity, null, 2));
}
