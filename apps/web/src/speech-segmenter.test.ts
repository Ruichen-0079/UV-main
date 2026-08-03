import { describe, expect, it } from "vitest";
import { SpeechSegmenter } from "./speech-segmenter.js";
import { speechTextFromMarkdown } from "./speech-text.js";

describe("speech text", () => {
  it("removes presentation-only markdown while preserving sentence text", () => {
    expect(speechTextFromMarkdown("## Hello\n\n**world** [docs](https://example.test)!")).toBe(
      "Hello world docs!"
    );
  });

  it("does not speak fenced code or table separators", () => {
    expect(
      speechTextFromMarkdown("| A | B |\n|---|---|\n| one | two |\n```ts\nconst x = 1\n```")
    ).toBe("A B one two");
  });
});

describe("SpeechSegmenter", () => {
  it("emits Chinese, English and Japanese sentences in arrival order", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    expect(segmenter.push("你好。Hello ")).toEqual(["你好。"]);
    expect(segmenter.push("world! こんにちは！")).toEqual(["Hello world!", "こんにちは！"]);
  });

  it("flushes a completed tail but does not force a visibly incomplete cancellation tail", () => {
    const completed = new SpeechSegmenter({ minChars: 4 });
    completed.push("This is a tail");
    expect(completed.flush("completed")).toEqual(["This is a tail"]);

    const cancelled = new SpeechSegmenter({ minChars: 4 });
    cancelled.push("This is an unfinished");
    expect(cancelled.flush("cancelled")).toEqual([]);
  });

  it("keeps Unicode punctuation and mixed text intact", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    expect(segmenter.push("A🙂。B\nC！")).toEqual(["A🙂。", "B C！"]);
  });

  it("does not insert spaces between CJK deltas", () => {
    const segmenter = new SpeechSegmenter({ minChars: 99 });
    segmenter.push("你好");
    segmenter.push("世界");
    expect(segmenter.flush("completed")).toEqual(["你好世界"]);
  });
});
