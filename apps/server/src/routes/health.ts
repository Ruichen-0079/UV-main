import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";

const startedAt = Date.now();

export async function registerHealthRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  app.get("/health", async () => {
    const [database, chat, tts, stt, vision, embedding] = await Promise.all([
      context.memoryRepository.healthCheck(),
      context.providers.getChatProvider().healthCheck(),
      context.providers.getTTSProvider().healthCheck(),
      context.providers.getSTTProvider().healthCheck(),
      context.providers.getVisionProvider().healthCheck(),
      context.providers.getEmbeddingProvider().healthCheck()
    ]);

    const ok = database.status === "healthy" && chat.status === "healthy";

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
      providers: {
        chat,
        optional: {
          reasoning: await context.providers.getReasoningProvider().healthCheck(),
          tts,
          stt,
          vision,
          embedding
        }
      }
    };
  });
}
