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
  VoiceActivityOutput,
  VoiceProfileMatch
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
          identify: input.metadata?.["identify"] !== false,
          diarize: input.metadata?.["diarize"] !== false
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
      const body = (await response.json()) as SidecarTranscribeBody;
      const acoustic = normalizeAcousticEvidence(body);
      return {
        observationId: randomUUID(),
        text: body.text ?? "",
        language: body.language ?? input.language,
        latencyMs: body.latencyMs,
        model: this.options.model,
        finalProvider: this.name,
        ...(acoustic.segments === undefined ? {} : { segments: acoustic.segments }),
        ...(acoustic.voiceProfileMatch === undefined
          ? {}
          : { voiceProfileMatch: acoustic.voiceProfileMatch }),
        // Provenance and diagnostics only. Acoustic evidence is typed
        // VoiceProfileMatch; person identity is not decided here. Raw
        // embeddings, scores, and sidecar labels never enter this bag.
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

type SidecarVoiceProfileMatch = {
  status?: string;
  voiceProfileId?: string | null;
};

type SidecarIdentity = {
  identity?: string;
  speakerId?: string | null;
  label?: string | null;
  score?: number | null;
};

type SidecarSegment = {
  startMs?: number;
  endMs?: number;
  speaker?: string;
  voiceProfileMatch?: SidecarVoiceProfileMatch | null;
};

type SidecarTranscribeBody = {
  text?: string;
  language?: string;
  latencyMs?: number;
  identity?: SidecarIdentity | null;
  voiceProfileMatch?: SidecarVoiceProfileMatch | null;
  segments?: SidecarSegment[] | null;
};

/**
 * Normalizes sidecar diarization + acoustic template evidence.
 *
 * Legacy sidecar `speakerId` is mapped to `voiceProfileId` here. Cluster
 * labels stay capture-local. Mixed captures never inherit a whole-audio
 * template match. Scores, labels, embeddings, and person fields are dropped.
 */
function normalizeAcousticEvidence(body: SidecarTranscribeBody): {
  segments?: STTSegment[];
  voiceProfileMatch?: VoiceProfileMatch;
} {
  const sourceSegments = body.segments ?? [];
  const segments = sourceSegments.length > 0 ? sourceSegments.map(normalizeSegment) : undefined;
  const clusters = uniqueClusterIds(segments);
  const mixed = clusters.length > 1;
  const observationMatch =
    readVoiceProfileMatch(body.voiceProfileMatch) ?? readLegacyIdentity(body.identity);

  if (segments === undefined) {
    return observationMatch === undefined ? {} : { voiceProfileMatch: observationMatch };
  }

  if (mixed) {
    // Defense in depth: if the sidecar still returned one whole-audio match
    // and no cluster-scoped matches, drop it rather than labeling everyone.
    const hasClusterScopedMatch = segments.some(
      (segment) => segment.voiceProfileMatch !== undefined
    );
    return {
      segments: hasClusterScopedMatch
        ? segments.map((segment) =>
            segment.voiceProfileMatch === undefined
              ? { ...segment, voiceProfileMatch: { status: "NO_MATCH" as const } }
              : segment
          )
        : segments.map((segment) => ({
            ...segment,
            voiceProfileMatch: { status: "NO_MATCH" as const }
          }))
    };
  }

  if (observationMatch !== undefined && segments.length > 0) {
    return {
      voiceProfileMatch: observationMatch,
      segments: segments.map((segment) =>
        segment.voiceProfileMatch === undefined
          ? { ...segment, voiceProfileMatch: observationMatch }
          : segment
      )
    };
  }

  return {
    segments,
    ...(observationMatch === undefined ? {} : { voiceProfileMatch: observationMatch })
  };
}

function normalizeSegment(segment: SidecarSegment): STTSegment {
  const match = readVoiceProfileMatch(segment.voiceProfileMatch);
  return {
    segmentId: randomUUID(),
    startMs: segment.startMs,
    endMs: segment.endMs,
    ...(segment.speaker !== undefined ? { speakerClusterId: String(segment.speaker) } : {}),
    ...(match === undefined ? {} : { voiceProfileMatch: match })
  };
}

function uniqueClusterIds(segments: STTSegment[] | undefined): string[] {
  if (segments === undefined) return [];
  const ids: string[] = [];
  for (const segment of segments) {
    const clusterId = segment.speakerClusterId;
    if (clusterId === undefined || ids.includes(clusterId)) continue;
    ids.push(clusterId);
  }
  return ids;
}

function readVoiceProfileMatch(
  value: SidecarVoiceProfileMatch | null | undefined
): VoiceProfileMatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (value.status === "MATCHED") {
    const voiceProfileId =
      typeof value.voiceProfileId === "string" && value.voiceProfileId.trim()
        ? value.voiceProfileId.trim()
        : undefined;
    if (!voiceProfileId) return { status: "NO_MATCH" };
    return { status: "MATCHED", voiceProfileId };
  }
  if (value.status === "NO_MATCH") return { status: "NO_MATCH" };
  return undefined;
}

function readLegacyIdentity(
  value: SidecarIdentity | null | undefined
): VoiceProfileMatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  // Legacy speakerId is the acoustic template id, never a person id.
  if (value.identity === "KNOWN" && typeof value.speakerId === "string" && value.speakerId.trim()) {
    return { status: "MATCHED", voiceProfileId: value.speakerId.trim() };
  }
  if (value.identity === "UNKNOWN" || value.identity === "KNOWN") {
    return { status: "NO_MATCH" };
  }
  return undefined;
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
