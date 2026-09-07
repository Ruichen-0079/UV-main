import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { dailyStatusPlugin } from "./src/daily-status-plugin.js";

const webHost = process.env["YUVI_WEB_HOST"] ?? process.env["WEB_HOST"] ?? "127.0.0.1";
const webPort = Number.parseInt(
  process.env["YUVI_WEB_PORT"] ?? process.env["WEB_PORT"] ?? "5173",
  10
);

if (webHost === "0.0.0.0") {
  console.warn("[web] YUVI_WEB_HOST=0.0.0.0 exposes the dev dashboard on the local network.");
}

export default defineConfig({
  // Relative asset URLs work in both Vite dev and Tauri asset protocol.
  base: "./",
  define: {
    "import.meta.env.YUVI_DAILY_USE": JSON.stringify(process.env["YUVI_DAILY_USE_SYSTEMD"] === "1")
  },
  plugins: [react(), dailyStatusPlugin()],
  server: {
    host: webHost,
    port: webPort,
    proxy: {
      "/api": {
        target: `http://${process.env["SERVER_HOST"] ?? "127.0.0.1"}:${process.env["SERVER_PORT"] ?? "6121"}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      },
      "/live2d": {
        target: `http://${process.env["SERVER_HOST"] ?? "127.0.0.1"}:${process.env["SERVER_PORT"] ?? "6121"}`,
        changeOrigin: true
      }
    }
  },
  preview: {
    host: webHost,
    port: webPort
  }
});
