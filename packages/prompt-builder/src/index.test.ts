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

  it("includes current time context for temporal reasoning", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      retrievedMemories: [],
      currentTime: {
        isoTimestamp: "2026-05-22T10:00:00.000Z",
        timezone: "Asia/Shanghai",
        localDate: "2026-05-22"
      },
      userMessage: "What is current?"
    });

    expect(output.prompt).toContain("<CurrentTime>");
    expect(output.prompt).toContain("2026-05-22T10:00:00.000Z");
    expect(output.sections.some((section) => section.name === "CurrentTime")).toBe(true);
  });

  it("renders memory text that already has list markers as single bullets", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      retrievedMemories: [
        "- 用户正在开发 YUVI Runtime。",
        "* 用户偏好 DeepSeek。",
        "- - 用户使用 WSL2。",
        "1. 用户需要 Dashboard。",
        "> 用户正在调试记忆。"
      ],
      userMessage: "YUVI Runtime 是什么项目？"
    });

    const relevantMemory = output.sections.find((section) => section.name === "RelevantMemory");
    expect(relevantMemory?.content).toContain("- 用户正在开发 YUVI Runtime。");
    expect(relevantMemory?.content).toContain("- 用户偏好 DeepSeek。");
    expect(relevantMemory?.content).toContain("- 用户使用 WSL2。");
    expect(relevantMemory?.content).toContain("- 用户需要 Dashboard。");
    expect(relevantMemory?.content).toContain("- 用户正在调试记忆。");
    expect(relevantMemory?.content).not.toContain("- - 用户");
    expect(output.prompt).not.toContain("- - 用户");
  });
});
