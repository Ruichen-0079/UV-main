import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { getRuntimeEnvDir } from "../env.js";
import {
  isLocalAddress,
  requireDashboardDevToken,
  requireLocalDashboardAccess
} from "./security.js";
import { desktopCorsHeaders } from "../cors.js";
import { restartDailyUseServices } from "../services/daily-use.js";

export async function registerSystemRoutes(
  app: FastifyInstance,
  config: ServerConfig
): Promise<void> {
  app.post("/system/local-services/restart", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return;
    // A bodyless POST can otherwise be sent by an unrelated website without
    // a CORS preflight when a local development token is not configured.
    if (
      request.headers.origin &&
      !desktopCorsHeaders(request.headers.origin)["Access-Control-Allow-Origin"]
    ) {
      return reply.code(403).send({ error: "forbidden_origin" });
    }
    if (process.platform !== "linux" || process.env["YUVI_DAILY_USE_SYSTEMD"] !== "1") {
      return reply.code(409).send({ error: "daily_launcher_unavailable" });
    }
    setTimeout(restartDailyUseServices, 300).unref();
    return { ok: true, restartRequested: true };
  });
  app.post("/system/restart/deep", async (request, reply) => {
    if (!requireDashboardDevToken(config, request, reply)) return;
    if (config.runtimeMode === "production") {
      return reply.status(404).send({
        error: "not_found",
        message: "Deep restart is unavailable in production mode."
      });
    }
    if (!isLocalAddress(request.ip)) {
      return reply.status(403).send({
        error: "forbidden",
        message: "Deep restart can only be requested from localhost."
      });
    }
    if (!config.devSupervisor.active || !config.devSupervisor.restartMarkerPath) {
      return reply.status(409).send({
        error: "unsupported",
        message:
          "Deep restart requires scripts/dev.sh supervisor mode. Start with YUVI_DEV_SUPERVISOR=1.",
        supervisorActive: config.devSupervisor.active,
        autoMigrate: config.devSupervisor.autoMigrate,
        runtimeEnvDir: getRuntimeEnvDir()
      });
    }

    const markerPath = resolve(config.devSupervisor.restartMarkerPath);
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(
      markerPath,
      JSON.stringify(
        {
          requestedAt: new Date().toISOString(),
          reason: "dashboard-deep-restart"
        },
        null,
        2
      )
    );

    setTimeout(() => {
      void app.close().finally(() => {
        process.exitCode = 42;
        if (process.env["NODE_ENV"] !== "test") {
          process.exit(42);
        }
      });
    }, 100).unref();

    return reply.send({
      ok: true,
      restartRequested: true,
      message: "Deep restart requested. The dev supervisor will reload env and restart runtime.",
      supervisorActive: true,
      autoMigrate: config.devSupervisor.autoMigrate,
      runtimeEnvDir: getRuntimeEnvDir()
    });
  });
}
