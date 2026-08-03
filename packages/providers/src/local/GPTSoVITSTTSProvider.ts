import type { ProviderHealth } from "../types/common.js";
import { ProviderError, ProviderErrorCode } from "../types/errors.js";
import type { TTSInput, TTSOutput, TTSProvider } from "../types/tts.js";

export type GPTSoVITSTTSProviderOptions = {
  wrapperBaseUrl: string;
  upstreamBaseUrl: string;
  model: string;
  /** Paths are recorded as deployment configuration; the managed service loads them at startup. */
  gptWeightsPath?: string | undefined;
  sovitsWeightsPath?: string | undefined;
  defaultLanguage?: string | undefined;
  speaker?: string | undefined;
  style?: string | undefined;
  referenceRank?: number | undefined;
  referenceAudioPath?: string | undefined;
  referenceText?: string | undefined;
  referenceLanguage?: string | undefined;
  textSplitMethod?: string | undefined;
  topK?: number | undefined;
  topP?: number | undefined;
  temperature?: number | undefined;
  repetitionPenalty?: number | undefined;
  sampleSteps?: number | undefined;
  timeoutMs?: number | undefined;
};

/**
 * Adapter for the local Alice GPT-SoVITS stack. Japanese requests use the
 * managed 9881 wrapper; other configured languages use api_v2 directly so a
 * Japanese reference clip can drive English or mixed-language synthesis.
 */
export class GPTSoVITSTTSProvider implements TTSProvider {
  readonly name = "local";

  constructor(private readonly options: GPTSoVITSTTSProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${trimTrailingSlash(this.options.wrapperBaseUrl)}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000)
      });
      if (!response.ok) {
        throw new Error(`local GPT-SoVITS health returned ${response.status}`);
      }
      const body = (await response.json()) as { model_loaded?: unknown };
      if (body.model_loaded !== true) {
        throw new Error("local GPT-SoVITS model is not loaded");
      }
      return {
        provider: this.name,
        name: this.name,
        capability: "tts",
        status: "healthy",
        configured: true,
        available: true,
        mock: false,
        baseUrl: this.options.wrapperBaseUrl,
        model: this.options.model,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        message: "Local GPT-SoVITS wrapper is ready."
      };
    } catch (error) {
      return {
        provider: this.name,
        name: this.name,
        capability: "tts",
        status: "unavailable",
        configured: true,
        available: false,
        mock: false,
        baseUrl: this.options.wrapperBaseUrl,
        model: this.options.model,
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : "Local GPT-SoVITS health check failed."
      };
    }
  }

  async synthesizeSpeech(input: TTSInput): Promise<TTSOutput> {
    if (!input.text.trim()) {
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: ProviderErrorCode.UnsupportedInput,
        message: "TTS text must not be empty.",
        retryable: false
      });
    }

    const language = normalizeLanguage(
      typeof input.metadata?.["language"] === "string"
        ? input.metadata["language"]
        : (this.options.defaultLanguage ?? "ja")
    );
    const start = performance.now();
    const request = isJapanese(language)
      ? {
          url: `${trimTrailingSlash(this.options.wrapperBaseUrl)}/tts`,
          body: {
            text: input.text,
            language,
            speaker: input.voice ?? this.options.speaker ?? "alice",
            style: this.options.style ?? "neutral",
            reference_rank: this.options.referenceRank ?? 0
          }
        }
      : {
          url: `${trimTrailingSlash(this.options.upstreamBaseUrl)}/tts`,
          body: this.buildUpstreamRequest(input, language)
        };

    const response = await this.fetchAudio(request.url, request.body, input.signal);
    const audio = response.audio;
    if (audio.byteLength === 0) {
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: ProviderErrorCode.MalformedResponse,
        message: "Local GPT-SoVITS returned empty audio.",
        retryable: false
      });
    }

    return {
      audio,
      audioBuffer: audio,
      audioBase64: Buffer.from(audio).toString("base64"),
      mimeType: response.mimeType,
      latencyMs: Math.round(performance.now() - start),
      model: this.options.model,
      finalProvider: this.name,
      providerMetadata: {
        language,
        speaker: input.voice ?? this.options.speaker ?? "alice",
        transport: isJapanese(language) ? "wrapper" : "api_v2"
      }
    };
  }

  private buildUpstreamRequest(input: TTSInput, language: string): Record<string, unknown> {
    if (!this.options.referenceAudioPath || !this.options.referenceText) {
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: ProviderErrorCode.UnsupportedInput,
        message:
          "A reference audio path and reference text are required for non-Japanese GPT-SoVITS synthesis.",
        retryable: false
      });
    }

    return {
      text: input.text,
      text_lang: language,
      ref_audio_path: this.options.referenceAudioPath,
      prompt_text: this.options.referenceText,
      prompt_lang: this.options.referenceLanguage ?? "ja",
      text_split_method: this.options.textSplitMethod ?? "cut0",
      batch_size: 1,
      media_type: "wav",
      streaming_mode: false,
      top_k: this.options.topK ?? 15,
      top_p: this.options.topP ?? 1,
      temperature: this.options.temperature ?? 1,
      repetition_penalty: this.options.repetitionPenalty ?? 1.35,
      sample_steps: this.options.sampleSteps ?? 32,
      speed_factor: input.speed ?? 1
    };
  }

  private async fetchAudio(
    url: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ audio: Uint8Array; mimeType: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: mapStatus(response.status),
          statusCode: response.status,
          message: bodyText
            ? `Local GPT-SoVITS request failed with ${response.status}: ${redact(bodyText).slice(0, 200)}`
            : `Local GPT-SoVITS request failed with ${response.status}.`,
          retryable: response.status === 429 || response.status >= 500
        });
      }
      return {
        audio: new Uint8Array(await response.arrayBuffer()),
        mimeType: response.headers.get("content-type")?.split(";", 1)[0] ?? "audio/wav"
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal?.aborted) {
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: ProviderErrorCode.Cancelled,
          message: "Local GPT-SoVITS synthesis was cancelled.",
          retryable: false,
          cause: error
        });
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ProviderError({
          provider: this.name,
          capability: "tts",
          code: ProviderErrorCode.Timeout,
          message: "Local GPT-SoVITS synthesis timed out.",
          cause: error
        });
      }
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: ProviderErrorCode.NetworkError,
        message: "Local GPT-SoVITS synthesis request failed.",
        cause: error
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function normalizeLanguage(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "jp" || normalized === "japanese") return "ja";
  if (normalized === "en-us" || normalized === "english") return "en";
  return normalized || "ja";
}

function isJapanese(language: string): boolean {
  return language === "ja";
}

function mapStatus(status: number): ProviderErrorCode {
  if (status === 400) return ProviderErrorCode.UnsupportedInput;
  if (status === 429) return ProviderErrorCode.RateLimited;
  if (status >= 500) return ProviderErrorCode.ProviderUnavailable;
  return ProviderErrorCode.ProviderUnavailable;
}

function redact(value: string): string {
  return value
    .replace(/(token|password|secret|api[-_]?key)=?[^\s&]+/gi, "$1=[REDACTED]")
    .replace(/[A-Za-z]:[\\/][^\r\n\"]+/g, "[LOCAL_PATH]");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
