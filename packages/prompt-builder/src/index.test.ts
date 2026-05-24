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

  it("keeps DirectContext separate from RelevantMemory", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      directContext: "- Previous turn: User confirmed Candidate Review v1 is complete.",
      retrievedMemories: [
        {
          content: "用户偏好 Chat/Reasoning 使用 DeepSeek。",
          scope: "project",
          scopeId: "yuvi-runtime",
          memoryLayer: "core",
          status: "active"
        }
      ],
      userMessage: "Continue."
    });

    const directContext = output.sections.find((section) => section.name === "DirectContext");
    const relevantMemory = output.sections.find((section) => section.name === "RelevantMemory");

    expect(directContext?.content).toContain("Candidate Review v1");
    expect(directContext?.content).not.toContain("DeepSeek");
    expect(relevantMemory?.content).toContain("DeepSeek");
    expect(relevantMemory?.content).not.toContain("Candidate Review v1");
    expect(output.prompt.indexOf("<CurrentTime>")).toBeLessThan(
      output.prompt.indexOf("<DirectContext>")
    );
    expect(output.prompt.indexOf("<DirectContext>")).toBeLessThan(
      output.prompt.indexOf("<RelevantMemory>")
    );
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

  it("renders concise scope, layer, status, and temporal hints for retrieved memories", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      retrievedMemories: [
        {
          content: "用户偏好 Chat/Reasoning 使用 DeepSeek。",
          scope: "project",
          scopeId: "yuvi-runtime",
          memoryLayer: "core",
          status: "active",
          validUntil: "2026-12-31T00:00:00.000Z",
          importance: 0.9
        }
      ],
      userMessage: "YUVI provider preference?"
    });

    const relevantMemory = output.sections.find((section) => section.name === "RelevantMemory");
    expect(relevantMemory?.content).toContain(
      "- [project:yuvi-runtime][core][active][validUntil:2026-12-31] 用户偏好 Chat/Reasoning 使用 DeepSeek。"
    );
  });

  it("renders absolute event hints for time-bound episodic memories", () => {
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are Companion.",
      retrievedMemories: [
        {
          content: "用户吃了芒果蛋糕。",
          type: "episodic",
          subtype: "event",
          memoryLayer: "recall",
          status: "active",
          eventTime: "2026-05-23T08:00:00.000Z",
          importance: 0.5
        }
      ],
      userMessage: "我之前吃了什么？"
    });

    const relevantMemory = output.sections.find((section) => section.name === "RelevantMemory");
    expect(relevantMemory?.content).toContain(
      "- [2026-05-23 morning][episodic][recall][active] 用户吃了芒果蛋糕。"
    );
    expect(relevantMemory?.content).not.toContain("今早");
  });
});
