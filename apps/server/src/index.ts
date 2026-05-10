import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadServerConfig();
const app = await buildServer(config);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down server");
  await app.close();
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await app.listen({ host: config.host, port: config.port });
