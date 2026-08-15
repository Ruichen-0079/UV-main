import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import {
  readMemoryIngestionDiagnostics,
  toMemoryIngestionHealthSnapshot
} from "../memory-ingestion-diagnostics.js";

const startedAt = Date.now();

export async function registerHealthRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  app.get("/health", async () => {
    const database = await context.memoryRepository.healthCheck();
    const providerStatus = context.providers.getStatus();
    const chat = providerStatus.providers.chat;

    const ok = database.status === "healthy" && chat.available === true;
    const memoryIngestion = toMemoryIngestionHealthSnapshot(
      await readMemoryIngestionDiagnostics(context.memoryIngestionCoordinator)
    );

    return {
      ok,
      service: "ai-companion-runtime",
      runtimeMode: config.runtimeMode,
      uptime: {
        seconds: Math.floor((Date.now() - startedAt) / 1000),
        startedAt: new Date(startedAt).toISOString()
      },
      server: { status: "healthy" },
      database,
      memoryIngestion,
      providers: {
        chat,
        optional: {
          reasoning: providerStatus.providers.reasoning,
          tts: providerStatus.providers.tts,
          stt: providerStatus.providers.stt,
          vision: providerStatus.providers.vision,
          embedding: providerStatus.providers.embedding
        }
      }
    };
  });
}
