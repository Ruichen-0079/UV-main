import { describe, expect, it } from "vitest";
import { SpeechSegmenter } from "./speech-segmenter.js";
import {
  isSpeakableSpeechText,
  prepareSpeechSegment,
  sanitizeSpeechText,
  speechTextFromMarkdown
} from "./speech-text.js";

describe("speech text", () => {
  it("removes presentation-only markdown while preserving sentence text", () => {
    expect(speechTextFromMarkdown("## Hello\n\n**world** [docs](https://example.test)!")).toBe(
      "Hello\n\nworld docs!"
    );
  });

  it("does not speak fenced code or table separators", () => {
    expect(
      speechTextFromMarkdown("| A | B |\n|---|---|\n| one | two |\n```ts\nconst x = 1\n```")
    ).toBe("A B\none two");
  });

  it("strips emoji and decorative symbols while keeping speech text", () => {
    expect(sanitizeSpeechText("こんにちは！😊 今日は☀️いい天気です。")).toBe(
      "こんにちは！ 今日はいい天気です。"
    );
    expect(sanitizeSpeechText("A→B ★C✨ D")).toBe("A→B C D");
    expect(sanitizeSpeechText("「7」はラッキーナンバー！")).toBe("「7」はラッキーナンバー！");
  });

  it("normalizes wave dash and other Alice-unsafe ornaments without swallowing neighbors", () => {
    expect(sanitizeSpeechText("こんにちは〜今日はいい天気ですね。")).toBe(
      "こんにちは 今日はいい天気ですね。"
    );
    expect(sanitizeSpeechText("Hello〜 ✨")).toContain("Hello");
    expect(prepareSpeechSegment("一行目\n二行目〜")).toBe("一行目 二行目");
    expect(prepareSpeechSegment("Hello〜\nToday is fine")).toBe("Hello Today is fine");
    expect(prepareSpeechSegment("Hello.")).toBe("Hello.");
  });

  it("normalizes curly quotes and preserves English contractions", () => {
    expect(sanitizeSpeechText("I’m fine — that’s OK.")).toBe("I'm fine — that's OK.");
    expect(prepareSpeechSegment("I don't think that's a problem.")).toBe(
      "I don't think that's a problem."
    );
  });

  it("emits final segments as single lines", () => {
    expect(prepareSpeechSegment("Hello.\n\nWorld.")).toBe("Hello. World.");
    expect(/\n/.test(prepareSpeechSegment("A\r\nB\rC"))).toBe(false);
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
    expect(segmenter.push("A🙂。B\nC！")).toEqual(["A。", "B", "C！"]);
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

  it("does not lose the English opener Hello. as sequence 0", () => {
    const segmenter = new SpeechSegmenter();
    const emitted: string[] = [];
    for (const delta of [
      "Hello.",
      "\nI want to tell you a slightly longer story today.",
      "\nWhen I opened the window, a cool breeze came into the room."
    ]) {
      emitted.push(...segmenter.push(delta));
    }
    emitted.push(...segmenter.flush("completed"));
    expect(emitted[0]).toBe("Hello.");
    expect(emitted).toHaveLength(3);
    expect(emitted.every((segment) => !/\n/.test(segment))).toBe(true);
  });

  it("splits simple multi-line English into three natural segments", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    const emitted = segmenter.push(
      "Hello.\nThe weather is lovely today.\nWhat would you like to do?"
    );
    expect(emitted).toEqual([
      "Hello.",
      "The weather is lovely today.",
      "What would you like to do?"
    ]);
  });

  it("segments multi-paragraph English without dumping the whole block", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    const text = [
      "I want to tell you a slightly longer story.",
      "",
      "When I woke up this morning, I opened the window and felt a cool breeze.",
      "Then I made breakfast and spent some time reading.",
      "",
      "I may go outside later this afternoon."
    ].join("\n");
    const emitted = [...segmenter.push(text), ...segmenter.flush("completed")];
    expect(emitted.length).toBeGreaterThanOrEqual(3);
    expect(emitted.every((segment) => isSpeakableSpeechText(segment))).toBe(true);
    expect(emitted.every((segment) => !/\n/.test(segment))).toBe(true);
    expect(emitted.join(" ")).toContain("cool breeze");
    expect(emitted.join(" ")).toContain("this afternoon");
  });

  it("strips markdown list markers while keeping English bodies", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    const segments = segmenter.push(
      "- First, we can check the current task.\n- Second, we can review the recent changes.\n- Third, we can decide what to work on next."
    );
    expect(segments).toEqual([
      "First, we can check the current task.",
      "Second, we can review the recent changes.",
      "Third, we can decide what to work on next."
    ]);
  });

  it("handles unsafe ornaments and emoji without deleting English neighbors", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    const emitted = [
      ...segmenter.push("Hello〜 ✨\nThis line contains an emoji  and a decorative symbol ～.\n"),
      ...segmenter.push("The surrounding English text must not be removed.")
    ];
    emitted.push(...segmenter.flush("completed"));
    expect(emitted.some((segment) => segment.includes("Hello"))).toBe(true);
    expect(emitted.some((segment) => segment.includes("surrounding English text"))).toBe(true);
    expect(emitted.every((segment) => !/[〜～✨]/.test(segment))).toBe(true);
  });

  it("normalizes CRLF, CR, and blank lines into single-line segments", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    expect(segmenter.push("Hello.\r\n\r\nThis is the second paragraph.\rThis is the final line.")).toEqual([
      "Hello.",
      "This is the second paragraph.",
      "This is the final line."
    ]);
  });

  it("keeps contractions and avoids splitting common abbreviations and versions", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    const emitted = [
      ...segmenter.push("Hello, I'm Alice.\n"),
      ...segmenter.push("I don't think that's a problem.\n"),
      ...segmenter.push("Dr. Smith said it was fine.\n"),
      ...segmenter.push("The version is 2.5, not 2.0.")
    ];
    emitted.push(...segmenter.flush("completed"));
    expect(emitted).toEqual([
      "Hello, I'm Alice.",
      "I don't think that's a problem.",
      "Dr. Smith said it was fine.",
      "The version is 2.5, not 2.0."
    ]);
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
    expect(emitted).toHaveLength(3);
    expect(emitted[0]).toBe("こんにちは！");
    expect(emitted[1]).toContain("なんと 9 回目のこんにちはですね。");
    expect(emitted[2]).toContain("しかもさっき自己紹介をお願いしてくれたのに");
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
      "こんにちは！",
      "なんと 9 回目のこんにちはですね。",
      "しかもさっき自己紹介をお願いしてくれたのに 、 またこの挨拶に戻ってきました"
    ]);
  });

  it("normalizes CRLF/CR, preserves blank-line boundaries, and drops empty tails", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    expect(segmenter.push("こんにちは。\r\n\r\n今日はいい天気ですね。\r")).toEqual([
      "こんにちは。",
      "今日はいい天気ですね。"
    ]);
    expect(segmenter.flush("completed")).toEqual([]);
    expect(segmenter.push("   \n-   \n!!!")).toEqual([]);
    expect(segmenter.flush("completed")).toEqual([]);
  });

  it("splits markdown lists into bounded, speakable segments", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    const segments = segmenter.push(
      "- 一つ目の話です。\n- 二つ目の話です。\n- 三つ目の話です。"
    );
    expect(segments).toEqual(["一つ目の話です。", "二つ目の話です。", "三つ目の話です。"]);
    expect(segmenter.flush("completed")).toEqual([]);
  });

  it("splits a long sentence at the nearest safe boundary", () => {
    const segmenter = new SpeechSegmenter({ minChars: 4, maxChars: 12 });
    const segments = segmenter.push("これはとても長い文章で、ここで安全に分割できます。");
    expect(segments.every((segment) => segment.length <= 13)).toBe(true);
    expect(segments.join("")).toContain("これはとても長い文章で");
    expect(segmenter.flush("completed").length).toBeLessThanOrEqual(1);
  });

  it("emits multi-line Japanese deltas as ordered speakable segments without ornaments", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2 });
    const emitted: string[] = [];
    const deltas = [
      "こんにちは。\n",
      "今日はいい天気ですね。\n",
      "何をして過ごしますか？\n\n",
      "- 一つ目の話です。\n",
      "- 二つ目〜の話です。"
    ];
    for (const delta of deltas) {
      emitted.push(...segmenter.push(delta));
    }
    emitted.push(...segmenter.flush("completed"));
    expect(emitted).toEqual([
      "こんにちは。",
      "今日はいい天気ですね。",
      "何をして過ごしますか？",
      "一つ目の話です。",
      "二つ目 の話です。"
    ]);
    expect(emitted.every((segment) => !/[〜～\n]/.test(segment))).toBe(true);
  });

  it("drops pure decoration segments after sanitize", () => {
    const segmenter = new SpeechSegmenter({ minChars: 1 });
    expect(segmenter.push("😊\n〜\n★")).toEqual([]);
    expect(segmenter.flush("completed")).toEqual([]);
  });
});
