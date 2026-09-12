import { describe, expect, it } from "vitest";
import { SpeechSegmenter, type SpeechPipelineSnapshot } from "./speech-segmenter.js";
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
    expect(emitted).toEqual(["こんにちは。", "今日はいい天気ですね。", "元気ですか？"]);
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
    expect(
      segmenter.push("Hello.\r\n\r\nThis is the second paragraph.\rThis is the final line.")
    ).toEqual(["Hello.", "This is the second paragraph.", "This is the final line."]);
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
      "こ",
      "ん",
      "に",
      "ち",
      "は",
      "！",
      "😊",
      " ",
      "なん",
      "と",
      "**",
      "9",
      "回",
      "目",
      "**",
      "の",
      "「",
      "こ",
      "ん",
      "に",
      "ち",
      "は",
      "」",
      "ですね",
      "。",
      "しか",
      "も",
      "さ",
      "っ",
      "き",
      "自己",
      "紹介",
      "をお",
      "願",
      "い",
      "して",
      "く",
      "れた",
      "のに",
      "、",
      "また",
      "この",
      "挨",
      "拶",
      "に",
      "戻",
      "って",
      "きました"
    ];
    for (const delta of deltas) {
      emitted.push(...segmenter.push(delta));
    }
    emitted.push(...segmenter.flush("completed"));
    expect(emitted).toEqual([
      "こんにちは！",
      "なんと 9 回目のこんにちはですね。",
      "しかもさっき自己紹介をお願いしてくれたのに、 またこの挨拶に戻ってきました"
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
    const segments = segmenter.push("- 一つ目の話です。\n- 二つ目の話です。\n- 三つ目の話です。");
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

  it("splits a long completed tail instead of sending one oversized TTS request", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2, maxChars: 12 });
    const emitted = [
      ...segmenter.push("これは句点を待つ長い尾部で、最後まで自然な終端がありません")
    ];
    emitted.push(...segmenter.flush("completed"));

    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.every((segment) => segment.length <= 12)).toBe(true);
    expect(emitted.every((segment) => isSpeakableSpeechText(segment))).toBe(true);
    expect(emitted.join("")).toContain("これは句点を待つ長い尾部");
  });

  it("applies the same maxChars rules to English completed tails with mixed newlines", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2, maxChars: 40 });
    const body = [
      "I want to tell you a slightly longer story today that will exceed the limit without a period",
      "",
      "When I opened the window, a cool breeze came into the room and lingered there"
    ].join("\r\n");
    const emitted = [...segmenter.push(body), ...segmenter.flush("completed")];
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.every((segment) => segment.length <= 40)).toBe(true);
    expect(emitted.every((segment) => isSpeakableSpeechText(segment))).toBe(true);
    expect(emitted.every((segment) => !/\r|\n/.test(segment))).toBe(true);
    expect(emitted.join(" ")).toContain("cool breeze");
    // Buffer is fully consumed; a second completed flush must be empty.
    expect(segmenter.flush("completed")).toEqual([]);
  });

  it("hard-cuts completed tails without safe boundaries while preserving order", () => {
    const segmenter = new SpeechSegmenter({ minChars: 2, maxChars: 8 });
    // No punctuation, no spaces — force path must still slice by maxChars.
    const tail = "あいうえおかきくけこさしすせそ";
    const emitted = [...segmenter.push(tail), ...segmenter.flush("completed")];
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.every((segment) => segment.length <= 8)).toBe(true);
    expect(emitted.join("")).toBe(prepareSpeechSegment(tail));
    expect(segmenter.flush("completed")).toEqual([]);
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

describe("SpeechSegmenter queue-aware release policy", () => {
  type Feedback = { playing: boolean; synthesizing: boolean; playbackEnded: number };

  function makeSegmenter(feedback: Feedback, options: { minChars?: number; maxChars?: number } = {}) {
    const releases: Array<{ text: string; reason: string }> = [];
    const segmenter = new SpeechSegmenter({
      ...options,
      pipeline: () => ({ ...feedback }),
      onRelease: (text, reason) => releases.push({ text, reason })
    });
    return { segmenter, releases };
  }

  const healthy: Feedback = { playing: true, synthesizing: false, playbackEnded: 0 };
  const synthesizingOnly: Feedback = { playing: false, synthesizing: true, playbackEnded: 0 };

  it("releases the first meaningful strong boundary immediately as FIRST_STRONG", () => {
    const { segmenter, releases } = makeSegmenter({ playing: false, synthesizing: false, playbackEnded: 0 });
    expect(segmenter.push("其实这个方案可以继续做。之后我们")).toEqual(["其实这个方案可以继续做。"]);
    expect(releases[0]).toEqual({ text: "其实这个方案可以继续做。", reason: "FIRST_STRONG" });
  });

  it("does not cut at soft punctuation while audio is playing", () => {
    const { segmenter, releases } = makeSegmenter(healthy);
    expect(segmenter.push("第一句已经说完。这个方向其实可以继续做，但是当前最重要的问题是，")).toEqual([
      "第一句已经说完。"
    ]);
    expect(releases.map((r) => r.reason)).toEqual(["FIRST_STRONG"]);
    // The soft-boundary tail is held until a strong boundary arrives.
    expect(segmenter.push("还没有到句号。")).toEqual([
      "这个方向其实可以继续做，但是当前最重要的问题是， 还没有到句号。"
    ]);
  });

  it("does not cut at soft punctuation while synthesis is producing the next audio", () => {
    const { segmenter } = makeSegmenter(synthesizingOnly);
    expect(segmenter.push("第一句。这个方向其实可以继续做，但是还没有句号")).toEqual(["第一句。"]);
  });

  it("releases at the most recent soft boundary when playback has run dry", () => {
    const starving: Feedback = { playing: false, synthesizing: false, playbackEnded: 1 };
    const { segmenter, releases } = makeSegmenter(starving);
    // released === 0 still uses the first-segment policy even if the queue
    // looks drained: there is nothing to starve yet.
    expect(segmenter.push("开头这一句。这个方向其实可以继续做，但是当前最重要的问题是，")).toEqual([
      "开头这一句。"
    ]);
    expect(releases[0]?.reason).toBe("FIRST_STRONG");
    // Now one segment has been released and its playback already ended: the
    // held soft-boundary text may go out at its most recent comma.
    expect(segmenter.push("后续依然没有句号")).toEqual([
      "这个方向其实可以继续做，但是当前最重要的问题是，"
    ]);
    expect(releases[1]?.reason).toBe("STARVING_SOFT_BOUNDARY");
  });

  it("emits STARVING_SOFT_BOUNDARY once everything released has finished playing", () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 0 };
    const releases: Array<{ text: string; reason: string }> = [];
    const segmenter = new SpeechSegmenter({
      pipeline: () => ({ ...state }),
      onRelease: (text, reason) => {
        releases.push({ text, reason });
        state.playbackEnded = releases.length;
      }
    });
    expect(segmenter.push("第一句话完整了。后面这段话只有逗号，还没有句号")).toEqual([
      "第一句话完整了。"
    ]);
    // Playback of segment 0 ended and nothing is synthesizing: the recent
    // soft boundary becomes an acceptable cut.
    expect(segmenter.push("，到目前为止仍然没有句号出现")).toEqual([
      "后面这段话只有逗号，还没有句号 ，"
    ]);
    expect(releases[1]).toEqual({
      text: "后面这段话只有逗号，还没有句号 ，",
      reason: "STARVING_SOFT_BOUNDARY"
    });
  });

  it("never releases a starving soft cut before any segment was released", () => {
    const { segmenter, releases } = makeSegmenter({
      playing: false,
      synthesizing: false,
      playbackEnded: 5
    });
    expect(segmenter.push("还没有任何一句话被释放，逗号不构成切割点")).toEqual([]);
    expect(releases).toEqual([]);
  });

  it("merges an absurdly tiny CJK first fragment only when the next boundary is already there", () => {
    const { segmenter, releases } = makeSegmenter({ playing: false, synthesizing: false, playbackEnded: 0 });
    expect(segmenter.push("嗯。对。今天我们继续聊正式的话题。")).toEqual([
      "嗯。对。今天我们继续聊正式的话题。"
    ]);
    expect(releases[0]?.reason).toBe("FIRST_MERGED");

    const immediate = makeSegmenter({ playing: false, synthesizing: false, playbackEnded: 0 });
    expect(immediate.segmenter.push("嗯。")).toEqual(["嗯。"]);
    expect(immediate.releases[0]?.reason).toBe("FIRST_STRONG");
  });

  it("does not merge tiny Latin openers (existing per-sentence contract)", () => {
    const { segmenter } = makeSegmenter({ playing: false, synthesizing: false, playbackEnded: 0 });
    expect(segmenter.push("A。B。")).toEqual(["A。", "B。"]);
  });

  it("never cuts a numeric group like 1,000 at a starving soft boundary", () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 0 };
    const releases: Array<{ text: string; reason: string }> = [];
    const segmenter = new SpeechSegmenter({
      pipeline: () => ({ ...state }),
      onRelease: (text, reason) => {
        releases.push({ text, reason });
        state.playbackEnded = releases.length;
      }
    });
    expect(segmenter.push("开头的句子。")).toEqual(["开头的句子。"]);
    expect(segmenter.push("数量恰好是1,000件但是没有别的标点")).toEqual([]);
    expect(segmenter.flush("completed").length).toBe(1);
    const emitted = releases.map((r) => r.text).join("");
    expect(emitted).toContain("1,000");
  });

  it("keeps URLs intact when starving cuts at the comma after them", () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 0 };
    const releases: Array<{ text: string; reason: string }> = [];
    const segmenter = new SpeechSegmenter({
      pipeline: () => ({ ...state }),
      onRelease: (text, reason) => {
        releases.push({ text, reason });
        state.playbackEnded = releases.length;
      }
    });
    expect(segmenter.push("第一句结束。详情见 https://example.com/path, 后续说明仍然没有句号")).toEqual([
      "第一句结束。"
    ]);
    expect(segmenter.push("继续补充一点内容，依然只有软标点")).toEqual([
      "详情见 https://example.com/path, 后续说明仍然没有句号继续补充一点内容，"
    ]);
    expect(releases[1]?.reason).toBe("STARVING_SOFT_BOUNDARY");
    expect(releases[1]?.text).toContain("https://example.com/path,");
  });

  it("keeps abbreviation guards while starving", () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 0 };
    const releases: Array<{ text: string; reason: string }> = [];
    const segmenter = new SpeechSegmenter({
      pipeline: () => ({ ...state }),
      onRelease: (text, reason) => {
        releases.push({ text, reason });
        state.playbackEnded = releases.length;
      }
    });
    expect(segmenter.push("第一句。Dr. Smith arrived, then the rest keeps going without a stop")).toEqual([
      "第一句。"
    ]);
    const segment = segmenter.push("with more soft text, still no period")[0] ?? "";
    expect(releases.some((r) => r.reason === "STARVING_SOFT_BOUNDARY")).toBe(true);
    expect(segment.startsWith("Dr. Smith arrived,")).toBe(true);
  });

  it("keeps the emergency bound as the last resort regardless of queue state", () => {
    const { segmenter, releases } = makeSegmenter(healthy, { minChars: 4, maxChars: 12 });
    const emitted = segmenter.push("这是一段完全没有任何标点的很长文本因此只能被紧急切割成小块");
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted.every((segment) => segment.length <= 13)).toBe(true);
    expect(releases.map((r) => r.reason)).toEqual(["EMERGENCY_BOUND", "EMERGENCY_BOUND"]);
  });

  it("never splits surrogate pairs at the emergency hard cut", () => {
    const segmenter = new SpeechSegmenter({ minChars: 4, maxChars: 9 });
    const text = "𠀀".repeat(12);
    const emitted = [...segmenter.push(text), ...segmenter.flush("completed")];
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(emitted.length).toBeGreaterThan(1);
    for (const segment of emitted) {
      expect(loneSurrogate.test(segment)).toBe(false);
    }
    expect(emitted.join("")).toBe(text);
  });

  it("drops the unfinished tail on cancellation even in starving mode", () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 0 };
    const releases: Array<{ text: string; reason: string }> = [];
    const segmenter = new SpeechSegmenter({
      pipeline: () => ({ ...state }),
      onRelease: (text, reason) => {
        releases.push({ text, reason });
        state.playbackEnded = releases.length;
      }
    });
    expect(segmenter.push("完整的第一句。")).toEqual(["完整的第一句。"]);
    // Starving but the tail has no soft boundary either: it can only be held.
    expect(segmenter.push("被取消的残尾没有任何标点")).toEqual([]);
    expect(segmenter.flush("cancelled")).toEqual([]);
    expect(segmenter.flush("completed")).toEqual([]);
    expect(releases).toHaveLength(1);
  });

  it("flushes the final tail exactly once with FINAL_FLUSH", () => {
    const { segmenter, releases } = makeSegmenter({ playing: false, synthesizing: false, playbackEnded: 0 });
    segmenter.push("这是没有句号的尾巴");
    expect(segmenter.flush("completed")).toEqual(["这是没有句号的尾巴"]);
    expect(releases[0]?.reason).toBe("FINAL_FLUSH");
    expect(segmenter.flush("completed")).toEqual([]);
    expect(releases).toHaveLength(1);
  });

  it("conserves text across strong, starving and emergency paths", () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 0 };
    const releases: Array<{ text: string; reason: string }> = [];
    const segmenter = new SpeechSegmenter({
      minChars: 4,
      maxChars: 20,
      pipeline: () => ({ ...state }),
      onRelease: (text, reason) => {
        releases.push({ text, reason });
        state.playbackEnded = releases.length;
      }
    });
    const source =
      "月亮升起来了。夜色温柔，风也轻，气压很低——正是散步的好时候，Such a quiet night, indeed. 一切都刚刚好。";
    const emitted = [...segmenter.push(source), ...segmenter.flush("completed")];
    expect(emitted.length).toBeGreaterThan(1);
    const strip = (value: string) => value.replace(/\s+/g, "");
    expect(strip(emitted.join(""))).toBe(strip(sanitizeSpeechText(speechTextFromMarkdown(source))));
    expect(emitted.every((segment) => isSpeakableSpeechText(segment))).toBe(true);
  });

});

describe("SpeechSegmenter punctuation conservation", () => {
  it("conserves an em-dash pair delivered as its own delta (live regression)", () => {
    const segmenter = new SpeechSegmenter({ minChars: 4 });
    const emitted = [
      ...segmenter.push("他用拇指摩挲一枚磨得发亮的银币"),
      ...segmenter.push("——"),
      ...segmenter.push("那是他年轻时月亮留给他的工钱。"),
      ...segmenter.flush("completed")
    ];
    const strip = (value: string) => value.replace(/\s+/g, "");
    expect(strip(emitted.join(""))).toBe(
      strip("他用拇指摩挲一枚磨得发亮的银币——那是他年轻时月亮留给他的工钱。")
    );
    expect(emitted.some((segment) => segment.includes("——"))).toBe(true);
  });

  it("conserves soft punctuation at a starving cut (trailing 、 is never lost)", () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 0 };
    const releases: string[] = [];
    const segmenter = new SpeechSegmenter({
      pipeline: () => ({ ...state }),
      onRelease: (text) => {
        releases.push(text);
        state.playbackEnded = releases.length;
      }
    });
    expect(segmenter.push("第一句完整。列举几种水果，苹果、橘子和梨，都没有句号")).toEqual([
      "第一句完整。"
    ]);
    // The starving cut lands on the most recent comma; the rest stays pending
    // and is finally flushed — nothing is lost, including the 、 inside.
    expect(segmenter.push("，继续列举更多种类的水果名称")).toEqual([
      "列举几种水果，苹果、橘子和梨，都没有句号 ，"
    ]);
    segmenter.flush("completed");
    const strip = (value: string) => value.replace(/\s+/g, "");
    expect(strip(releases.join(""))).toBe(
      strip("第一句完整。列举几种水果，苹果、橘子和梨，都没有句号，继续列举更多种类的水果名称")
    );
    expect(releases.join("")).toContain("苹果、橘子和梨");
  });
});

describe("SpeechSegmenter standalone punctuation conservation (A9-RV1)", () => {
  const starvingAfterEachRelease = () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 0 };
    return () => ({ ...state });
  };
  const makeCounting = () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 0 };
    const segmenter = new SpeechSegmenter({ pipeline: () => ({ ...state }) });
    const push = (text: string) => {
      const got = segmenter.push(text);
      state.playbackEnded += got.length;
      return got;
    };
    return { segmenter, push };
  };

  it("conserves the second half of a —— pair after a starving cut at the first dash", () => {
    const { push } = makeCounting();
    const emitted: string[] = [];
    emitted.push(...push("闪电亮起的那一瞬，屋子里的影子"));
    emitted.push(...push("全都跳了起来—"));
    // The starving cut releases the pending text ending with the first dash;
    // the second dash then arrives with empty pending and must survive.
    emitted.push(...push("—"));
    emitted.push(...push("紧接着黑暗又压下来。"));
    const strip = (value: string) => value.replace(/\s+/g, "");
    const source = strip("闪电亮起的那一瞬，屋子里的影子全都跳了起来——紧接着黑暗又压下来。");
    expect(strip(emitted.join(""))).toBe(source);
  });

  it("conserves a standalone comma delta arriving right after a release", () => {
    const { push } = makeCounting();
    const emitted: string[] = [];
    emitted.push(...push("第一句话完整。"));
    emitted.push(...push("，"));
    emitted.push(...push("后续还有内容没有句号"));
    emitted.push(...push("。"));
    const strip = (value: string) => value.replace(/\s+/g, "");
    expect(strip(emitted.join(""))).toBe(strip("第一句话完整。，后续还有内容没有句号。"));
  });

  it("never emits empty punctuation-only turns as speech", () => {
    const { segmenter } = makeCounting();
    expect(segmenter.push("—")).toEqual([]);
    expect(segmenter.flush("cancelled")).toEqual([]);
  });
});

describe("SpeechSegmenter delta-chunking equivalence", () => {
  const source = "早晨的市场很热闹。摊主们摆出新鲜的蔬菜，鱼贩大声吆喝着，孩子们追逐嬉戏。一切都充满生气。";

  function runWith(
    deltas: string[],
    feedback: () => SpeechPipelineSnapshot
  ): { segments: string[]; reasons: string[] } {
    const releases: Array<{ text: string; reason: string }> = [];
    const segmenter = new SpeechSegmenter({
      minChars: 4,
      pipeline: feedback,
      onRelease: (text, reason) => releases.push({ text, reason })
    });
    for (const delta of deltas) segmenter.push(delta);
    segmenter.flush("completed");
    return { segments: releases.map((r) => r.text), reasons: releases.map((r) => r.reason) };
  }

  it("healthy queue state: coarse, sentence and character delta chunking agree exactly", () => {
    // While the pipeline is healthy the segmenter only ever cuts at strong
    // boundaries, so delta chunking must not change the output. (Whitespace
    // around punctuation that arrives in its own delta is existing speech
    // normalization, not segmentation.)
    const healthy = () => ({ playing: true, synthesizing: false, playbackEnded: 0 });
    const coarse = runWith([source], healthy);
    const perSentence = runWith(source.match(/[^。]*。/g) ?? [source], healthy);
    const fine = runWith(Array.from(source), healthy);
    const stripAll = (segments: string[]) => segments.map((segment) => segment.replace(/\s+/g, ""));

    expect(stripAll(coarse.segments)).toEqual(stripAll(perSentence.segments));
    expect(stripAll(coarse.segments)).toEqual(stripAll(fine.segments));
    expect(coarse.reasons).toEqual(perSentence.reasons);
    expect(coarse.reasons).toEqual(fine.reasons);
    const strip = (value: string) => value.replace(/\s+/g, "");
    expect(strip(coarse.segments.join(""))).toBe(strip(source));
  });

  it("starving queue state: chunkings agree on conservation and strong consensus", () => {
    // Realtime starvation depends on when text physically arrives — a comma
    // that has not arrived yet cannot be released, and once released text
    // cannot be merged back. Pin the invariants that must hold regardless:
    // conservation, speakability, and the strong-boundary skeleton.
    const makeFeedback = () => {
      const state = { playing: false, synthesizing: false, playbackEnded: 0 };
      return () => ({ ...state });
    };
    const trackEnds = (deltas: string[]) => {
      const state = { playing: false, synthesizing: false, playbackEnded: 0 };
      const releases: Array<{ text: string; reason: string }> = [];
      const segmenter = new SpeechSegmenter({
        minChars: 4,
        pipeline: () => ({ ...state }),
        onRelease: (text, reason) => {
          releases.push({ text, reason });
          state.playbackEnded = releases.length;
        }
      });
      for (const delta of deltas) segmenter.push(delta);
      segmenter.flush("completed");
      return { segments: releases.map((r) => r.text), reasons: releases.map((r) => r.reason) };
    };
    const strip = (value: string) => value.replace(/\s+/g, "");
    const coarse = trackEnds([source]);
    const fine = trackEnds(Array.from(source));
    for (const run of [coarse, fine]) {
      expect(strip(run.segments.join(""))).toBe(strip(source));
      expect(run.segments.every((segment) => segment.length > 0)).toBe(true);
      // Every third sentence boundary must appear as a released segment end.
      expect(run.segments.join("")).toContain("一切都充满生气。");
      expect(run.reasons).toContain("FIRST_STRONG");
    }
  });
});


describe("post-GLM conservation audit", () => {
  it.each(["。", "……", "！？", "— —", "，"])("retains standalone %s before the next spoken body", (punctuation) => {
    const segmenter = new SpeechSegmenter();
    const emitted = segmenter.push("第一句话完整。");
    for (const delta of Array.from(punctuation)) emitted.push(...segmenter.push(delta));
    emitted.push(...segmenter.push("后面的内容也要保留。"), ...segmenter.flush("completed"));
    expect(emitted.join("").replace(/\s/g, "")).toBe(("第一句话完整。" + punctuation + "后面的内容也要保留。").replace(/\s/g, ""));
  });

  it("does not release another starving fragment when this delta already supplied work", () => {
    const state = { playing: false, synthesizing: false, playbackEnded: 1 };
    const segmenter = new SpeechSegmenter({ pipeline: () => state });
    segmenter.push("第一句话完整。");
    expect(segmenter.push("第二句话完整。后面这段还没说完，继续")).toEqual(["第二句话完整。"]);
  });
});


it("sanitizes emoji even when the provider splits its surrogate pair beside speech", () => {
  const segmenter = new SpeechSegmenter();
  const emitted = [
    ...segmenter.push("甲\ud83d"),
    ...segmenter.push("\ude42乙。"),
    ...segmenter.flush("completed")
  ];
  expect(emitted.join("").replace(/\s/g, "")).toBe("甲乙。");
});


it.each([
  ["数值是3.", "14以及1,", "000。"],
  ["请看https://example.", "com/path?a=1&b=2。"],
  ["例如e.", "g. U.", "S. Dr.", " Smith。"],
  ["中文与Latin，", "混合punctuation！？", "继续。"],
  ["前面的内容—", "—", "后面的内容。"]
])("conserves non-whitespace speech characters across numeric and mixed boundaries: %j", (...deltas) => {
  const segmenter = new SpeechSegmenter();
  const emitted = deltas.flatMap(delta => segmenter.push(delta));
  emitted.push(...segmenter.flush("completed"));
  const compact = (text: string) => prepareSpeechSegment(text).replace(/\s/g, "");
  expect(compact(emitted.join(""))).toBe(compact(deltas.join("")));
  expect(segmenter.flush("completed")).toEqual([]);
});

it("drops cancelled text and a held surrogate before the next turn", () => {
  const segmenter = new SpeechSegmenter();
  segmenter.push("被取消的内容\ud83d");
  expect(segmenter.flush("cancelled")).toEqual([]);
  expect(segmenter.flush("completed")).toEqual([]);
  segmenter.reset();
  expect(segmenter.push("新的回复完整。")).toEqual(["新的回复完整。"]);
});
