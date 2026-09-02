import { PromptBuilder } from "@companion/prompt-builder";
import type { ChatInput, ChatOutput } from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import { createServerCharacterPort } from "./character-runtime.js";

const prompt = new PromptBuilder().buildPrompt({
  systemIdentity: "YUVI",
  characterStyle: "Warm and precise.",
  userMessage: "How should I verify this?"
});

function output(content: string, finishReason: ChatOutput["finishReason"] = "stop"): ChatOutput {
  return {
    message: { role: "assistant", content },
    finishReason,
    model: "private-chat-model",
    debug: { rawResponse: { reasoning_content: "must never cross the boundary" } }
  };
}

function roundTrip(status: "SUCCESS" | "UNAVAILABLE" = "SUCCESS") {
  return {
    version: "character-harness-5h.v1",
    request: {
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "verification"
    },
    result:
      status === "SUCCESS"
        ? {
            version: "character-cognition-result.v1",
            status,
            answer: "The normalized answer.",
            uncertainty: ["The source may have changed."],
            caveats: ["Verify the current source before acting."]
          }
        : {
            version: "character-cognition-result.v1",
            status
          }
  };
}

function harnessInput(overrides: {
  responses: ChatOutput[];
  executeCognition?: ReturnType<typeof vi.fn>;
}) {
  const generateChat = vi.fn(async (_input: ChatInput): Promise<ChatOutput> => {
    const next = overrides.responses.shift();
    if (!next) {
      throw new Error("unexpected Character call");
    }
    return next;
  });
  const executeCognition = overrides.executeCognition ?? vi.fn(async () => roundTrip());
  return { generateChat, executeCognition };
}

describe("production Character runtime adapter", () => {
  it("keeps accepted RESPOND on Chat and does not call Cognition", async () => {
    const calls = harnessInput({
      responses: [output('{"disposition":"RESPOND","text":"A simple answer."}')]
    });

    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "A simple question.",
      generateChat: calls.generateChat,
      executeCognition: calls.executeCognition
    });

    expect(result.content).toBe("A simple answer.");
    expect(calls.generateChat).toHaveBeenCalledTimes(1);
    expect(calls.executeCognition).not.toHaveBeenCalled();
  });

  it("executes one NEED_COGNITION round-trip and consumes the normalized result", async () => {
    const calls = harnessInput({
      responses: [
        output('{"disposition":"NEED_COGNITION","focus":"verification"}'),
        output('{"disposition":"RESPOND","text":"<think>private trace</think>The final answer."}')
      ]
    });

    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Please verify this carefully.",
      generateChat: calls.generateChat,
      executeCognition: calls.executeCognition
    });

    expect(result.content).toBe("The final answer.");
    expect(calls.generateChat).toHaveBeenCalledTimes(2);
    expect(calls.executeCognition).toHaveBeenCalledTimes(1);
    expect(calls.executeCognition).toHaveBeenCalledWith(
      expect.objectContaining({
        version: "character-harness-5g.v1",
        kind: "NEED_COGNITION"
      }),
      expect.stringContaining("Please verify this carefully."),
      expect.any(Object)
    );

    const postCognitionRequest = JSON.stringify(calls.generateChat.mock.calls[1]?.[0]);
    expect(postCognitionRequest).toContain("COGNITION_RESULT");
    expect(postCognitionRequest).toContain("The normalized answer.");
    expect(postCognitionRequest).not.toContain("reasoning_content");
    expect(postCognitionRequest).not.toContain("private trace");
  });

  it("returns a bounded Character response when Cognition is unavailable", async () => {
    const executeCognition = vi.fn(async () => roundTrip("UNAVAILABLE"));
    const calls = harnessInput({
      responses: [
        output('{"disposition":"NEED_COGNITION","focus":"availability"}'),
        output('{"disposition":"RESPOND","text":"I cannot verify that right now."}')
      ],
      executeCognition
    });

    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Check the unavailable source.",
      generateChat: calls.generateChat,
      executeCognition
    });

    expect(result.content).toBe("I cannot verify that right now.");
    expect(executeCognition).toHaveBeenCalledTimes(1);
    expect(calls.generateChat.mock.calls[1]?.[0].messages[0]?.content).toContain(
      '"status":"UNAVAILABLE"'
    );
  });

  it("does not issue a duplicate Cognition call when post-Cognition Character asks again", async () => {
    const executeCognition = vi.fn(async () => roundTrip());
    const calls = harnessInput({
      responses: [
        output('{"disposition":"NEED_COGNITION"}'),
        output('{"disposition":"NEED_COGNITION"}')
      ],
      executeCognition
    });

    await expect(
      createServerCharacterPort().generate({
        prompt,
        userMessage: "Do not recurse.",
        generateChat: calls.generateChat,
        executeCognition
      })
    ).rejects.toThrow("after Cognition completed");
    expect(executeCognition).toHaveBeenCalledTimes(1);
    expect(calls.generateChat).toHaveBeenCalledTimes(2);
  });

  it("keeps cancellation bounded before Character or Cognition execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = harnessInput({
      responses: [output('{"disposition":"NEED_COGNITION"}')]
    });

    await expect(
      createServerCharacterPort().generate({
        prompt,
        userMessage: "Cancelled.",
        signal: controller.signal,
        generateChat: calls.generateChat,
        executeCognition: calls.executeCognition
      })
    ).rejects.toThrow("cancelled");
    expect(calls.generateChat).not.toHaveBeenCalled();
    expect(calls.executeCognition).not.toHaveBeenCalled();
  });
});
