import { describe, expect, it } from "vitest";
import {
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockTTSProvider,
  createMockVisionProvider,
  createMockChatProvider,
  type ChatOutput,
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
