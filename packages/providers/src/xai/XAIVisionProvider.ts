import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { ProviderCallOptions, ProviderHealth, TextMessage, TokenUsage } from "../types/common.js";
import { ProviderError, ProviderErrorCode } from "../types/errors.js";
import { createTransportAbort } from "../transport-abort.js";
import type { VisionInput, VisionOutput, VisionProvider } from "../types/vision.js";
import {
  createXAIStatusError,
  createXAITransportAbortError,
  ensureXAIConfig,
  healthCheckXAI,
  parseJsonResponse,
  throwIfXAITransportAborted,
  xaiFetch,
  type XAIProviderOptions
} from "./common.js";

type XAIChatResponse = {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export class XAIVisionProvider implements VisionProvider {
  readonly name = "xai";

  constructor(private readonly options: XAIProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    return healthCheckXAI(this.name, "vision", this.options);
  }

  async analyzeImage(input: VisionInput, options?: ProviderCallOptions): Promise<VisionOutput> {
    const transport = createTransportAbort({
      signal: options?.signal,
      timeoutMs: this.options.timeoutMs ?? 30000
    });
    let transportStarted = false;

    try {
      throwIfXAITransportAborted(this.name, "vision", transport);
      ensureXAIConfig(this.name, "vision", this.options);

      const start = performance.now();
      const imageUrl = await resolveImageUrl(input);
      throwIfXAITransportAborted(this.name, "vision", transport);
      if (!transport.markStarted()) {
        throwIfXAITransportAborted(this.name, "vision", transport);
        throw new Error("xAI vision transport could not start.");
      }
      transportStarted = true;
      const response = await xaiFetch(this.options, "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: buildVisionMessages(input, imageUrl)
        })
      }, transport.signal);
      if (!response.ok) {
        throw await createXAIStatusError(this.name, "vision", response);
      }

      const rawResponse = await parseJsonResponse(this.name, "vision", response);
      throwIfXAITransportAborted(this.name, "vision", transport);
      const normalized = normalizeVisionResponse(rawResponse);

      return {
        text: normalized.text,
        sceneSummary: normalized.text,
        latencyMs: Math.round(performance.now() - start),
        model: normalized.model,
        tokenUsage: normalized.tokenUsage,
        debug: this.options.includeRawResponse ? { rawResponse } : undefined
      };
    } catch (error) {
      if (transport.source !== null) {
        throw createXAITransportAbortError(this.name, "vision", transport);
      }
      if (error instanceof ProviderError) {
        throw error;
      }
      if (!transportStarted) {
        throw error;
      }
      throw new ProviderError({
        provider: this.name,
        capability: "vision",
        code: ProviderErrorCode.NetworkError,
        message: "xAI vision network request failed.",
        cause: error
      });
    } finally {
      transport.cleanup();
    }
  }
}

async function resolveImageUrl(input: VisionInput): Promise<string> {
  if (input.imageUrl) {
    return input.imageUrl;
  }

  if (input.imageBase64) {
    return toDataUrl(input.imageBase64, input.mimeType);
  }

  const buffer = input.imageBuffer ?? input.image;
  if (buffer) {
    return toDataUrl(Buffer.from(buffer).toString("base64"), input.mimeType);
  }

  if (input.localFilePath) {
    const file = await readFile(input.localFilePath);
    return toDataUrl(
      file.toString("base64"),
      input.mimeType ?? mimeTypeFromPath(input.localFilePath)
    );
  }

  throw new ProviderError({
    provider: "xai",
    capability: "vision",
    code: ProviderErrorCode.UnsupportedInput,
    message:
      "Vision input must include imageUrl, localFilePath, imageBase64, imageBuffer, or image.",
    retryable: false
  });
}

function buildVisionMessages(
  input: VisionInput,
  imageUrl: string
): Array<{
  role: TextMessage["role"];
  content: string | Array<Record<string, unknown>>;
}> {
  const prompt = input.prompt ?? "Analyze this image.";
  const priorMessages =
    input.messages?.map((message) => ({
      role: message.role,
      content: message.content
    })) ?? [];

  return [
    ...priorMessages,
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: imageUrl
          }
        },
        {
          type: "text",
          text: prompt
        }
      ]
    }
  ];
}

function normalizeVisionResponse(rawResponse: unknown): {
  text: string;
  model?: string | undefined;
  tokenUsage?: TokenUsage | undefined;
} {
  if (!isXAIChatResponse(rawResponse)) {
    throw new ProviderError({
      provider: "xai",
      capability: "vision",
      code: ProviderErrorCode.MalformedResponse,
      message: "xAI vision response did not match the expected chat completion shape.",
      retryable: false,
      cause: rawResponse
    });
  }

  const text = rawResponse.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new ProviderError({
      provider: "xai",
      capability: "vision",
      code: ProviderErrorCode.MalformedResponse,
      message: "xAI vision response did not include text content.",
      retryable: false,
      cause: rawResponse
    });
  }

  return {
    text,
    model: rawResponse.model,
    tokenUsage: normalizeUsage(rawResponse.usage)
  };
}

function isXAIChatResponse(value: unknown): value is XAIChatResponse {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as XAIChatResponse).choices)
  );
}

function normalizeUsage(usage: XAIChatResponse["usage"]): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  };
}

function toDataUrl(base64: string, mimeType = "image/png"): string {
  if (base64.startsWith("data:")) {
    return base64;
  }

  return `data:${mimeType};base64,${base64}`;
}

function mimeTypeFromPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  if (extension === ".gif") {
    return "image/gif";
  }

  return "image/png";
}
