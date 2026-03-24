import { Hono } from "hono";

import { approvalRoutes } from "./routes/approvals";
import { assistantInviteRoutes } from "./routes/assistant-invites";
import { memberRoutes } from "./routes/members";
import { messageRoutes } from "./routes/messages";
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
app.route("/", assistantInviteRoutes);
app.route("/", memberRoutes);
app.route("/", messageRoutes);
app.route("/", approvalRoutes);

export { app };
