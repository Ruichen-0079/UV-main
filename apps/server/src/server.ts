import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { ServerConfig } from "./config.js";
import { createAppContext } from "./context.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerMessageRoutes } from "./routes/message.js";
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

  const context = createAppContext(app.log);

  await registerHealthRoutes(app, context);
  await registerMessageRoutes(app, context);
  await registerMemoryRoutes(app, context);
  await registerWebSocketRoutes(app, context);

  return app;
}
