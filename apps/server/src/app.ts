import { Hono } from "hono";

import { approvalRoutes } from "./routes/approvals";
import { attachmentRoutes } from "./routes/attachments";
import { bridgeRoutes } from "./routes/bridges";
import { bridgeTaskRoutes } from "./routes/bridge-tasks";
import { memberRoutes } from "./routes/members";
import { messageRoutes } from "./routes/messages";
import { privateAssistantRoutes } from "./routes/private-assistants";
import { principalRoutes } from "./routes/principals";
import { roomRoutes } from "./routes/rooms";

const app = new Hono();

app.get("/healthz", (c) => {
  return c.json({
    ok: true,
    service: "agent-tavern-server",
  });
});

app.get("/", (c) => {
  return c.json({
    name: "AgentTavern",
    status: "bootstrapped",
  });
});

app.route("/", roomRoutes);
app.route("/", principalRoutes);
app.route("/", privateAssistantRoutes);
app.route("/", attachmentRoutes);
app.route("/", bridgeRoutes);
app.route("/", bridgeTaskRoutes);
app.route("/", memberRoutes);
app.route("/", messageRoutes);
app.route("/", approvalRoutes);

export { app };
