import { describe, expect, it } from "vitest";
import { PromptBuilder } from "./index.js";

describe("PromptBuilder", () => {
  it("does not exceed configured character budget", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      characterStyle: "Warm and concise.",
      relationshipContext: "Helpful collaborator.",
      retrievedMemories: Array.from({ length: 20 }, (_, index) => ({
        content: `Important memory ${index}: ${"details ".repeat(80)}`,
        importance: index / 20,
        lastAccessedAt: new Date(Date.now() - index * 1000)
      })),
      currentSituation: "Testing prompt budget.",
      tools: [{ name: "memory.search", description: "Retrieve memories" }],
      userMessage: "Hello",
      maxCharacters: 1600
    });

    expect(output.prompt.length).toBeLessThanOrEqual(1600);
    expect(output.prompt).toContain("<RelevantMemory>");
  });
});
