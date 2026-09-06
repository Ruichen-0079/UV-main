import { describe, expect, it } from "vitest";
import {
  paginateSubtitleText,
  projectCommittedAssistantText,
  subtitlePageDurationMs
} from "./subtitle-projection.js";

describe("subtitle projection", () => {
  it("projects committed plain text and ignores empty/whitespace", () => {
    expect(projectCommittedAssistantText("Hello world.")).toBe("Hello world.");
    expect(projectCommittedAssistantText("   \n\t  ")).toBeNull();
    expect(projectCommittedAssistantText("```\ncode\n```")).toBeNull();
  });

  it("strips code fences and tables without inventing language", () => {
    const markdown = [
      "你好，YUVI。",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Mixed EN follow-up."
    ].join("\n");
    const projected = projectCommittedAssistantText(markdown);
    expect(projected).toContain("你好，YUVI。");
    expect(projected).toContain("Mixed EN follow-up.");
    expect(projected).not.toContain("const x");
    expect(projected).not.toContain("| a |");
  });

  it("paginates long text while reconstructing the original projection", () => {
    const text =
      "这是第一句。这是第二句，继续说明。This is a longer English clause that should wrap across pages without mutating the source.";
    const pages = paginateSubtitleText(text, 40);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join("")).toBe(text);
    expect(pages.every((page) => page.length > 0)).toBe(true);
  });

  it("keeps short zh/en/mixed text as a single page", () => {
    expect(paginateSubtitleText("你好 YUVI")).toEqual(["你好 YUVI"]);
    expect(paginateSubtitleText("Hello.")).toEqual(["Hello."]);
  });

  it("uses bounded length heuristics for page timing", () => {
    expect(subtitlePageDurationMs("Hi")).toBe(1800);
    expect(subtitlePageDurationMs("a".repeat(500))).toBe(8000);
    const mid = subtitlePageDurationMs("a".repeat(40));
    expect(mid).toBeGreaterThan(1800);
    expect(mid).toBeLessThan(8000);
  });
});
