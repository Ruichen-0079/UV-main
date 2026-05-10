import type { ProviderHealth, ProviderMetadata } from "./common.js";

export type EmbeddingOutput = ProviderMetadata & {
  vector: number[];
};

export type EmbeddingBatchOutput = ProviderMetadata & {
  vectors: number[][];
};

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  healthCheck(): Promise<ProviderHealth>;
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
