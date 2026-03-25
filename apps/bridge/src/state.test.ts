import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { persistBridgeIdentity, readStoredBridgeIdentity } from "./state.js";

function createTempStatePath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tavern-bridge-state-"));
  return path.join(tempDir, "bridge-state.json");
}

test("readStoredBridgeIdentity prefers configured env identity", () => {
  const statePath = createTempStatePath();
  persistBridgeIdentity(statePath, {
    bridgeId: "brg_file",
    bridgeToken: "tok_file",
  });

  const identity = readStoredBridgeIdentity({
    bridgeStatePath: statePath,
    configuredBridgeId: "brg_env",
    configuredBridgeToken: "tok_env",
  });

  assert.deepEqual(identity, {
    bridgeId: "brg_env",
    bridgeToken: "tok_env",
  });
});

test("persistBridgeIdentity round-trips with readStoredBridgeIdentity", () => {
  const statePath = createTempStatePath();

  persistBridgeIdentity(statePath, {
    bridgeId: "brg_roundtrip",
    bridgeToken: "tok_roundtrip",
  });

  const identity = readStoredBridgeIdentity({
    bridgeStatePath: statePath,
  });

  assert.deepEqual(identity, {
    bridgeId: "brg_roundtrip",
    bridgeToken: "tok_roundtrip",
  });
});

test("readStoredBridgeIdentity returns null for malformed state file", () => {
  const statePath = createTempStatePath();
  fs.writeFileSync(statePath, "{not-json");

  const warnings: string[] = [];
  const identity = readStoredBridgeIdentity({
    bridgeStatePath: statePath,
    logger: { warn: (message: string) => warnings.push(message) },
  });

  assert.equal(identity, null);
  assert.equal(warnings.length, 1);
});
