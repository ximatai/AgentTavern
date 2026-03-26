import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const devPort = Number(process.env.VITE_DEV_PORT ?? 5173);
const devHost = process.env.VITE_DEV_HOST ?? "127.0.0.1";
const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8787";
const wsTarget = process.env.VITE_WS_TARGET ?? apiTarget.replace(/^http/i, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    host: devHost,
    port: devPort,
    proxy: {
      "/api": {
        target: apiTarget,
      },
      "/ws": {
        target: wsTarget,
        ws: true,
      },
    },
  },
});
