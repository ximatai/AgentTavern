export type BridgeMetadata = {
  providers: string[];
  hostname: string | null;
  taskLoopEnabled: boolean;
};

export function buildBridgeMetadata(input: {
  taskLoopEnabled: boolean;
  hostname?: string | null;
  providers?: string[];
}): BridgeMetadata {
  return {
    providers: input.providers ?? [],
    hostname: input.hostname ?? null,
    taskLoopEnabled: input.taskLoopEnabled,
  };
}
