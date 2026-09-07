import fs from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { defaultStateDirectory } from "@companion/desktop-supervisor";
import { DAILY_STATUS_PATH, projectDailyServiceStatus } from "./daily-service-status.js";

/** Server-side read-only bridge for the Linux checkout launcher, independent of Runtime. */
export function dailyStatusPlugin(): Plugin {
  return {
    name: "yuvi-daily-status",
    configureServer(server) {
      if (process.env["YUVI_DAILY_USE_SYSTEMD"] !== "1") return;
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== DAILY_STATUS_PATH) return next();
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end('{"error":"Read-only status"}');
          return;
        }
        try {
          const pointer = JSON.parse(
            await fs.readFile(path.join(defaultStateDirectory(), "active-instance.json"), "utf8")
          );
          const endpoint = JSON.parse(await fs.readFile(pointer.endpointFile, "utf8"));
          // Never forward credentials to a URL supplied by the browser or a non-loopback host.
          if (
            endpoint.host !== "127.0.0.1" ||
            !Number.isInteger(endpoint.port) ||
            endpoint.port < 1 ||
            endpoint.port > 65535 ||
            endpoint.instanceId !== pointer.instanceId ||
            typeof endpoint.controlToken !== "string"
          ) {
            throw new Error("Invalid endpoint");
          }
          const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/status`, {
            headers: { "x-yuvi-control-token": endpoint.controlToken },
            signal: AbortSignal.timeout(3000),
            redirect: "error"
          });
          if (!response.ok) throw new Error("Supervisor unavailable");
          const snapshot = await response.json();
          if (snapshot.instanceId !== pointer.instanceId) throw new Error("Stale endpoint");
          res.end(JSON.stringify(projectDailyServiceStatus(snapshot)));
        } catch {
          res.statusCode = 503;
          res.end('{"error":"Supervisor status unavailable"}');
        }
      });
    }
  };
}
