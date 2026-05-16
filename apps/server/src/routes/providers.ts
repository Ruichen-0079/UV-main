import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { redactValue } from "../services/dashboard.js";

export async function registerProviderRoutes(
  app: FastifyInstance,
  context: AppContext
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

  app.post("/providers/verify/chat", async (_request, reply) => {
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

  app.post("/providers/verify/reasoning", async (_request, reply) => {
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
}

function safeProviderError(error: unknown): string {
  return error instanceof Error ? error.message : "Provider verification failed.";
}
