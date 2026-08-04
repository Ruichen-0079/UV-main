import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { ServerConfig } from "./config.js";
import { createAppContext } from "./context.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerHealthRoutes } from "./routes/health.js";
import { memorySearchValidationError, registerMemoryRoutes } from "./routes/memory.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerMessageRoutes } from "./routes/message.js";
import { registerMessageStreamRoutes } from "./routes/message-stream.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerEventRoutes } from "./routes/events.js";
import { MemoryMaintenanceScheduler } from "./services/memoryMaintenanceScheduler.js";
import { registerWebSocketRoutes } from "./routes/websocket.js";
import { registerLive2DCoreRoute, registerLive2DRoutes } from "./routes/live2d.js";

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

  // Tauri desktop webview (tauri.localhost) calls Runtime on 127.0.0.1 — needs CORS.
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && isDesktopAllowedOrigin(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Yuvi-Control-Token"
      );
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  if (config.runtimeMode === "development" && config.host === "0.0.0.0") {
    app.log.warn(
      "SERVER_HOST=0.0.0.0 exposes the development server on the local network. Use 127.0.0.1 unless you intentionally need LAN access."
    );
  }
  if (config.dashboardDevToken) {
    app.log.info("DASHBOARD_DEV_TOKEN is configured for sensitive development endpoints.");
  }

  const context = await createAppContext(app.log, config);
  const maintenanceScheduler = new MemoryMaintenanceScheduler(context, config, app.log);
  context.memoryMaintenanceScheduler = maintenanceScheduler;
  maintenanceScheduler.start();

  app.addHook("onClose", async () => {
    maintenanceScheduler.close();
    await context.memoryRepository.close?.();
    await context.conversationRepository.close?.();
  });

  await registerHealthRoutes(app, context, config);
  await registerProviderRoutes(app, context, config);
  await registerSettingsRoutes(app, context, config);
  await registerSystemRoutes(app, config);
  await registerMessageRoutes(app, context);
  await registerMessageStreamRoutes(app, context);
  await registerMediaRoutes(app, context);
  await registerMemoryRoutes(app, context, config);
  await registerEventRoutes(app, context);
  await registerDebugRoutes(app, context, config);
  await registerWebSocketRoutes(app, context);
  await registerLive2DRoutes(app, config);
  await registerLive2DCoreRoute(app, config);

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

/** Origins that may call Runtime from the YUVI desktop shell or local tools. */
function isDesktopAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    if (host === "tauri.localhost" || host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return true;
    }
    // asset / custom protocols used by some Tauri versions
    if (url.protocol === "tauri:" || url.protocol === "asset:") {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
