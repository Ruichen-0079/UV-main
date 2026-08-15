import type {
  ProviderCallOptions,
  ProviderHealth,
  ProviderMetadata,
  TextMessage
} from "./common.js";

export type VisionInput = {
  image?: Uint8Array | undefined;
  imageBuffer?: Uint8Array | undefined;
  imageUrl?: string | undefined;
  localFilePath?: string | undefined;
  imageBase64?: string | undefined;
  mimeType?: string | undefined;
  prompt?: string | undefined;
  messages?: TextMessage[] | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type VisionOutput = ProviderMetadata & {
  text: string;
  labels?: string[] | undefined;
  objects?: string[] | undefined;
  sceneSummary?: string | undefined;
  confidence?: number | undefined;
};

export interface VisionProvider {
  readonly name: string;
  healthCheck(): Promise<ProviderHealth>;
  analyzeImage(input: VisionInput, options?: ProviderCallOptions): Promise<VisionOutput>;
}
