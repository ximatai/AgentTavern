import assert from "node:assert/strict";
import test from "node:test";

import { buildBridgeMetadata } from "./metadata.js";

test("buildBridgeMetadata preserves static and dynamic fields for heartbeat reuse", () => {
  assert.deepEqual(
    buildBridgeMetadata({
      providers: ["codex", "local_process"],
      hostname: "alice-laptop",
      taskLoopEnabled: true,
    }),
    {
      providers: ["codex", "local_process"],
      hostname: "alice-laptop",
      taskLoopEnabled: true,
    },
  );
});
