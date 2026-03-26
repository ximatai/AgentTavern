import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const workspaceDir = path.dirname(fileURLToPath(import.meta.url));
const e2eTmpDir = path.join(workspaceDir, ".tmp-e2e");
const e2eDbPath = path.join(e2eTmpDir, "agent-tavern.db");
const e2eAttachmentsDir = path.join(e2eTmpDir, "attachments");
const e2eServerPort = 18787;
const e2eWebPort = 15173;

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${e2eWebPort}`,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `rm -rf "${e2eTmpDir}" && PORT=${e2eServerPort} AGENT_TAVERN_DB_PATH="${e2eDbPath}" AGENT_TAVERN_ATTACHMENTS_DIR="${e2eAttachmentsDir}" pnpm --filter @agent-tavern/server db:migrate && PORT=${e2eServerPort} AGENT_TAVERN_DB_PATH="${e2eDbPath}" AGENT_TAVERN_ATTACHMENTS_DIR="${e2eAttachmentsDir}" pnpm dev:server`,
      url: `http://127.0.0.1:${e2eServerPort}/healthz`,
      reuseExistingServer: false,
    },
    {
      command: `VITE_DEV_PORT=${e2eWebPort} VITE_API_TARGET="http://127.0.0.1:${e2eServerPort}" VITE_WS_TARGET="ws://127.0.0.1:${e2eServerPort}" pnpm dev:web`,
      url: `http://127.0.0.1:${e2eWebPort}`,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
});
