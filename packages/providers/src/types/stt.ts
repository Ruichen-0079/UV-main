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

export type STTSegment = {
  /** Stable identity of this finalized segment; never derived from transcript text. */
  segmentId?: string | undefined;
  /**
   * Transcript attributed to this segment. Diarization-only spans carry no
   * per-span transcript and omit this field.
   */
  text?: string | undefined;
  startMs?: number | undefined;
  endMs?: number | undefined;
  confidence?: number | undefined;
  /**
   * Diarization cluster label, valid only inside this one finalized
   * observation. It is not a person id, not a voice profile id, and must
   * never be persisted as identity truth.
   */
  speakerClusterId?: string | undefined;
};

export type STTOutput = ProviderMetadata & {
  /**
   * Stable identity of this finalized speech observation; distinct for every
   * transcription result and never derived from transcript text. A finalized
   * observation is not a user interaction on its own.
   */
  observationId?: string | undefined;
  text: string;
  language?: string | undefined;
  confidence?: number | undefined;
  segments?: STTSegment[] | undefined;
};

export interface STTProvider {
  readonly name: string;
  healthCheck(): Promise<ProviderHealth>;
  transcribeAudio(input: STTInput, options?: ProviderCallOptions): Promise<STTOutput>;
}
