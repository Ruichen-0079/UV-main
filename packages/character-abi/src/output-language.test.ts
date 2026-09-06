import { describe, expect, it } from "vitest";
import {
  CHARACTER_OUTPUT_LANGUAGES,
  characterOutputLanguageInstruction,
  normalizeCharacterOutputLanguage,
  resolveCharacterExpressionLanguage
} from "./output-language.js";

describe("Character output-language semantic preference", () => {
  it("keeps the supported setting vocabulary intentionally small", () => {
    expect(CHARACTER_OUTPUT_LANGUAGES).toEqual(["AUTO", "EN", "ZH", "JA"]);
  });

  it.each([
    [undefined, "AUTO"],
    ["", "AUTO"],
    ["en", "EN"],
    [" zh ", "ZH"],
    ["JA", "JA"],
    ["fr", "AUTO"]
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeCharacterOutputLanguage(input)).toBe(expected);
  });

  it("makes AUTO contextual without creating a durable language instruction", () => {
    const instruction = characterOutputLanguageInstruction("AUTO");

    expect(instruction).toContain("follow the current interaction context naturally");
    expect(instruction).toContain("do not infer a durable preference");
    expect(instruction).toContain("write a language preference to Memory");
    expect(instruction).not.toContain("must be in English");
  });

  it.each([
    ["EN", "English"],
    ["ZH", "Chinese"],
    ["JA", "Japanese"]
  ] as const)("makes explicit %s authoritative for final Character text", (language, name) => {
    const instruction = characterOutputLanguageInstruction(language);

    expect(instruction).toContain(`Output-language preference: ${language}`);
    expect(instruction).toContain(`must be in ${name}`);
    expect(instruction).toContain("Cognition may reason internally in another language");
    expect(instruction).toContain("does not control");
  });

  it.each([
    ["AUTO", "An English answer.", "EN"],
    ["AUTO", "中文回答。", "ZH"],
    ["AUTO", "これは日本語です。", "JA"],
    ["EN", "中文回答。", "EN"],
    ["ZH", "An English answer.", "ZH"],
    ["JA", "An English answer.", "JA"]
  ] as const)(
    "resolves %s and final text to the TTS language hint",
    (preference, text, expected) => {
      expect(resolveCharacterExpressionLanguage(preference, text)).toBe(expected);
    }
  );
});
