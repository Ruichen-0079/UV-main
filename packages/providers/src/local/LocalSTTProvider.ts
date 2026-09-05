import { randomUUID } from "node:crypto";
import type { ProviderCallOptions, ProviderHealth } from "../types/common.js";
import { ProviderError, ProviderErrorCode } from "../types/errors.js";
import { createTransportAbort } from "../transport-abort.js";
import type {
  STTInput,
  STTOutput,
  STTSegment,
  STTProvider,
  VoiceActivityInput,
  VoiceActivityOutput
} from "../types/stt.js";

export type LocalSTTProviderOptions = {
  baseUrl: string;
  model: string;
  timeoutMs?: number | undefined;
};

/** HTTP adapter for an external local CPU STT sidecar. It owns no process. */
export class LocalSTTProvider implements STTProvider {
  readonly name = "local";

  constructor(private readonly options: LocalSTTProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = performance.now();
    const transport = createTransportAbort({ timeoutMs: this.options.timeoutMs ?? 4_000 });
    try {
      const response = await fetch(`${trimSlash(this.options.baseUrl)}/health`, {
        signal: transport.signal
      });
      if (!response.ok) throw new Error(`local STT health returned ${response.status}`);
      return {
        provider: this.name,
        name: this.name,
        capability: "stt",
        status: "healthy",
        configured: true,
        available: true,
        mock: false,
        baseUrl: this.options.baseUrl,
        model: this.options.model,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        message: "Local CPU STT sidecar is ready."
      };
    } catch (error) {
      return {
        provider: this.name,
        name: this.name,
        capability: "stt",
        status: "unavailable",
        configured: true,
        available: false,
        mock: false,
        baseUrl: this.options.baseUrl,
        model: this.options.model,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : "Local STT health check failed."
      };
    } finally {
      transport.cleanup();
    }
  }

  async transcribeAudio(input: STTInput, options?: ProviderCallOptions): Promise<STTOutput> {
    const transport = createTransportAbort({
      signal: options?.signal,
      timeoutMs: this.options.timeoutMs ?? 120_000
    });
    try {
      const audioBase64 = resolveAudioBase64(input);
      const response = await fetch(`${trimSlash(this.options.baseUrl)}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioBase64,
          mimeType: input.mimeType ?? "audio/wav",
          language: input.language,
          identify: Boolean(input.metadata?.["identify"]),
          diarize: Boolean(input.metadata?.["diarize"])
        }),
        signal: transport.signal
      });
      if (!response.ok) {
        throw new ProviderError({
          provider: this.name,
          capability: "stt",
          code: ProviderErrorCode.NetworkError,
          message: `Local STT transcription failed with HTTP ${response.status}.`,
          retryable: response.status >= 500
        });
      }
      const body = (await response.json()) as {
        text?: string;
        language?: string;
        latencyMs?: number;
        /**
         * Acoustic template match evidence from the optional identify flag.
         * Deliberately not surfaced: template matches are not person identity,
         * and voice-evidence-to-person resolution belongs to a later atom.
         */
        identity?: { identity?: string; speakerId?: string | null };
        /** Sidecar diarization spans: time + cluster label, no per-span transcript. */
        segments?: Array<{ startMs?: number; endMs?: number; speaker?: string }> | null;
      };
      return {
        observationId: randomUUID(),
        text: body.text ?? "",
        language: body.language ?? input.language,
        latencyMs: body.latencyMs,
        model: this.options.model,
        finalProvider: this.name,
        ...(body.segments?.length ? { segments: normalizeDiarization(body.segments) } : {}),
        // Provenance and diagnostics only; acoustic speaker evidence travels in
        // typed STTSegment fields, never in this metadata bag.
        providerMetadata: {
          device: "cpu"
        }
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        provider: this.name,
        capability: "stt",
        code: ProviderErrorCode.NetworkError,
        message: "Local STT transcription request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }

  async detectVoiceActivity(
    input: VoiceActivityInput,
    options?: ProviderCallOptions
  ): Promise<VoiceActivityOutput> {
    const transport = createTransportAbort({
      signal: options?.signal ?? input.signal,
      timeoutMs: this.options.timeoutMs ?? 8_000
    });
    try {
      const response = await fetch(`${trimSlash(this.options.baseUrl)}/vad`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          captureEpoch: input.captureEpoch,
          pcmBase64: input.pcmBase64,
          sampleRate: input.sampleRate ?? 16_000
        }),
        signal: transport.signal
      });
      if (response.status === 503) {
        throw new ProviderError({
          provider: this.name,
          capability: "stt",
          code: ProviderErrorCode.ProviderUnavailable,
          message: "Local STT sidecar has no Silero VAD model.",
          retryable: false
        });
      }
      if (!response.ok) {
        throw new ProviderError({
          provider: this.name,
          capability: "stt",
          code: ProviderErrorCode.NetworkError,
          message: `Local STT VAD failed with HTTP ${response.status}.`,
          retryable: response.status >= 500
        });
      }
      const body = (await response.json()) as { active?: boolean; captureEpoch?: string };
      if (typeof body.active !== "boolean") {
        throw new ProviderError({
          provider: this.name,
          capability: "stt",
          code: ProviderErrorCode.MalformedResponse,
          message: "Local STT VAD response did not include an active boolean.",
          retryable: false
        });
      }
      return {
        active: body.active,
        captureEpoch: body.captureEpoch ?? input.captureEpoch
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({
        provider: this.name,
        capability: "stt",
        code: ProviderErrorCode.NetworkError,
        message: "Local STT VAD request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }
}

/**
 * Normalizes sidecar diarization spans into provider-neutral typed segments.
 * The sidecar cluster label is preserved verbatim as a capture-local
 * `speakerClusterId`; it is never mapped onto a person or voice profile.
 */
function normalizeDiarization(
  segments: Array<{ startMs?: number; endMs?: number; speaker?: string }>
): STTSegment[] {
  return segments.map((segment) => ({
    segmentId: randomUUID(),
    startMs: segment.startMs,
    endMs: segment.endMs,
    ...(segment.speaker !== undefined ? { speakerClusterId: segment.speaker } : {})
  }));
}

function resolveAudioBase64(input: STTInput): string {
  if (input.audioBase64?.trim()) return input.audioBase64.trim();
  const bytes = input.audio ?? input.audioBuffer;
  if (bytes && bytes.byteLength > 0) return Buffer.from(bytes).toString("base64");
  throw new ProviderError({
    provider: "local",
    capability: "stt",
    code: ProviderErrorCode.UnsupportedInput,
    message: "Local STT requires audio bytes or audioBase64.",
    retryable: false
  });
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
