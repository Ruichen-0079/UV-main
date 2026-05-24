import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { redactValue } from "../services/dashboard.js";
import { requireDashboardDevToken } from "./security.js";

export async function registerProviderRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  app.get("/providers/status", async (_request, reply) => {
    try {
      return reply.send(redactValue(context.providers.getStatus()));
    } catch (error) {
      return reply.status(500).send({
        error: "provider_status_failed",
        message: error instanceof Error ? error.message : "Provider status check failed."
      });
    }
  });

  app.post("/providers/verify/chat", async (request, reply) => {
    if (!requireDashboardDevToken(config, request, reply)) {
      return reply;
    }

    const status = context.providers.getStatus().providers.chat;
    const provider = context.providers.getChatProvider();
    const startedAt = performance.now();

    try {
      const output = await provider.generateReply({
        messages: [
          {
            role: "user",
            content: "Reply with OK."
          }
        ],
        maxOutputTokens: 8,
        temperature: 0
      });

      return reply.send(
        redactValue({
          ok: true,
          provider: status.mock ? "mock" : provider.name,
          capability: "chat",
          model: output.model ?? status.model,
          mock: Boolean(status.mock),
          latencyMs: output.latencyMs ?? Math.round(performance.now() - startedAt),
          tokenUsage: output.tokenUsage
        })
      );
    } catch (error) {
      return reply.status(502).send(
        redactValue({
          ok: false,
          provider: provider.name,
          capability: "chat",
          model: status.model,
          mock: Boolean(status.mock),
          latencyMs: Math.round(performance.now() - startedAt),
          error: safeProviderError(error)
        })
      );
    }
  });

  app.post("/providers/verify/reasoning", async (request, reply) => {
    if (!requireDashboardDevToken(config, request, reply)) {
      return reply;
    }

    const status = context.providers.getStatus().providers.reasoning;
    const provider = context.providers.getReasoningProvider();
    const startedAt = performance.now();

    try {
      const output = await provider.generateReasoning({
        messages: [
          {
            role: "user",
            content: "Think briefly and answer OK."
          }
        ],
        maxOutputTokens: 8,
        effort: "low"
      });

      return reply.send(
        redactValue({
          ok: true,
          provider: status.mock ? "mock" : provider.name,
          capability: "reasoning",
          model: output.model ?? status.model,
          mock: Boolean(status.mock),
          latencyMs: output.latencyMs ?? Math.round(performance.now() - startedAt),
          tokenUsage: output.tokenUsage
        })
      );
    } catch (error) {
      return reply.status(502).send(
        redactValue({
          ok: false,
          provider: provider.name,
          capability: "reasoning",
          model: status.model,
          mock: Boolean(status.mock),
          latencyMs: Math.round(performance.now() - startedAt),
          error: safeProviderError(error)
        })
      );
    }
  });

  app.post("/providers/verify/embedding", async (request, reply) => {
    if (!requireDashboardDevToken(config, request, reply)) {
      return reply;
    }

    const status = context.providers.getStatus().providers.embedding;
    const provider = context.providers.getEmbeddingProvider();
    const startedAt = performance.now();
    const expectedDimensions = provider.dimensions;

    try {
      const vector = await provider.embedText("YUVI embedding verification");
      const actualDimensions = vector.length;
      const dimensionMismatch = actualDimensions !== expectedDimensions;
      return reply.send(
        redactValue({
          ok: !dimensionMismatch,
          provider: status.mock ? "mock" : provider.name,
          capability: "embedding",
          model: provider.model ?? status.model,
          expectedDimensions,
          actualDimensions,
          dimensions: actualDimensions,
          mock: Boolean(status.mock),
          semanticEmbedding: provider.mock ? false : Boolean(status.semanticEmbedding ?? true),
          latencyMs: Math.round(performance.now() - startedAt),
          ...(dimensionMismatch
            ? {
                error: `Provider returned ${actualDimensions} dimensions while YUVI expected ${expectedDimensions}. Check EMBEDDING_DIMENSIONS and model/provider compatibility.`
              }
            : {})
        })
      );
    } catch (error) {
      return reply.send(
        redactValue({
          ok: false,
          provider: provider.name,
          capability: "embedding",
          model: status.model,
          expectedDimensions,
          actualDimensions: null,
          dimensions: status.dimensions,
          mock: Boolean(status.mock),
          semanticEmbedding: Boolean(status.semanticEmbedding),
          latencyMs: Math.round(performance.now() - startedAt),
          error: safeProviderError(error)
        })
      );
    }
  });
}

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Provider verification failed.";
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(api[-_]?key|authorization|token|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 300);
}
