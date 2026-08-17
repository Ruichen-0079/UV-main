import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ProviderError,
  ProviderErrorCode,
  type ProviderAttempt,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderObservedState
} from "@companion/providers";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { redactValue } from "../services/dashboard.js";
import { requireLocalDashboardAccess } from "./security.js";

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
    if (!requireLocalDashboardAccess(config, request, reply)) {
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

      recordLiveOutputVerification(context, "chat", provider.name, output, startedAt);
      const finalProvider = output.finalProvider ?? provider.name;
      const finalStatus = providerStatusFor(context, "chat", finalProvider, status);

      return reply.send(
        redactValue({
          ok: true,
          provider: finalProvider,
          capability: "chat",
          model: output.model ?? status.model,
          mock: isMockProvider(finalProvider) || Boolean(finalStatus.mock),
          latencyMs: output.latencyMs ?? Math.round(performance.now() - startedAt),
          tokenUsage: output.tokenUsage,
          verificationMode: "live" as const,
          ...verificationStatusFields(finalStatus)
        })
      );
    } catch (error) {
      recordLiveFailureVerification(context, "chat", provider.name, error, startedAt);
      const currentStatus = providerStatusFor(
        context,
        "chat",
        provider.name,
        context.providers.getStatus().providers.chat
      );
      return reply.status(502).send(
        redactValue({
          ok: false,
          provider: provider.name,
          capability: "chat",
          model: currentStatus.model ?? status.model,
          mock: Boolean(currentStatus.mock),
          latencyMs: Math.round(performance.now() - startedAt),
          error: safeProviderError(error),
          errorCode: providerErrorCode(error),
          verificationMode: "live" as const,
          ...verificationStatusFields(currentStatus)
        })
      );
    }
  });

  app.post("/providers/verify/reasoning", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) {
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

      recordLiveOutputVerification(context, "reasoning", provider.name, output, startedAt);
      const finalProvider = output.finalProvider ?? provider.name;
      const finalStatus = providerStatusFor(context, "reasoning", finalProvider, status);

      return reply.send(
        redactValue({
          ok: true,
          provider: finalProvider,
          capability: "reasoning",
          model: output.model ?? status.model,
          mock: isMockProvider(finalProvider) || Boolean(finalStatus.mock),
          latencyMs: output.latencyMs ?? Math.round(performance.now() - startedAt),
          tokenUsage: output.tokenUsage,
          verificationMode: "live" as const,
          ...verificationStatusFields(finalStatus)
        })
      );
    } catch (error) {
      recordLiveFailureVerification(context, "reasoning", provider.name, error, startedAt);
      const currentStatus = providerStatusFor(
        context,
        "reasoning",
        provider.name,
        context.providers.getStatus().providers.reasoning
      );
      return reply.status(502).send(
        redactValue({
          ok: false,
          provider: provider.name,
          capability: "reasoning",
          model: currentStatus.model ?? status.model,
          mock: Boolean(currentStatus.mock),
          latencyMs: Math.round(performance.now() - startedAt),
          error: safeProviderError(error),
          errorCode: providerErrorCode(error),
          verificationMode: "live" as const,
          ...verificationStatusFields(currentStatus)
        })
      );
    }
  });

  app.post("/providers/verify/embedding", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) {
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
      const observationState: Exclude<ProviderObservedState, "unknown"> = dimensionMismatch
        ? "degraded"
        : "available";
      const observationError = dimensionMismatch
        ? `Provider returned ${actualDimensions} dimensions while YUVI expected ${expectedDimensions}.`
        : undefined;
      const observedProvider = recordEmbeddingVerification(
        context,
        observationState,
        observationError,
        dimensionMismatch ? ProviderErrorCode.MalformedResponse : undefined,
        startedAt
      );
      const finalStatus = providerStatusFor(
        context,
        "embedding",
        observedProvider ?? provider.name,
        status
      );
      return reply.send(
        redactValue({
          ok: !dimensionMismatch,
          provider: observedProvider ?? provider.name,
          capability: "embedding",
          model: provider.model ?? finalStatus.model ?? status.model,
          expectedDimensions,
          actualDimensions,
          dimensions: actualDimensions,
          mock: isMockProvider(observedProvider ?? provider.name) || Boolean(finalStatus.mock),
          semanticEmbedding: finalStatus.semanticEmbedding ?? Boolean(status.semanticEmbedding),
          latencyMs: Math.round(performance.now() - startedAt),
          ...(dimensionMismatch
            ? {
                error: `Provider returned ${actualDimensions} dimensions while YUVI expected ${expectedDimensions}. Check EMBEDDING_DIMENSIONS and model/provider compatibility.`
              }
            : {}),
          verificationMode: "live" as const,
          ...verificationStatusFields(finalStatus)
        })
      );
    } catch (error) {
      recordLiveFailureVerification(context, "embedding", provider.name, error, startedAt);
      const currentStatus = providerStatusFor(
        context,
        "embedding",
        provider.name,
        context.providers.getStatus().providers.embedding
      );
      return reply.send(
        redactValue({
          ok: false,
          provider: provider.name,
          capability: "embedding",
          model: currentStatus.model ?? status.model,
          expectedDimensions,
          actualDimensions: null,
          dimensions: currentStatus.dimensions ?? status.dimensions,
          mock: Boolean(currentStatus.mock),
          semanticEmbedding: Boolean(currentStatus.semanticEmbedding),
          latencyMs: Math.round(performance.now() - startedAt),
          error: safeProviderError(error),
          errorCode: providerErrorCode(error),
          verificationMode: "live" as const,
          ...verificationStatusFields(currentStatus)
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
    if (!requireLocalDashboardAccess(config, request, reply)) {
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
        verificationMode: "config_only" as const,
        routes,
        attemptedProviders: routes.map((route) => ({
          provider: route.provider,
          model: route.model,
          status: route.readiness === "ready" ? "success" : "unavailable",
          configured: route.configured,
          enabled: route.enabled,
          priority: route.priority,
          errorCode: route.readiness === "ready" ? undefined : "PROVIDER_UNAVAILABLE"
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
  if (!requireLocalDashboardAccess(config, request, reply)) {
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
      verificationMode: "config_only" as const,
      ...verificationStatusFields(status),
      message:
        capability === "stt"
          ? "STT verification is config-only in v1; upload audio to /v1/audio/transcriptions to test runtime transcription."
          : capability === "vision"
            ? "Vision verification is config-only in v1; use /v1/vision/analyze with an explicit image to test runtime analysis."
            : "TTS verification is config-only in v1; use /v1/tts with explicit text to test runtime synthesis."
    })
  );
}

type ProviderMetadataLike = {
  attemptedProviders?: ProviderAttempt[] | undefined;
  finalProvider?: string | undefined;
  latencyMs?: number | undefined;
};

function recordLiveOutputVerification(
  context: AppContext,
  capability: ProviderCapability,
  fallbackProvider: string,
  output: ProviderMetadataLike,
  startedAt: number
): void {
  const verifiedAt = new Date().toISOString();
  const attempts = output.attemptedProviders?.length
    ? output.attemptedProviders
    : [
        {
          provider: output.finalProvider ?? fallbackProvider,
          status: "success" as const,
          latencyMs: output.latencyMs ?? Math.round(performance.now() - startedAt)
        }
      ];

  for (const attempt of attempts) {
    const observed = observedStateForAttempt(attempt);
    if (observed === "unknown") {
      continue;
    }
    context.providers.recordLiveVerification({
      capability,
      provider: attempt.provider,
      observed,
      verifiedAt,
      ...(attempt.latencyMs !== undefined ? { latencyMs: attempt.latencyMs } : {}),
      ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
      ...(attempt.error ? { error: attempt.error } : {})
    });
  }
}

function recordLiveFailureVerification(
  context: AppContext,
  capability: ProviderCapability,
  fallbackProvider: string,
  error: unknown,
  startedAt: number
): void {
  const verifiedAt = new Date().toISOString();
  const attempts = attemptedProvidersFrom(error);
  if (attempts.length > 0) {
    for (const attempt of attempts) {
      const observed = observedStateForAttempt(attempt);
      if (observed === "unknown") {
        continue;
      }
      context.providers.recordLiveVerification({
        capability,
        provider: attempt.provider,
        observed,
        verifiedAt,
        ...(attempt.latencyMs !== undefined ? { latencyMs: attempt.latencyMs } : {}),
        ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
        ...(attempt.error ? { error: attempt.error } : {})
      });
    }
    return;
  }

  context.providers.recordLiveVerification({
    capability,
    provider: fallbackProvider,
    observed: observedStateForError(error),
    verifiedAt,
    latencyMs: Math.round(performance.now() - startedAt),
    errorCode: providerErrorCode(error) ?? ProviderErrorCode.ProviderUnavailable,
    error: safeProviderError(error)
  });
}

function recordEmbeddingVerification(
  context: AppContext,
  observed: Exclude<ProviderObservedState, "unknown">,
  error: string | undefined,
  errorCode: string | undefined,
  startedAt: number
): string | undefined {
  const status = context.providers.getStatus().routes?.embedding ?? [];
  const readyRoutes = status.filter((route) => route.readiness === "ready");

  // EmbeddingProvider returns a bare vector, so its fallback wrapper cannot
  // report finalProvider/attemptedProviders. Only record success when the
  // configured route makes attribution unambiguous.
  if (readyRoutes.length !== 1) {
    return undefined;
  }

  const provider = readyRoutes[0]?.provider;
  if (!provider) {
    return undefined;
  }

  context.providers.recordLiveVerification({
    capability: "embedding",
    provider,
    observed,
    verifiedAt: new Date().toISOString(),
    latencyMs: Math.round(performance.now() - startedAt),
    ...(errorCode ? { errorCode } : {}),
    ...(error ? { error } : {})
  });
  return provider;
}

function providerStatusFor(
  context: AppContext,
  capability: ProviderCapability,
  provider: string,
  fallback: ProviderHealth
): ProviderHealth {
  const status = context.providers.getStatus();
  const route = status.routes?.[capability]?.find((candidate) => candidate.provider === provider);
  return (
    route ??
    (status.providers[capability].provider === provider ? status.providers[capability] : fallback)
  );
}

function verificationStatusFields(status: ProviderHealth): {
  readiness?: ProviderHealth["readiness"];
  observed?: ProviderHealth["observed"];
  lastVerifiedAt?: string;
  lastErrorCode?: string;
  lastError?: string;
} {
  return {
    readiness: status.readiness,
    observed: status.observed,
    ...(status.lastVerifiedAt ? { lastVerifiedAt: status.lastVerifiedAt } : {}),
    ...(status.lastErrorCode ? { lastErrorCode: status.lastErrorCode } : {}),
    ...(status.lastError ? { lastError: status.lastError } : {})
  };
}

function attemptedProvidersFrom(error: unknown): ProviderAttempt[] {
  if (error instanceof ProviderError && error.attemptedProviders) {
    return error.attemptedProviders;
  }
  const attempts = (error as { attemptedProviders?: unknown } | null)?.attemptedProviders;
  return Array.isArray(attempts) ? (attempts as ProviderAttempt[]) : [];
}

function observedStateForAttempt(
  attempt: ProviderAttempt
): Exclude<ProviderObservedState, "unknown"> | "unknown" {
  if (attempt.status === "success") {
    return "available";
  }
  if (attempt.status === "unavailable") {
    return "unavailable";
  }
  if (
    attempt.errorCode === ProviderErrorCode.NetworkError ||
    attempt.errorCode === ProviderErrorCode.Timeout ||
    attempt.errorCode === ProviderErrorCode.ProviderUnavailable
  ) {
    return "unavailable";
  }
  if (attempt.status === "failed") {
    return "degraded";
  }
  return "unknown";
}

function observedStateForError(error: unknown): Exclude<ProviderObservedState, "unknown"> {
  const code = providerErrorCode(error);
  return code === ProviderErrorCode.NetworkError ||
    code === ProviderErrorCode.Timeout ||
    code === ProviderErrorCode.ProviderUnavailable
    ? "unavailable"
    : "degraded";
}

function providerErrorCode(error: unknown): string | undefined {
  if (error instanceof ProviderError) {
    return error.code;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function isMockProvider(provider: string): boolean {
  return provider === "mock" || provider.startsWith("mock-");
}

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Provider verification failed.";
  return message
    .replace(/:\s*(?:\{|\[)[\s\S]*$/, "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(api[-_]?key|authorization|token|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 300);
}
