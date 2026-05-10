import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export async function registerHealthRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
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
      server: { status: "healthy" },
      database,
      providers: {
        chat,
        optional: {
          tts,
          stt,
          vision,
          embedding
        }
      }
    };
  });
}
