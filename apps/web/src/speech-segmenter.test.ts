import { describe, expect, it } from "vitest";
import { SpeechSegmenter } from "./speech-segmenter.js";
import { sanitizeSpeechText, speechTextFromMarkdown } from "./speech-text.js";

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

  it("strips emoji and decorative symbols while keeping speech text", () => {
    expect(sanitizeSpeechText("こんにちは！😊 今日は☀️いい天気です。")).toBe(
      "こんにちは！ 今日はいい天気です。"
    );
    expect(sanitizeSpeechText("A→B ★C✨ D")).toBe("A→B C D");
    expect(sanitizeSpeechText("「7」はラッキーナンバー！")).toBe("「7」はラッキーナンバー！");
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

  it("keeps Unicode punctuation but strips emoji before synthesis", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    expect(segmenter.push("A🙂。B\nC！")).toEqual(["A。", "B C！"]);
  });

  it("does not insert spaces between CJK deltas", () => {
    const segmenter = new SpeechSegmenter({ minChars: 99 });
    segmenter.push("你好");
    segmenter.push("世界");
    expect(segmenter.flush("completed")).toEqual(["你好世界"]);
  });

  it("consumes accumulated text incrementally without re-emitting", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    const emitted: string[] = [];
    emitted.push(...segmenter.push("こんにちは。今日は"));
    expect(emitted).toEqual(["こんにちは。"]);
    emitted.push(...segmenter.push("いい天気ですね。元気ですか？"));
    expect(emitted).toEqual([
      "こんにちは。",
      "今日はいい天気ですね。",
      "元気ですか？"
    ]);
    expect(segmenter.flush("completed")).toEqual([]);
  });

  it("combines multiple deltas into a single sentence before emitting", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    expect(segmenter.push("今日は")).toEqual([]);
    expect(segmenter.push("いい天気ですね。")).toEqual(["今日はいい天気ですね。"]);
  });

  it("flushes the completed tail exactly once", () => {
    const segmenter = new SpeechSegmenter({ minChars: 99 });
    segmenter.push("これはしっぽのテキストです");
    expect(segmenter.flush("completed")).toEqual(["これはしっぽのテキストです"]);
    expect(segmenter.flush("completed")).toEqual([]);
  });

  it("splits the three fixed Japanese sentences into exactly three segments", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    const emitted: string[] = [];
    for (const delta of ["こんにちは。", "今日はいい天気ですね。", "元気ですか？"]) {
      emitted.push(...segmenter.push(delta));
    }
    emitted.push(...segmenter.flush("completed"));
    expect(emitted).toEqual(["こんにちは。", "今日はいい天気ですね。", "元気ですか？"]);
  });

  it("does not lose the tail when a two-sentence reply arrives character by character", () => {
    const segmenter = new SpeechSegmenter({ minChars: 8 });
    const emitted: string[] = [];
    const reply =
      "こんにちは！😊 なんと9回目の「こんにちは」ですね。しかもさっき自己紹介をお願いしてくれたのに、またこの挨拶に戻ってきました";
    for (const char of reply) {
      emitted.push(...segmenter.push(char));
    }
    emitted.push(...segmenter.flush("completed"));
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toBe("こんにちは ！ なんと 9 回目の 「 こんにちは 」 ですね 。");
    expect(emitted[1]).toContain("しかもさっき自己紹介をお願いしてくれたのに");
  });

  it("emits every sentence for the exact live delta sequence (48 character deltas)", () => {
    const segmenter = new SpeechSegmenter({ minChars: 8 });
    const emitted: string[] = [];
    const deltas = [
      "こ", "ん", "に", "ち", "は", "！", "😊", " ", "なん", "と", "**", "9", "回", "目", "**",
      "の", "「", "こ", "ん", "に", "ち", "は", "」", "ですね", "。", "しか", "も", "さ", "っ", "き",
      "自己", "紹介", "をお", "願", "い", "して", "く", "れた", "のに", "、", "また", "この", "挨",
      "拶", "に", "戻", "って", "きました"
    ];
    for (const delta of deltas) {
      emitted.push(...segmenter.push(delta));
    }
    emitted.push(...segmenter.flush("completed"));
    expect(emitted).toEqual([
      "こんにちは ！ なんと 9 回目の 「 こんにちは 」 ですね 。",
      "しかもさっき自己紹介をお願いしてくれたのに 、 またこの挨拶に戻ってきました"
    ]);
  });
});
