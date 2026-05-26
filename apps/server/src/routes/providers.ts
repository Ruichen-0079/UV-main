import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { redactValue } from "../services/dashboard.js";
import { requireDashboardDevToken } from "./security.js";

const ProviderCapabilitySchema = {
  chat: true,
  reasoning: true,
  embedding: true,
  tts: true,
  stt: true,
  vision: true
} as const;

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

  app.post("/providers/verify/tts", async (request, reply) => {
    return verifyConfigOnlyCapability("tts", request, reply, context, config);
  });

  app.post("/providers/verify/stt", async (request, reply) => {
    return verifyConfigOnlyCapability("stt", request, reply, context, config);
  });

  app.post("/providers/verify/vision", async (request, reply) => {
    return verifyConfigOnlyCapability("vision", request, reply, context, config);
  });

  app.post("/providers/verify-chain/:capability", async (request, reply) => {
    if (!requireDashboardDevToken(config, request, reply)) {
      return reply;
    }
    const capability = (request.params as { capability?: string }).capability;
    if (!capability || !(capability in ProviderCapabilitySchema)) {
      return reply.status(400).send({
        error: "invalid_capability",
        message: "Capability must be one of chat, reasoning, embedding, tts, stt, vision."
      });
    }
    const routes =
      context.providers.getStatus().routes?.[capability as keyof typeof ProviderCapabilitySchema] ??
      [];
    return reply.send(
      redactValue({
        ok: true,
        capability,
        configOnly: true,
        routes,
        attemptedProviders: routes.map((route) => ({
          provider: route.provider,
          model: route.model,
          status: route.available ? "success" : "unavailable",
          configured: route.configured,
          enabled: route.enabled,
          priority: route.priority,
          errorCode: route.available ? undefined : "PROVIDER_UNAVAILABLE"
        })),
        message:
          "Chain verification is explicit. This v1 endpoint returns safe configured route order; use individual Verify buttons for live provider calls."
      })
    );
  });
}

function verifyConfigOnlyCapability(
  capability: "tts" | "stt" | "vision",
  request: FastifyRequest,
  reply: FastifyReply,
  context: AppContext,
  config: ServerConfig
): unknown {
  if (!requireDashboardDevToken(config, request, reply)) {
    return reply;
  }

  const status = context.providers.getStatus().providers[capability];
  return reply.send(
    redactValue({
      ok: Boolean(status.available),
      provider: status.provider,
      capability,
      model: status.model,
      mock: Boolean(status.mock),
      configured: Boolean(status.configured),
      missingFields: status.missingFields ?? [],
      configOnly: true,
      message:
        capability === "stt"
          ? "STT verification is config-only in v1; upload audio to /v1/audio/transcriptions to test runtime transcription."
          : capability === "vision"
            ? "Vision verification is config-only in v1; use /v1/vision/analyze with an explicit image to test runtime analysis."
            : "TTS verification is config-only in v1; use /v1/tts with explicit text to test runtime synthesis."
    })
  );
}

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Provider verification failed.";
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(api[-_]?key|authorization|token|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 300);
}
