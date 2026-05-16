import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { ServerConfig } from "./config.js";
import { createAppContext } from "./context.js";
import { registerDebugRoutes } from "./routes/debug.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerMessageRoutes } from "./routes/message.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerEventRoutes } from "./routes/events.js";
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

  await app.register(websocket);

  if (config.runtimeMode === "development" && config.host === "0.0.0.0") {
    app.log.warn(
      "SERVER_HOST=0.0.0.0 exposes the development server on the local network. Use 127.0.0.1 unless you intentionally need LAN access."
    );
  }
  if (config.dashboardDevToken) {
    app.log.info("DASHBOARD_DEV_TOKEN is configured; dashboard token enforcement is reserved.");
  }

  const context = createAppContext(app.log, config);

  app.addHook("onClose", async () => {
    await context.memoryRepository.close?.();
  });

  await registerHealthRoutes(app, context, config);
  await registerProviderRoutes(app, context);
  await registerSettingsRoutes(app, context, config);
  await registerMessageRoutes(app, context);
  await registerMemoryRoutes(app, context);
  await registerEventRoutes(app, context);
  await registerDebugRoutes(app, context, config);
  await registerWebSocketRoutes(app, context);

  return app;
}
