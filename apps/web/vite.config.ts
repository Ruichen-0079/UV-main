import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number.parseInt(process.env["WEB_PORT"] ?? "5173", 10),
    proxy: {
      "/api": {
        target: `http://${process.env["SERVER_HOST"] ?? "127.0.0.1"}:${process.env["SERVER_PORT"] ?? "6121"}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  }
});
