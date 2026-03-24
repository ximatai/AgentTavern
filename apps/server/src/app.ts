import { Hono } from "hono";

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

export { app };

