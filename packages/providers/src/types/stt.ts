import type { ProviderCallOptions, ProviderHealth, ProviderMetadata } from "./common.js";

export type STTInput = {
  audio?: Uint8Array | undefined;
  audioBuffer?: Uint8Array | undefined;
  audioUrl?: string | undefined;
  localFilePath?: string | undefined;
  audioBase64?: string | undefined;
  mimeType?: string | undefined;
  language?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type STTOutput = ProviderMetadata & {
  text: string;
  language?: string | undefined;
  confidence?: number | undefined;
  segments?:
    | Array<{
        text: string;
        startMs?: number | undefined;
        endMs?: number | undefined;
        confidence?: number | undefined;
      }>
    | undefined;
};

export interface STTProvider {
  readonly name: string;
  healthCheck(): Promise<ProviderHealth>;
  transcribeAudio(input: STTInput, options?: ProviderCallOptions): Promise<STTOutput>;
}
