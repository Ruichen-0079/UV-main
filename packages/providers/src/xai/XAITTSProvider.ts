import type { ProviderCallOptions, ProviderHealth } from "../types/common.js";
import { ProviderError, ProviderErrorCode } from "../types/errors.js";
import { createTransportAbort } from "../transport-abort.js";
import type { TTSInput, TTSOutput, TTSProvider } from "../types/tts.js";
import {
  createXAIStatusError,
  createXAITransportAbortError,
  ensureXAIConfig,
  healthCheckXAI,
  throwIfXAITransportAborted,
  xaiFetch,
  type XAIProviderOptions
} from "./common.js";

export type XAITTSProviderOptions = XAIProviderOptions & {
  defaultVoice?: string | undefined;
};

export class XAITTSProvider implements TTSProvider {
  readonly name = "xai";

  constructor(private readonly options: XAITTSProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    return healthCheckXAI(this.name, "tts", this.options);
  }

  async synthesizeSpeech(input: TTSInput, options?: ProviderCallOptions): Promise<TTSOutput> {
    const transport = createTransportAbort({
      signal: options?.signal,
      timeoutMs: this.options.timeoutMs ?? 30000
    });

    try {
      throwIfXAITransportAborted(this.name, "tts", transport);
      ensureXAIConfig(this.name, "tts", this.options);

      const start = performance.now();
      if (!transport.markStarted()) {
        throwIfXAITransportAborted(this.name, "tts", transport);
        throw new Error("xAI TTS transport could not start.");
      }
      const response = await xaiFetch(this.options, "/tts", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.options.model,
          text: input.text,
          voice_id: input.voice ?? this.options.defaultVoice,
          format: input.format,
          speed: input.speed
        })
      }, transport.signal);
      if (!response.ok) {
        throw await createXAIStatusError(this.name, "tts", response);
      }

      const audioBuffer = new Uint8Array(await response.arrayBuffer());
      throwIfXAITransportAborted(this.name, "tts", transport);
      const mimeType = response.headers.get("content-type") ?? mimeTypeFromFormat(input.format);

      return {
        audio: audioBuffer,
        audioBuffer,
        audioBase64: Buffer.from(audioBuffer).toString("base64"),
        mimeType,
        latencyMs: Math.round(performance.now() - start),
        model: this.options.model,
        providerMetadata: {
          voice: input.voice ?? this.options.defaultVoice,
          format: input.format
        }
      };
    } catch (error) {
      if (transport.source !== null) {
        throw createXAITransportAbortError(this.name, "tts", transport);
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      throw new ProviderError({
        provider: this.name,
        capability: "tts",
        code: ProviderErrorCode.NetworkError,
        message: "xAI TTS request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }
}

function mimeTypeFromFormat(format: TTSInput["format"]): string {
  if (format === "wav") {
    return "audio/wav";
  }

  if (format === "opus") {
    return "audio/opus";
  }

  if (format === "pcm") {
    return "audio/pcm";
  }

  if (format === "mulaw") {
    return "audio/basic";
  }

  if (format === "alaw") {
    return "audio/alaw";
  }

  return "audio/mpeg";
}
