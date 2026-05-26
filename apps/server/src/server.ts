import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { ServerConfig } from "./config.js";
import { createAppContext } from "./context.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerHealthRoutes } from "./routes/health.js";
import { memorySearchValidationError, registerMemoryRoutes } from "./routes/memory.js";
import { registerMessageRoutes } from "./routes/message.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerEventRoutes } from "./routes/events.js";
import { MemoryMaintenanceScheduler } from "./services/memoryMaintenanceScheduler.js";
import { registerWebSocketRoutes } from "./routes/websocket.js";

export async function buildServer(config: ServerConfig) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.apiKey",
        "*.authorization",
        "*.Authorization"
      ]
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const normalizedError = normalizeError(error);
    const requestUrl = request.raw.url ?? "";
    if (requestUrl.startsWith("/memory/search") && isMalformedQueryError(normalizedError)) {
      return reply.status(400).send(memorySearchValidationError());
    }

    const statusCode =
      normalizedError.statusCode && normalizedError.statusCode >= 400
        ? normalizedError.statusCode
        : 500;
    if (statusCode >= 500) {
      request.log.error({ err: normalizedError }, "request failed");
    }
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? "internal_server_error" : "bad_request",
      message: normalizedError.message
    });
  });

  await app.register(websocket);

  if (config.runtimeMode === "development" && config.host === "0.0.0.0") {
    app.log.warn(
      "SERVER_HOST=0.0.0.0 exposes the development server on the local network. Use 127.0.0.1 unless you intentionally need LAN access."
    );
  }
  if (config.dashboardDevToken) {
    app.log.info("DASHBOARD_DEV_TOKEN is configured for sensitive development endpoints.");
  }

  const context = createAppContext(app.log, config);
  const maintenanceScheduler = new MemoryMaintenanceScheduler(context, config, app.log);
  context.memoryMaintenanceScheduler = maintenanceScheduler;
  maintenanceScheduler.start();

  app.addHook("onClose", async () => {
    maintenanceScheduler.close();
    await context.memoryRepository.close?.();
  });

  await registerHealthRoutes(app, context, config);
  await registerProviderRoutes(app, context, config);
  await registerSettingsRoutes(app, context, config);
  await registerMessageRoutes(app, context);
  await registerMemoryRoutes(app, context, config);
  await registerEventRoutes(app, context);
  await registerDebugRoutes(app, context, config);
  await registerWebSocketRoutes(app, context);

  return app;
}

function normalizeError(error: unknown): Error & { statusCode?: number } {
  if (error instanceof Error) {
    return error as Error & { statusCode?: number };
  }
  return new Error("Unknown request error.");
}

function isMalformedQueryError(error: Error & { statusCode?: number }): boolean {
  const message = error.message.toLowerCase();
  return (
    error.statusCode === 400 &&
    (message.includes("uri") ||
      message.includes("url") ||
      message.includes("malformed") ||
      message.includes("invalid"))
  );
}
