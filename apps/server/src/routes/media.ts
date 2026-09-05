import {
  ProviderError,
  ProviderErrorCode,
  type ProviderAttempt,
  type ProviderCapability,
  type ProviderMetadata,
  type STTInput,
  type STTOutput,
  type STTProvider
} from "@companion/providers";
import { createEvent } from "@companion/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
  imageUrl: z.string().optional(),
  mimeType: z.string().optional(),
  prompt: z.string().optional()
});

const PUBLIC_VISION_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PUBLIC_VISION_MIME_TYPES = new Map([
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/png", "image/png"]
]);

function validatePublicSTTInput(input: {
  audioBase64?: string | undefined;
  mockText?: string | undefined;
}): string | undefined {
  if (input.audioBase64 !== undefined) {
    if (!isValidPublicBase64Audio(input.audioBase64)) {
      return "audioBase64 must contain valid non-empty base64 audio data.";
    }
    return undefined;
  }

  if (input.mockText?.trim()) {
    return undefined;
  }

  return "Provide valid audioBase64 or non-empty mockText.";
}

function isValidPublicBase64Audio(value: string): boolean {
  const payload = value.startsWith("data:")
    ? (() => {
        const comma = value.indexOf(",");
        return comma >= 0 && /^data:[^,]*;base64$/i.test(value.slice(0, comma))
          ? value.slice(comma + 1)
          : "";
      })()
    : value;

  if (payload.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return false;
  }

  const paddingIndex = payload.indexOf("=");
  if (paddingIndex >= 0 && payload.length % 4 !== 0) {
    return false;
  }

  const decoded = Buffer.from(payload, "base64");
  if (decoded.byteLength === 0) {
    return false;
  }

  const normalizedInput = payload.replace(/=+$/, "");
  const normalizedCanonical = decoded.toString("base64").replace(/=+$/, "");
  return normalizedInput === normalizedCanonical;
}

function validatePublicVisionInput(input: {
  imageBase64?: string | undefined;
  imageUrl?: string | undefined;
  mimeType?: string | undefined;
}): string | undefined {
  if (input.imageUrl) {
    let parsed: URL;
    try {
      parsed = new URL(input.imageUrl);
    } catch {
      return "imageUrl must be a valid HTTP or HTTPS URL.";
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "imageUrl must use the http or https scheme.";
    }
    return undefined;
  }

  if (input.imageBase64) {
    if (/^data:/i.test(input.imageBase64)) {
      return validatePublicVisionDataUrl(input.imageBase64);
    }

    if (!normalizePublicVisionMimeType(input.mimeType)) {
      return "Raw imageBase64 requires image/png or image/jpeg mimeType.";
    }
    return validatePublicVisionBase64(input.imageBase64);
  }

  return "Provide a usable imageUrl or imageBase64 source.";
}

function validatePublicVisionDataUrl(value: string): string | undefined {
  const match = /^data:([^;,\s]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) {
    return "imageBase64 data URLs must use a supported image MIME type and base64 encoding.";
  }

  const rawMimeType = match[1];
  const payload = match[2];
  if (!rawMimeType || !payload || !normalizePublicVisionMimeType(rawMimeType)) {
    return "imageBase64 data URLs must contain a non-empty PNG or JPEG payload.";
  }
  return validatePublicVisionBase64(payload);
}

function validatePublicVisionBase64(value: string): string | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length === 0 || value.length % 4 === 1) {
    return "imageBase64 must contain valid non-empty base64 data.";
  }

  const paddingIndex = value.indexOf("=");
  if (paddingIndex >= 0 && value.length % 4 !== 0) {
    return "imageBase64 has invalid base64 padding.";
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const estimatedBytes = Math.floor((value.length * 3) / 4) - padding;
  if (estimatedBytes > PUBLIC_VISION_MAX_IMAGE_BYTES) {
    return "Inline images must not exceed 20 MiB.";
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0) {
    return "imageBase64 must decode to non-empty image bytes.";
  }
  if (decoded.byteLength > PUBLIC_VISION_MAX_IMAGE_BYTES) {
    return "Inline images must not exceed 20 MiB.";
  }

  const normalizedInput = value.replace(/=+$/, "");
  const normalizedCanonical = decoded.toString("base64").replace(/=+$/, "");
  if (normalizedInput !== normalizedCanonical) {
    return "imageBase64 is not canonically encoded.";
  }
  return undefined;
}

function normalizePublicVisionMimeType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType ? PUBLIC_VISION_MIME_TYPES.get(mediaType) : undefined;
}

type RequestDisconnectBoundary = {
  signal: AbortSignal;
  cleanup(): void;
};

function createRequestDisconnectBoundary(request: FastifyRequest): RequestDisconnectBoundary {
  const controller = new AbortController();
  const socket = request.raw.socket;
  let aborted = false;
  const abortOnDisconnect = () => {
    if (aborted) {
      return;
    }
    aborted = true;
    controller.abort();
  };

  request.raw.once("aborted", abortOnDisconnect);
  socket?.once("close", abortOnDisconnect);

  if (request.raw.aborted || socket?.destroyed) {
    abortOnDisconnect();
  }

  let cleaned = false;
  return {
    signal: controller.signal,
    cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      request.raw.removeListener("aborted", abortOnDisconnect);
      socket?.removeListener("close", abortOnDisconnect);
    }
  };
}

async function transcribeAudioWithDisconnectBoundary(
  request: FastifyRequest,
  provider: STTProvider,
  input: STTInput
): Promise<STTOutput> {
  const boundary = createRequestDisconnectBoundary(request);
  try {
    return await provider.transcribeAudio(input, { signal: boundary.signal });
  } finally {
    boundary.cleanup();
  }
}

export async function registerMediaRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.post("/v1/audio/transcriptions", async (request, reply) => {
    const parsed = TranscriptionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const inputError = validatePublicSTTInput(parsed.data);
    if (inputError) {
      return reply.status(400).send({ error: "invalid_request", message: inputError });
    }

    const provider = context.providers.getSTTProvider();
    try {
      const output = await transcribeAudioWithDisconnectBoundary(request, provider, {
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
        ...(output.observationId === undefined ? {} : { observationId: output.observationId }),
        // Caller-supplied assertions, echoed verbatim; never recognition
        // results. Acoustic speaker evidence only appears in typed segments.
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

    const inputError = validatePublicSTTInput(parsed.data);
    if (inputError) {
      return reply.status(400).send({ error: "invalid_request", message: inputError });
    }

    const sttProvider = context.providers.getSTTProvider();
    try {
      const transcription = await transcribeAudioWithDisconnectBoundary(request, sttProvider, {
        audioBase64: parsed.data.audioBase64,
        mimeType: parsed.data.mimeType,
        language: parsed.data.language,
        metadata: {
          ...identityMetadata(parsed.data),
          ...(parsed.data.mockText ? { mockTranscription: parsed.data.mockText } : {})
        }
      });
      const transcriptEvent = createEvent("user.voice.transcript", {
        sessionId: parsed.data.sessionId,
        content: transcription.text,
        language: transcription.language,
        confidence: transcription.confidence,
        ...identityMetadata(parsed.data)
      });
      const response = await context.runtime.handleUserMessage(transcriptEvent, {
        readMemory: parsed.data.options?.readMemory,
        writeMemory: parsed.data.options?.writeMemory,
        voiceOutput: parsed.data.options?.voiceOutput
      });

      const sttMetadata = standardProviderMetadata("stt", transcription);
      return reply.send({
        transcription: {
          text: transcription.text,
          language: transcription.language,
          confidence: transcription.confidence,
          ...(transcription.observationId === undefined
            ? {}
            : { observationId: transcription.observationId }),
          ...(transcription.segments === undefined ? {} : { segments: transcription.segments }),
          // Caller-supplied assertions, echoed verbatim; never recognition
          // results. Acoustic speaker evidence only appears in typed segments.
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
    const boundary = createRequestDisconnectBoundary(request);
    try {
      if (boundary.signal.aborted) {
        throw createCancelledProviderError(provider.name, "not_started");
      }

      const output = await provider.synthesizeSpeech(
        {
          text: parsed.data.text,
          voice: parsed.data.voice,
          format: parsed.data.format,
          metadata: {
            sessionId: parsed.data.sessionId,
            ...(parsed.data.language ? { language: parsed.data.language } : {})
          }
        },
        { signal: boundary.signal }
      );

      if (boundary.signal.aborted) {
        throw createCancelledProviderError(provider.name, "unknown");
      }
      if (isResponseUnavailable(request, reply)) {
        return;
      }

      return reply.send({
        audioBase64: output.audioBase64 ?? Buffer.from(output.audio).toString("base64"),
        mimeType: output.mimeType,
        durationMs: output.durationMs,
        ...standardProviderMetadata("tts", output)
      });
    } catch (error) {
      if (isResponseUnavailable(request, reply)) {
        return;
      }
      return sendProviderFailure(reply, "tts", error);
    } finally {
      boundary.cleanup();
    }
  });

  app.post("/v1/vision/analyze", async (request, reply) => {
    const parsed = VisionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const inputError = validatePublicVisionInput(parsed.data);
    if (inputError) {
      return reply.status(400).send({ error: "invalid_request", message: inputError });
    }

    const boundary = createRequestDisconnectBoundary(request);
    try {
      const provider = context.providers.getVisionProvider();
      if (boundary.signal.aborted) {
        throw createCancelledVisionProviderError(provider.name, "not_started");
      }

      const output = await provider.analyzeImage(
        {
          imageBase64: parsed.data.imageBase64,
          imageUrl: parsed.data.imageUrl,
          mimeType: normalizePublicVisionMimeType(parsed.data.mimeType) ?? parsed.data.mimeType,
          prompt: parsed.data.prompt,
          metadata: identityMetadata(parsed.data)
        },
        { signal: boundary.signal }
      );

      if (boundary.signal.aborted) {
        throw createCancelledVisionProviderError(provider.name, "unknown");
      }
      if (isResponseUnavailable(request, reply)) {
        return;
      }

      return reply.send({
        analysis: output.text,
        labels: output.labels,
        objects: output.objects,
        sceneSummary: output.sceneSummary,
        confidence: output.confidence,
        ...standardProviderMetadata("vision", output)
      });
    } catch (error) {
      if (isResponseUnavailable(request, reply)) {
        return;
      }
      return sendProviderFailure(reply, "vision", error);
    } finally {
      boundary.cleanup();
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
    fallbackUsed: false,
    attemptedProviders: sanitizeAttempts(extractAttempts(error)),
    setup:
      "Configure a real provider for this capability, or set PROVIDER_ALLOW_MOCKS=true for explicit offline/mock development."
  });
}

function createCancelledProviderError(
  provider: string,
  effectState: "not_started" | "unknown"
): ProviderError {
  return new ProviderError({
    provider,
    capability: "tts",
    code: ProviderErrorCode.Cancelled,
    message: "TTS operation cancelled.",
    retryable: false,
    fallbackEligible: false,
    effectState
  });
}

function createCancelledVisionProviderError(
  provider: string,
  effectState: "not_started" | "unknown"
): ProviderError {
  return new ProviderError({
    provider,
    capability: "vision",
    code: ProviderErrorCode.Cancelled,
    message: "Vision operation cancelled.",
    retryable: false,
    fallbackEligible: false,
    effectState
  });
}

function isResponseUnavailable(
  request: FastifyRequest,
  reply: { raw: { destroyed?: boolean; writableEnded?: boolean } }
): boolean {
  return Boolean(reply.raw.destroyed || reply.raw.writableEnded || request.raw.socket?.destroyed);
}

function extractAttempts(error: unknown): ProviderAttempt[] {
  if (error instanceof ProviderError && error.attemptedProviders) {
    return error.attemptedProviders;
  }
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
