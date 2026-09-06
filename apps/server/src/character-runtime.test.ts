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

function characterHarness(overrides: { responses: ChatOutput[] }) {
  const generateChat = vi.fn(async (_input: ChatInput): Promise<ChatOutput> => {
    const next = overrides.responses.shift();
    if (!next) {
      throw new Error("unexpected Character call");
    }
    return next;
  });
  return { generateChat };
}

describe("production Character runtime adapter", () => {
  it("returns a full orthogonal CharacterDecision for an accepted RESPOND pass", async () => {
    const calls = characterHarness({
      responses: [output('{"disposition":"RESPOND","text":"A simple answer."}')]
    });

    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Is this directed to YUVI?",
      generateChat: calls.generateChat
    });

    expect(result.decision).toEqual({
      addressing: "DIRECTED_TO_YUVI",
      reply: { disposition: "RESPOND", text: "A simple answer." },
      proactive: { action: "KEEP" }
    });
    expect(result.providerMetadata.model).toBe("private-chat-model");
    expect(result.cognitionHandoff).toBeUndefined();
    expect(calls.generateChat).toHaveBeenCalledTimes(1);
    const system = calls.generateChat.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(system).toContain("Output-language preference: AUTO");
    expect(system).toContain("follow the current interaction context naturally");
  });

  it.each([
    ["EN", "English"],
    ["ZH", "Chinese"],
    ["JA", "Japanese"]
  ] as const)(
    "admits explicit %s as the final %s Character expression language",
    async (language, name) => {
      const calls = characterHarness({
        responses: [output('{"disposition":"RESPOND","text":"Final expression."}')]
      });

      await createServerCharacterPort().generate({
        prompt,
        userMessage: "Use the selected language.",
        outputLanguage: language,
        generateChat: calls.generateChat
      });

      const system = calls.generateChat.mock.calls[0]?.[0].messages[0]?.content ?? "";
      expect(system).toContain(`Output-language preference: ${language}`);
      expect(system).toContain(`final Character expression must be in ${name}`);
      expect(system).toContain(`"outputLanguage":"${language}"`);
    }
  );

  it.each(["SILENCE", "TERMINATE"] as const)(
    "represents %s as a first-class decision instead of empty text",
    async (disposition) => {
      const calls = characterHarness({
        responses: [output(`{"disposition":"${disposition}"}`)]
      });

      const result = await createServerCharacterPort().generate({
        prompt,
        userMessage: "Directed input.",
        generateChat: calls.generateChat
      });

      expect(result.decision).toEqual({
        addressing: "DIRECTED_TO_YUVI",
        reply: { disposition },
        proactive: { action: "KEEP" }
      });
    }
  );

  it("hands the Cognition escalation to Runtime without executing it", async () => {
    const calls = characterHarness({
      responses: [output('{"disposition":"NEED_COGNITION","focus":"verification"}')]
    });

    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Verify this claim carefully.",
      generateChat: calls.generateChat
    });

    expect(result.decision.reply).toEqual({
      disposition: "NEED_COGNITION",
      focus: "verification"
    });
    expect(result.cognitionHandoff).toBeDefined();
    expect(result.cognitionHandoff?.request).toMatchObject({
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "verification"
    });
    expect(result.cognitionHandoff?.problem).toContain("verification");
    expect(result.cognitionHandoff?.problem).toContain("Verify this claim carefully.");
    // One Chat call only: the adapter never executes Cognition itself.
    expect(calls.generateChat).toHaveBeenCalledTimes(1);
  });

  it("re-enters Character with the completed Cognition round-trip and keeps it opaque", async () => {
    const calls = characterHarness({
      responses: [output('{"disposition":"RESPOND","text":"The final answer."}')]
    });

    const result = await createServerCharacterPort().generateAfterCognition({
      prompt,
      userMessage: "Verify this claim carefully.",
      outputLanguage: "EN",
      cognitionRoundTrip: roundTrip(),
      generateChat: calls.generateChat
    });

    expect(result.decision).toEqual({
      addressing: "DIRECTED_TO_YUVI",
      reply: { disposition: "RESPOND", text: "The final answer." },
      proactive: { action: "KEEP" }
    });
    const system = calls.generateChat.mock.calls[0]?.[0].messages[0]?.content ?? "";
    expect(system).toContain("The normalized answer.");
    expect(system).toContain("COGNITION_RESULT");
    expect(system).toContain("Output-language preference: EN");
    expect(system).toContain('"outputLanguage":"EN"');
    expect(system).not.toContain("reasoning_content");
  });

  it("returns a repeated NEED_COGNITION faithfully and lets Runtime fail the turn", async () => {
    const calls = characterHarness({
      responses: [output('{"disposition":"NEED_COGNITION"}')]
    });

    const result = await createServerCharacterPort().generateAfterCognition({
      prompt,
      userMessage: "Do not recurse.",
      cognitionRoundTrip: roundTrip(),
      generateChat: calls.generateChat
    });

    expect(result.decision.reply).toEqual({ disposition: "NEED_COGNITION" });
    expect(calls.generateChat).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the Cognition result exceeds the Character context budget", async () => {
    const oversizedRoundTrip = {
      ...roundTrip(),
      result: {
        version: "character-cognition-result.v1",
        status: "SUCCESS",
        // Valid at the 5H Cognition boundary (16k cap) yet larger than the
        // 5K post-Cognition Character context budget (12k semantic chars).
        answer: "x".repeat(13_000)
      }
    };
    const calls = characterHarness({ responses: [] });

    await expect(
      createServerCharacterPort().generateAfterCognition({
        prompt,
        userMessage: "Over budget.",
        cognitionRoundTrip: oversizedRoundTrip,
        generateChat: calls.generateChat
      })
    ).rejects.toThrow("exceeded the Character context budget");
    expect(calls.generateChat).not.toHaveBeenCalled();
  });

  it("keeps cancellation bounded before Character execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = characterHarness({
      responses: [output('{"disposition":"RESPOND","text":"Too late."}')]
    });

    await expect(
      createServerCharacterPort().generate({
        prompt,
        userMessage: "Cancelled.",
        signal: controller.signal,
        generateChat: calls.generateChat
      })
    ).rejects.toThrow("cancelled");
    expect(calls.generateChat).not.toHaveBeenCalled();
  });

  it("keeps cancellation bounded before Character re-entry execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = characterHarness({
      responses: [output('{"disposition":"RESPOND","text":"Too late."}')]
    });

    await expect(
      createServerCharacterPort().generateAfterCognition({
        prompt,
        userMessage: "Cancelled.",
        cognitionRoundTrip: roundTrip(),
        signal: controller.signal,
        generateChat: calls.generateChat
      })
    ).rejects.toThrow("cancelled");
    expect(calls.generateChat).not.toHaveBeenCalled();
  });
});
