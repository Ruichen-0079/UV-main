import { ProviderError, type ProviderAttempt, type ProviderCapability } from "@companion/providers";
import type { ProviderMetadata } from "@companion/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

const IdentitySchema = {
  sessionId: z.string().min(1).default("default"),
  personaId: z.string().min(1).nullable().optional(),
  subjectUserId: z.string().min(1).nullable().optional(),
  createdByUserId: z.string().min(1).nullable().optional(),
  speakerId: z.string().min(1).nullable().optional(),
  voiceProfileId: z.string().min(1).nullable().optional()
} as const;

const TranscriptionRequestSchema = z.object({
  ...IdentitySchema,
  audioBase64: z.string().optional(),
  mimeType: z.string().optional(),
  language: z.string().optional(),
  mockText: z.string().optional()
});

const VoiceMessageRequestSchema = z.object({
  ...IdentitySchema,
  audioBase64: z.string().optional(),
  mimeType: z.string().optional(),
  language: z.string().optional(),
  mockText: z.string().optional(),
  options: z
    .object({
      readMemory: z.boolean().optional(),
      writeMemory: z.boolean().optional(),
      promptPreview: z.boolean().optional(),
      voiceOutput: z.boolean().optional()
    })
    .optional()
});

const TTSRequestSchema = z.object({
  sessionId: z.string().min(1).default("default"),
  text: z.string().min(1),
  voice: z.string().min(1).optional(),
  format: z.enum(["mp3", "wav", "opus", "pcm", "mulaw", "alaw"]).optional(),
  language: z.string().min(1).optional()
});

const VisionRequestSchema = z.object({
  ...IdentitySchema,
  imageBase64: z.string().optional(),
  imageUrl: z.string().url().optional(),
  mimeType: z.string().optional(),
  prompt: z.string().optional()
});

export async function registerMediaRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.post("/v1/audio/transcriptions", async (request, reply) => {
    const parsed = TranscriptionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const provider = context.providers.getSTTProvider();
    try {
      const output = await provider.transcribeAudio({
        audioBase64: parsed.data.audioBase64,
        mimeType: parsed.data.mimeType,
        language: parsed.data.language,
        metadata: {
          ...identityMetadata(parsed.data),
          ...(parsed.data.mockText ? { mockTranscription: parsed.data.mockText } : {})
        }
      });
      return reply.send({
        text: output.text,
        language: output.language,
        confidence: output.confidence,
        speakerId: parsed.data.speakerId,
        voiceProfileId: parsed.data.voiceProfileId,
        ...standardProviderMetadata("stt", output)
      });
    } catch (error) {
      return sendProviderFailure(reply, "stt", error);
    }
  });

  app.post("/v1/voice/message", async (request, reply) => {
    const parsed = VoiceMessageRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const sttProvider = context.providers.getSTTProvider();
    try {
      const transcription = await sttProvider.transcribeAudio({
        audioBase64: parsed.data.audioBase64,
        mimeType: parsed.data.mimeType,
        language: parsed.data.language,
        metadata: {
          ...identityMetadata(parsed.data),
          ...(parsed.data.mockText ? { mockTranscription: parsed.data.mockText } : {})
        }
      });
      const response = await context.runtime.handleUserMessage(
        {
          sessionId: parsed.data.sessionId,
          content: transcription.text,
          ...identityMetadata(parsed.data)
        },
        {
          readMemory: parsed.data.options?.readMemory,
          writeMemory: parsed.data.options?.writeMemory,
          voiceOutput: parsed.data.options?.voiceOutput
        }
      );

      const sttMetadata = standardProviderMetadata("stt", transcription);
      return reply.send({
        transcription: {
          text: transcription.text,
          language: transcription.language,
          confidence: transcription.confidence,
          speakerId: parsed.data.speakerId,
          voiceProfileId: parsed.data.voiceProfileId,
          ...sttMetadata
        },
        reply: response.payload.content,
        traceId: response.traceId,
        provider: response.payload.provider,
        stt: sttMetadata,
        chat: response.payload.provider,
        promptPreview: parsed.data.options?.promptPreview
          ? context.runtime.getLatestPromptPreview()
          : undefined
      });
    } catch (error) {
      return sendProviderFailure(reply, "stt", error);
    }
  });

  app.post("/v1/tts", async (request, reply) => {
    const parsed = TTSRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const provider = context.providers.getTTSProvider();
    const abortController = new AbortController();
    const abortOnDisconnect = () => abortController.abort();
    // IncomingMessage#close can fire when the request body has been fully
    // consumed, which is a normal POST lifecycle rather than a client
    // disconnect. Only abort on an explicitly aborted request or a socket
    // that actually closes before the response is sent.
    request.raw.once("aborted", abortOnDisconnect);
    request.raw.socket?.once("close", abortOnDisconnect);
    try {
      const output = await provider.synthesizeSpeech({
        text: parsed.data.text,
        voice: parsed.data.voice,
        format: parsed.data.format,
        signal: abortController.signal,
        metadata: {
          sessionId: parsed.data.sessionId,
          ...(parsed.data.language ? { language: parsed.data.language } : {})
        }
      });
      return reply.send({
        audioBase64: output.audioBase64 ?? Buffer.from(output.audio).toString("base64"),
        mimeType: output.mimeType,
        durationMs: output.durationMs,
        ...standardProviderMetadata("tts", output)
      });
    } catch (error) {
      return sendProviderFailure(reply, "tts", error);
    } finally {
      request.raw.removeListener("aborted", abortOnDisconnect);
      request.raw.socket?.removeListener("close", abortOnDisconnect);
    }
  });

  app.post("/v1/vision/analyze", async (request, reply) => {
    const parsed = VisionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const provider = context.providers.getVisionProvider();
    try {
      const output = await provider.analyzeImage({
        imageBase64: parsed.data.imageBase64,
        imageUrl: parsed.data.imageUrl,
        mimeType: parsed.data.mimeType,
        prompt: parsed.data.prompt,
        metadata: identityMetadata(parsed.data)
      });
      return reply.send({
        analysis: output.text,
        labels: output.labels,
        objects: output.objects,
        sceneSummary: output.sceneSummary,
        confidence: output.confidence,
        ...standardProviderMetadata("vision", output)
      });
    } catch (error) {
      return sendProviderFailure(reply, "vision", error);
    }
  });
}

function identityMetadata(input: {
  sessionId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  createdByUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  voiceProfileId?: string | null | undefined;
}): Record<string, string | null> {
  return {
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.personaId !== undefined ? { personaId: input.personaId } : {}),
    ...(input.subjectUserId !== undefined ? { subjectUserId: input.subjectUserId } : {}),
    ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
    ...(input.speakerId !== undefined ? { speakerId: input.speakerId } : {}),
    ...(input.voiceProfileId !== undefined ? { voiceProfileId: input.voiceProfileId } : {})
  };
}

function standardProviderMetadata(capability: ProviderCapability, output: ProviderMetadata) {
  const attemptedProviders = sanitizeAttempts(output.attemptedProviders);
  const success = attemptedProviders.find((attempt) => attempt.status === "success");
  const finalProvider = output.finalProvider ?? success?.provider ?? "unknown";
  return {
    capability,
    fallbackUsed: Boolean(output.fallbackUsed),
    attemptedProviders,
    finalProvider,
    provider: finalProvider,
    model: output.model ?? success?.model,
    mock: output.model === "mock" || finalProvider === "mock",
    latencyMs: output.latencyMs ?? success?.latencyMs
  };
}

function sendProviderFailure(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  capability: ProviderCapability,
  error: unknown
): unknown {
  const providerError = error instanceof ProviderError ? error : null;
  return reply.status(providerError?.statusCode ?? 503).send({
    error: "provider_unavailable",
    capability,
    provider: providerError?.provider,
    code: providerError?.code ?? "PROVIDER_UNAVAILABLE",
    message: safeProviderError(error),
    fallbackUsed: true,
    attemptedProviders: sanitizeAttempts(extractAttempts(error)),
    setup:
      "Configure a real provider for this capability, or set PROVIDER_ALLOW_MOCKS=true for explicit offline/mock development."
  });
}

function extractAttempts(error: unknown): ProviderAttempt[] {
  const value = (error as { attemptedProviders?: unknown })?.attemptedProviders;
  return Array.isArray(value) ? (value as ProviderAttempt[]) : [];
}

function sanitizeAttempts(attempts: ProviderAttempt[] | undefined): ProviderAttempt[] {
  return (attempts ?? []).map((attempt) => ({
    provider: attempt.provider,
    ...(attempt.model !== undefined ? { model: attempt.model } : {}),
    status: attempt.status,
    ...(attempt.errorCode !== undefined ? { errorCode: attempt.errorCode } : {}),
    ...(attempt.error !== undefined ? { error: safeProviderError(attempt.error) } : {}),
    ...(attempt.latencyMs !== undefined ? { latencyMs: attempt.latencyMs } : {}),
    ...(attempt.configured !== undefined ? { configured: attempt.configured } : {}),
    ...(attempt.enabled !== undefined ? { enabled: attempt.enabled } : {}),
    ...(attempt.priority !== undefined ? { priority: attempt.priority } : {})
  }));
}

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._~+/=-]+/g, "sk-[REDACTED]")
    .replace(/(api[-_]?key|authorization|token|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .replace(/DATABASE_URL=[^\s]+/gi, "DATABASE_URL=[REDACTED]")
    .slice(0, 300);
}
