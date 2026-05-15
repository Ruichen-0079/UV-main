import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { redactValue } from "../services/dashboard.js";

export async function registerProviderRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.get("/providers/status", async (_request, reply) => {
    try {
      const [chat, reasoning, tts, stt, vision, embedding] = await Promise.all([
        context.providers.getChatProvider().healthCheck(),
        context.providers.getReasoningProvider().healthCheck(),
        context.providers.getTTSProvider().healthCheck(),
        context.providers.getSTTProvider().healthCheck(),
        context.providers.getVisionProvider().healthCheck(),
        context.providers.getEmbeddingProvider().healthCheck()
      ]);

      return reply.send(
        redactValue({
          providers: {
            chat,
            reasoning,
            tts,
            stt,
            vision,
            embedding
          }
        })
      );
    } catch (error) {
      return reply.status(500).send({
        error: "provider_status_failed",
        message: error instanceof Error ? error.message : "Provider status check failed."
      });
    }
  });
}
