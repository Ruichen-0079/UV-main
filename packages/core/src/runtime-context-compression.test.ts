import { PromptBuilder } from "@companion/prompt-builder";
import { describe, expect, it } from "vitest";
import {
  buildPromptWithContextCompression,
  DEFAULT_NEAR_TURN_PROTECTION_LINES
} from "./runtime-context-compression.js";

function createPromptInput() {
  const olderCasualDetail = Array.from({ length: 220 }, (_, index) => {
    const left = String.fromCharCode(97 + (index % 26));
    const right = String.fromCharCode(97 + Math.floor(index / 26));
    return `Older casual context ${left}${right} remains ordinary conversation detail.`;
  });
  const latest = [
    "Latest protected turn: technical exact match port 6121, SHA 9f3a8c1, path /srv/yuvi/run.ts.",
    "Latest correction: I liked blue before; now I prefer green.",
    "Latest temporal note: occurredAt unknown; recordedAt unknown."
  ];
  return {
    systemIdentity: "You are YUVI.",
    characterStyle: "Warm, concise, and grounded.",
    relationshipContext: "Use retrieved context only when relevant.",
    retrievedMemories: [
      {
        content: "The user prefers the local Character model.",
        scope: "project",
        scopeId: "yuvi-runtime",
        memoryLayer: "core",
        status: "active",
        importance: 0.9
      }
    ],
    memoryEnabled: true,
    memoryRetrievalState: "unavailable" as const,
    currentTime: {
      isoTimestamp: "2026-08-31T10:00:00.000Z",
      timezone: "Asia/Shanghai",
      localDate: "2026-08-31",
      temporalNotes: "Missing timestamps remain unknown; do not invent off-screen activity."
    },
    directContext: [...olderCasualDetail, ...latest].join("\n"),
    recentEpisodicMemory:
      "- [L1][time-unknown] User said: I liked blue before; now I prefer green. " +
      "Assistant previously said (non-authoritative, not evidence): blue is current.",
    currentSituation: "The user is interacting through text.",
    tools: [],
    userMessage: "现在最喜欢绿色。"
  };
}

describe("Runtime context compression seam", () => {
  it("does not invoke compression below the existing PromptBuilder budget", () => {
    const promptInput = {
      ...createPromptInput(),
      directContext: "A short recent turn.",
      recentEpisodicMemory: "- [L1] User said: A short recent turn."
    };
    const result = buildPromptWithContextCompression({
      promptBuilder: new PromptBuilder(),
      promptInput,
      mode: "auto"
    });

    expect(result.diagnostics.attempted).toBe(false);
    expect(result.diagnostics.triggered).toBe(false);
    expect(result.diagnostics.fallbackReason).toBeUndefined();
    expect(result.prompt.characterCount).toBeLessThanOrEqual(12_000);
  });

  it("compresses only designated older context and preserves protected semantics", () => {
    const result = buildPromptWithContextCompression({
      promptBuilder: new PromptBuilder(),
      promptInput: createPromptInput(),
      mode: "auto"
    });
    const direct = result.prompt.sections.find((section) => section.name === "DirectContext");
    const relevant = result.prompt.sections.find((section) => section.name === "RelevantMemory");

    expect(result.diagnostics.attempted).toBe(true);
    expect(result.diagnostics.triggered).toBe(true);
    expect(result.diagnostics.compressedSectionNames).toContain("DirectContext");
    expect(result.diagnostics.savedTokens).toBeGreaterThan(0);
    expect(result.diagnostics.reductionPercent).toBeGreaterThan(0);
    expect(result.diagnostics.budgetCompliant).toBe(true);
    expect(result.prompt.characterCount).toBeLessThanOrEqual(12_000);
    expect(result.diagnostics.protectedPreserved).toBe(true);
    expect(result.diagnostics.epistemicMarkersPreserved).toBe(true);
    expect(direct?.content).toContain("Latest protected turn");
    expect(direct?.content).toContain("port 6121");
    expect(direct?.content).toContain("SHA 9f3a8c1");
    expect(direct?.content).toContain("/srv/yuvi/run.ts");
    expect(direct?.content).toContain("Latest correction");
    expect(direct?.content).toContain("occurredAt unknown");
    expect(direct?.content.indexOf("Older casual context aa")).toBeLessThan(
      direct?.content.indexOf("Latest protected turn") ?? -1
    );
    expect(direct?.content.indexOf("Latest correction")).toBeLessThan(
      direct?.content.indexOf("Latest temporal note") ?? -1
    );
    expect(result.prompt.prompt).toContain("现在最喜欢绿色。");
    expect(relevant?.content).toContain("UNAVAILABLE");
    expect(relevant?.content).toContain("do not treat this as EMPTY");
  });

  it("keeps a deterministic near-turn tail and produces stable output", () => {
    const first = buildPromptWithContextCompression({
      promptBuilder: new PromptBuilder(),
      promptInput: createPromptInput(),
      mode: "auto",
      nearTurnProtectionLines: DEFAULT_NEAR_TURN_PROTECTION_LINES
    });
    const second = buildPromptWithContextCompression({
      promptBuilder: new PromptBuilder(),
      promptInput: createPromptInput(),
      mode: "auto",
      nearTurnProtectionLines: DEFAULT_NEAR_TURN_PROTECTION_LINES
    });

    expect(first.prompt.prompt).toBe(second.prompt.prompt);
    expect(first.diagnostics.compressedSectionNames).toEqual(
      second.diagnostics.compressedSectionNames
    );
    expect(
      first.prompt.sections.find((section) => section.name === "DirectContext")?.content
    ).toContain("Latest temporal note: occurredAt unknown; recordedAt unknown.");
  });

  it("does not alter the assistant-initiated prompt shape", () => {
    const { userMessage: _userMessage, ...sharedInput } = createPromptInput();
    const promptInput = {
      ...sharedInput,
      turnOrigin: "assistant-initiated" as const,
      proactiveInstruction:
        "Evaluate whether a specific open reason exists; otherwise choose NO_OP."
    };
    const baseline = new PromptBuilder().buildPrompt(promptInput);
    const result = buildPromptWithContextCompression({
      promptBuilder: new PromptBuilder(),
      promptInput,
      mode: "auto"
    });

    expect(result.prompt.sections.map((section) => section.name)).toEqual(
      baseline.sections.map((section) => section.name)
    );
    expect(result.prompt.prompt).toContain("<ProactiveInstruction>");
    expect(result.prompt.prompt).not.toContain("<UserMessage>");
  });

  it("fails open to the existing builder when protected content cannot fit", () => {
    const promptInput = {
      ...createPromptInput(),
      systemIdentity: "Protected system contract. ".repeat(700),
      maxCharacters: 2_000
    };
    const result = buildPromptWithContextCompression({
      promptBuilder: new PromptBuilder(),
      promptInput,
      mode: "auto"
    });

    expect(result.diagnostics.attempted).toBe(true);
    expect(result.diagnostics.fallbackReason).toBe("target_not_met");
    expect(result.prompt.prompt).toContain("Protected system contract.");
    expect(result.prompt.prompt).toContain("现在最喜欢绿色。");
  });

  it("fails open when the compression seam throws", () => {
    const realBuilder = new PromptBuilder();
    const builder = {
      buildPrompt(input: Parameters<PromptBuilder["buildPrompt"]>[0]) {
        if (input.preformattedContext) {
          throw new Error("synthetic compression failure");
        }
        return realBuilder.buildPrompt(input);
      }
    };
    const result = buildPromptWithContextCompression({
      promptBuilder: builder,
      promptInput: createPromptInput(),
      mode: "auto"
    });

    expect(result.diagnostics.fallbackReason).toBe("compression-error");
    expect(result.diagnostics.triggered).toBe(false);
    expect(result.prompt.prompt).toContain("现在最喜欢绿色。");
  });
});
