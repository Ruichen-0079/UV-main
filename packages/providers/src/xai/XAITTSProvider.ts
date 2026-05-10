import type { ProviderHealth } from "../types/common.js";
import type { TTSInput, TTSOutput, TTSProvider } from "../types/tts.js";
import {
  ensureXAIConfig,
  healthCheckXAI,
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

  async synthesizeSpeech(input: TTSInput): Promise<TTSOutput> {
    ensureXAIConfig(this.name, "tts", this.options);

    const start = performance.now();
    const response = await xaiFetch(this.name, "tts", this.options, "/tts", {
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
    });

    const audioBuffer = new Uint8Array(await response.arrayBuffer());
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
