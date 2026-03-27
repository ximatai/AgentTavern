import type { Server as HttpServer } from "node:http";

import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";

import { app } from "./app";
import { runMigrations } from "./db/migrate";
import { registerSocket } from "./realtime";
import { recoverRuntimeState } from "./runtime/recovery";

const port = Number(process.env.PORT ?? 8787);
const migratedPath = runMigrations();
const recoveryResult = recoverRuntimeState();

const server = serve({
  fetch: app.fetch,
  port,
});

const wss = new WebSocketServer({ server: server as HttpServer });

wss.on("connection", (socket: WebSocket, request) => {
  if (!registerSocket(socket, request)) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: "system.connected",
      payload: {
        message: "AgentTavern realtime server connected",
      },
    }),
  );
});

if (
  recoveryResult.expiredApprovals > 0 ||
  recoveryResult.rejectedSessions > 0 ||
  recoveryResult.systemMessages > 0 ||
  recoveryResult.expiredDraftAttachments > 0 ||
  recoveryResult.expiredBridgeTasks > 0
) {
  console.log(
    `runtime recovery: expiredApprovals=${recoveryResult.expiredApprovals} rejectedSessions=${recoveryResult.rejectedSessions} systemMessages=${recoveryResult.systemMessages} expiredDraftAttachments=${recoveryResult.expiredDraftAttachments} expiredBridgeTasks=${recoveryResult.expiredBridgeTasks}`,
  );
}

console.log(`server listening on http://localhost:${port}`);
console.log(`database ready: ${migratedPath}`);
