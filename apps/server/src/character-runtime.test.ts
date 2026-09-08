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
  it("keeps time after reusable semantic evidence without changing admitted sections", async () => {
    const captures: string[] = [];
    for (const isoTimestamp of ["2026-09-08T10:00:00Z", "2026-09-08T10:01:00Z"]) {
      const input = new PromptBuilder().buildPrompt({
        systemIdentity: "YUVI",
        characterStyle: "Warm and precise.",
        relationshipContext: "Familiarity is unknown.",
        currentTime: { isoTimestamp },
        directContext: "User: Check the garden plan.",
        directContextEnabled: true,
        retrievedMemories: ["The garden includes mint."],
        memoryEnabled: true,
        userMessage: "Continue."
      });
      const before = JSON.stringify(input);
      await createServerCharacterPort().generate({
        prompt: input,
        userMessage: "Continue.",
        generateChat: async (chat) => {
          captures.push(chat.messages[0]!.content);
          return output('{"disposition":"RESPOND","text":"The plan is ready."}');
        }
      });
      expect(JSON.stringify(input)).toBe(before);
    }
    const contexts = captures.map((text) => JSON.parse(text.split("Semantic context:\n")[1]!));
    expect(contexts[0].sections.at(-1).kind).toBe("TEMPORAL_CONTEXT");
    expect(
      contexts[0].sections.filter((s: { kind: string }) => s.kind === "TEMPORAL_CONTEXT")
    ).toHaveLength(1);
    expect(contexts[0].sections.slice(0, -1)).toEqual(contexts[1].sections.slice(0, -1));
    expect(captures[0]!.split('"kind":"TEMPORAL_CONTEXT"')[0]).toBe(
      captures[1]!.split('"kind":"TEMPORAL_CONTEXT"')[0]
    );
    expect(captures[0]).toContain("The garden includes mint.");
    expect(captures[1]).toContain("2026-09-08T10:01:00Z");
  });

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

describe("semantic current-screen grounding", () => {
  it("requests evidence by need and resumes the same original user turn", async () => {
    const calls = characterHarness({
      responses: [
        output('{"visualNeed":"Read the visible error and relevant UI state"}'),
        output('{"disposition":"RESPOND","text":"The dialog says permission denied."}')
      ]
    });
    const requestVisualEvidence = vi.fn(async () => ({
      status: "AVAILABLE" as const,
      observations: "Permission denied"
    }));
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "What is the error on my screen?",
      generateChat: calls.generateChat,
      requestVisualEvidence
    });
    expect(requestVisualEvidence).toHaveBeenCalledTimes(1);
    expect(requestVisualEvidence).toHaveBeenCalledWith({
      need: "Read the visible error and relevant UI state"
    });
    expect(result.decision.reply).toMatchObject({
      disposition: "RESPOND",
      text: "The dialog says permission denied."
    });
    expect(calls.generateChat).toHaveBeenCalledTimes(2);
    const resumed = calls.generateChat.mock.calls[1]![0];
    expect(resumed.messages[1]?.content).toBe("What is the error on my screen?");
    expect(JSON.stringify(resumed)).toContain("Permission denied");
    expect(JSON.stringify(resumed)).toContain("untrusted evidence");
  });
  it("passes bounded evidence to the existing Cognition handoff", async () => {
    const calls = characterHarness({
      responses: [
        output('{"visualNeed":"Read the formula"}'),
        output('{"disposition":"NEED_COGNITION","focus":"Solve the visible formula"}')
      ]
    });
    const result = await createServerCharacterPort().generate({
      prompt,
      userMessage: "Solve this",
      generateChat: calls.generateChat,
      requestVisualEvidence: async () => ({
        status: "AVAILABLE",
        observations: "x^2 = 4; the label is unreadable"
      })
    });
    expect(result.cognitionHandoff?.problem).toContain("x^2 = 4");
    expect(result.cognitionHandoff?.problem).toContain("unreadable");
  });
  it("does not ground ordinary chat and rejects recursive visual requests", async () => {
    const requestVisualEvidence = vi.fn(async () => ({
      status: "UNAVAILABLE" as const,
      observations: "Screen contents are unknown"
    }));
    const ordinary = characterHarness({
      responses: [output('{"disposition":"RESPOND","text":"Hello"}')]
    });
    await createServerCharacterPort().generate({
      prompt,
      userMessage: "Hi",
      generateChat: ordinary.generateChat,
      requestVisualEvidence
    });
    expect(requestVisualEvidence).not.toHaveBeenCalled();
    const repeated = characterHarness({
      responses: [output('{"visualNeed":"Read screen"}'), output('{"visualNeed":"Again"}')]
    });
    await expect(
      createServerCharacterPort().generate({
        prompt,
        userMessage: "Look",
        generateChat: repeated.generateChat,
        requestVisualEvidence
      })
    ).rejects.toThrow("repeated");
    expect(requestVisualEvidence).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(repeated.generateChat.mock.calls[1])).toContain(
      "Screen contents are unknown"
    );
  });
});
