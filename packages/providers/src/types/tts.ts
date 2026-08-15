import type { ProviderCallOptions, ProviderHealth, ProviderMetadata } from "./common.js";

export type TTSInput = {
  text: string;
  voice?: string | undefined;
  format?: "mp3" | "wav" | "opus" | "pcm" | "mulaw" | "alaw" | undefined;
  speed?: number | undefined;
  /** @deprecated Use ProviderCallOptions.signal at the provider call boundary. */
  signal?: AbortSignal | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type TTSOutput = ProviderMetadata & {
  audio: Uint8Array;
  audioBuffer?: Uint8Array | undefined;
  audioBase64?: string | undefined;
  mimeType: string;
  durationMs?: number | undefined;
};

export interface TTSProvider {
  readonly name: string;
  healthCheck(): Promise<ProviderHealth>;
  synthesizeSpeech(input: TTSInput, options?: ProviderCallOptions): Promise<TTSOutput>;
}
