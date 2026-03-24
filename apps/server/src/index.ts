import type { Server as HttpServer } from "node:http";

import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";

import { app } from "./app";

const port = Number(process.env.PORT ?? 8787);

const server = serve({
  fetch: app.fetch,
  port,
});

const wss = new WebSocketServer({ server: server as HttpServer });

wss.on("connection", (socket: WebSocket) => {
  socket.send(
    JSON.stringify({
      type: "system.connected",
      payload: {
        message: "AgentTavern realtime server connected",
      },
    }),
  );
});

console.log(`server listening on http://localhost:${port}`);
