import { PromptBuilder } from "@companion/prompt-builder";
import type { ChatInput, ChatOutput } from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import { createServerCharacterPort } from "./character-runtime.js";

const prompt = new PromptBuilder().buildPrompt({
  systemIdentity: "YUVI",
  characterStyle: "Warm and precise.",
  userMessage: "What do you see?"
});

function output(content: string): ChatOutput {
  return {
    message: { role: "assistant", content },
    finishReason: "stop",
    model: "private-chat-model"
  };
}

function harnessInput(responses: ChatOutput[]) {
  const generateChat = vi.fn(async (_input: ChatInput): Promise<ChatOutput> => {
    const next = responses.shift();
    if (!next) {
      throw new Error("unexpected Character call");
    }
    return next;
  });
  const executeCognition = vi.fn(async () => ({
    version: "character-harness-5h.v1",
    request: { version: "character-harness-5g.v1", kind: "NEED_COGNITION" },
    result: { version: "character-cognition-result.v1", status: "SUCCESS", answer: "A cat." }
  }));
  return { generateChat, executeCognition };
}

describe("production Character vision evidence", () => {
  it("projects available vision evidence without provider wire details", async () => {
    const calls = harnessInput([output('{"disposition":"RESPOND","text":"A cat by the window."}')]);
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "The user shared an image.",
      vision: {
        text: "A cat sitting on a windowsill.",
        objects: ["cat", "window"],
        sceneSummary: "A calm indoor scene.",
        confidence: 0.9,
        status: "AVAILABLE",
        lowConfidence: false
      },
      generateChat: calls.generateChat,
      executeCognition: calls.executeCognition
    });

    expect(result.content).toBe("A cat by the window.");
    const system = calls.generateChat.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(system).toContain("ATTENTION_ANCHORS");
    expect(system).toContain("A cat sitting on a windowsill.");
    expect(system).toContain("vision-evidence");
    expect(system).not.toContain("test-vision");
    expect(system).not.toContain("rawResponse");
    expect(system).not.toContain("http");
  });

  it("keeps SILENCE valid for empty vision without inventing facts", async () => {
    const calls = harnessInput([output('{"disposition":"SILENCE"}')]);
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "The user shared an image.",
      vision: { text: "", objects: [], status: "EMPTY", lowConfidence: false },
      generateChat: calls.generateChat,
      executeCognition: calls.executeCognition
    });
    expect(result.content).toBe("");
    const system = calls.generateChat.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(system).toContain('"state":"EMPTY"');
  });

  it("marks low-confidence vision as PARTIAL and preserves uncertainty", async () => {
    const calls = harnessInput([output('{"disposition":"RESPOND","text":"Maybe a cat."}')]);
    await createServerCharacterPort().generate({
      prompt,
      userMessage: "The user shared an image.",
      vision: {
        text: "maybe a cat",
        objects: [],
        confidence: 0.1,
        status: "LOW_CONFIDENCE",
        lowConfidence: true
      },
      generateChat: calls.generateChat,
      executeCognition: calls.executeCognition
    });
    const system = calls.generateChat.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(system).toContain('"state":"PARTIAL"');
    expect(system).toContain("low confidence");
  });

  it("includes vision in the bounded NEED_COGNITION problem without provider routing", async () => {
    const calls = harnessInput([
      output('{"disposition":"NEED_COGNITION","focus":"identify the animal"}'),
      output('{"disposition":"RESPOND","text":"It looks like a cat."}')
    ]);
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "The user shared an image.",
      vision: {
        text: "Blurry animal shape.",
        objects: ["animal"],
        confidence: 0.2,
        status: "LOW_CONFIDENCE",
        lowConfidence: true
      },
      generateChat: calls.generateChat,
      executeCognition: calls.executeCognition
    });
    expect(result.content).toBe("It looks like a cat.");
    expect(calls.executeCognition).toHaveBeenCalledTimes(1);
    const firstCall = calls.executeCognition.mock.calls[0] as unknown as unknown[];
    const problem = String(firstCall[1] ?? "");
    expect(problem).toContain("Blurry animal shape.");
    expect(problem).not.toContain("test-vision");
  });
});
