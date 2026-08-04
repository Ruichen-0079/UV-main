/**
 * Packaged Runtime entry. Loads the server after applying env files from
 * YUVI_RUNTIME_DATA_DIR / YUVI_RUNTIME_ENV_DIR (never install-dir writes).
 */
import { loadServerConfig } from "../apps/server/src/config.ts";
import {
  applyRuntimeEnv,
  getLegacyServerLocalEnvWarning,
  readRuntimeEnvFiles
} from "../apps/server/src/env.ts";
import { buildServer } from "../apps/server/src/server.ts";

async function main(): Promise<void> {
  const runtimeEnvFiles = await readRuntimeEnvFiles();
  applyRuntimeEnv(runtimeEnvFiles.env);
  console.info("[env] runtimeEnvDir:", runtimeEnvFiles.runtimeEnvDir);
  console.info("[env] .env exists:", runtimeEnvFiles.base.exists);
  console.info("[env] .env.local exists:", runtimeEnvFiles.local.exists);
  console.info("[env] DEEPSEEK_API_KEY configured:", Boolean(process.env["DEEPSEEK_API_KEY"]));
  console.info("[env] DEEPSEEK_CHAT_MODEL:", process.env["DEEPSEEK_CHAT_MODEL"] ?? "");
  console.info("[env] MEMORY_REPOSITORY:", process.env["MEMORY_REPOSITORY"] ?? "in-memory");
  console.info("[env] DATABASE_URL configured:", Boolean(process.env["DATABASE_URL"]));
  console.info("[env] YUVI_PACKAGED:", process.env["YUVI_PACKAGED"] ?? "");

  if (process.env["YUVI_PACKAGED"] !== "1" && process.env["YUVI_PACKAGED"] !== "true") {
    const legacyWarning = await getLegacyServerLocalEnvWarning();
    if (legacyWarning) {
      console.warn("[env]", legacyWarning);
    }
  }

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
}

main().catch((error) => {
  console.error(
    "[runtime.fatal]",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
