import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const devPort = Number(process.env.VITE_DEV_PORT ?? 5174);
const devHost = process.env.VITE_DEV_HOST ?? "127.0.0.1";
const apiTarget = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8787";
const wsTarget = process.env.VITE_WS_TARGET ?? apiTarget.replace(/^http/i, "ws");

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (id.includes("/antd/") || id.includes("/@ant-design/")) {
            return "antd-vendor";
          }

          if (id.includes("/react-markdown/") || id.includes("/remark-gfm/")) {
            return "markdown-vendor";
          }

          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/zustand/") ||
            id.includes("/i18next/") ||
            id.includes("/react-i18next/")
          ) {
            return "react-vendor";
          }

          return "vendor";
        },
      },
    },
  },
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
