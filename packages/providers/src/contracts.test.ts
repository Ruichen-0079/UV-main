import { describe, expect, it } from "vitest";
import {
  FallbackChatProvider,
  FallbackEmbeddingProvider,
  FallbackReasoningProvider,
  FallbackSTTProvider,
  FallbackTTSProvider,
  FallbackVisionProvider
} from "./registry.js";
import {
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockTTSProvider,
  createMockVisionProvider,
  createMockChatProvider,
  type ChatOutput,
  type ProviderCallOptions,
  type ProviderMetadata,
  type TextMessage
} from "./index.js";

describe("common provider contracts", () => {
  it("accepts one call-level signal while retaining the legacy TTS input signal", async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const chat = createMockChatProvider("contract-chat");
    const reasoning = createMockReasoningProvider("contract-reasoning");
    const stt = createMockSTTProvider("contract-stt");
    const tts = createMockTTSProvider("contract-tts");
    const vision = createMockVisionProvider("contract-vision");

    await expect(
      chat.generateReply({ messages: [{ role: "user", content: "hello" }] }, options)
    ).resolves.toBeDefined();
    await expect(
      reasoning.generateReasoning({ messages: [{ role: "user", content: "think" }] }, options)
    ).resolves.toMatchObject({ answer: expect.any(String), reasoning: "" });
    await expect(stt.transcribeAudio({ audio: new Uint8Array() }, options)).resolves.toBeDefined();
    await expect(
      tts.synthesizeSpeech({ text: "hello", signal: controller.signal }, options)
    ).resolves.toBeDefined();
    await expect(
      vision.analyzeImage({ image: new Uint8Array(), prompt: "describe" }, options)
    ).resolves.toBeDefined();
  });

  it("forwards the exact call options through every non-streaming fallback wrapper", async () => {
    const controller = new AbortController();
    const options: ProviderCallOptions = { signal: controller.signal };
    const observed: Record<string, ProviderCallOptions | undefined> = {};
    const healthCheck = async () => ({
      provider: "leaf",
      status: "healthy" as const,
      checkedAt: new Date().toISOString()
    });

    await new FallbackChatProvider([
      {
        name: "chat-leaf",
        healthCheck,
        async generateReply(_input, receivedOptions) {
          observed["chat"] = receivedOptions;
          return { message: { role: "assistant", content: "chat" } };
        }
      }
    ]).generateReply({ messages: [{ role: "user", content: "hello" }] }, options);

    await new FallbackReasoningProvider([
      {
        name: "reasoning-leaf",
        healthCheck,
        async generateReasoning(_input, receivedOptions) {
          observed["reasoning"] = receivedOptions;
          return { reasoning: "", answer: "reasoning" };
        }
      }
    ]).generateReasoning({ messages: [{ role: "user", content: "think" }] }, options);

    await new FallbackTTSProvider([
      {
        name: "tts-leaf",
        healthCheck,
        async synthesizeSpeech(_input, receivedOptions) {
          observed["tts"] = receivedOptions;
          return { audio: new Uint8Array(), mimeType: "audio/wav" };
        }
      }
    ]).synthesizeSpeech({ text: "hello" }, options);

    await new FallbackSTTProvider([
      {
        name: "stt-leaf",
        healthCheck,
        async transcribeAudio(_input, receivedOptions) {
          observed["stt"] = receivedOptions;
          return { text: "transcript" };
        }
      }
    ]).transcribeAudio({ audio: new Uint8Array() }, options);

    await new FallbackVisionProvider([
      {
        name: "vision-leaf",
        healthCheck,
        async analyzeImage(_input, receivedOptions) {
          observed["vision"] = receivedOptions;
          return { text: "vision" };
        }
      }
    ]).analyzeImage({ image: new Uint8Array() }, options);

    const embeddingLeaf = {
      name: "embedding-leaf",
      dimensions: 2,
      model: "embedding-model",
      healthCheck,
      async embedText(_text: string, receivedOptions?: ProviderCallOptions) {
        observed["embeddingText"] = receivedOptions;
        return [1, 2];
      },
      async embedBatch(_texts: string[], receivedOptions?: ProviderCallOptions) {
        observed["embeddingBatch"] = receivedOptions;
        return [[1, 2]];
      }
    };
    const embedding = new FallbackEmbeddingProvider([embeddingLeaf]);
    await embedding.embedText("hello", options);
    await embedding.embedBatch(["hello"], options);

    for (const capability of [
      "chat",
      "reasoning",
      "tts",
      "stt",
      "vision",
      "embeddingText",
      "embeddingBatch"
    ]) {
      expect(observed[capability]).toBe(options);
      expect(observed[capability]?.signal).toBe(controller.signal);
    }
  });

  it("keeps additive metadata optional and preserves reserved tool affordances", () => {
    const metadata: ProviderMetadata = {
      capability: "chat",
      provider: "local",
      model: "local-chat",
      requestId: "request-1",
      providerRequestId: "provider-request-1",
      firstByteLatencyMs: 12,
      firstTokenLatencyMs: 18,
      attemptedProviders: [{ provider: "local", status: "success" }]
    };
    const toolMessage: TextMessage = { role: "tool", content: "reserved result" };
    const reservedOutput: ChatOutput = {
      ...metadata,
      message: toolMessage,
      finishReason: "tool_call"
    };

    expect(reservedOutput.message.role).toBe("tool");
    expect(reservedOutput.finishReason).toBe("tool_call");
    expect(metadata.latencyMs).toBeUndefined();
  });
});
