import { describe, expect, it } from "vitest";
import { SpeechSegmenter } from "./speech-segmenter.js";
import { prepareSpeechSegment, speechTextFromMarkdown } from "./speech-text.js";

const responses = [
  "好的，我知道了。",
  "今天先整理桌面。然后去公园散步。路边有漂亮的小花。回来以后准备晚饭。最后一句是测试结束。",
  "请听：天气很好，我们出发吧！你准备好了吗？先穿鞋；再拿伞——最后出门。！？；：——",
  "Hello world. We will walk to the park today. Then we will return home. The final word is complete.",
  "I'm here and you're welcome. Please don't leave the final word behind.",
  "The value is 3.14 and 1,000. Dr. Smith arrived at 2.5.",
  "第一段话已经说完。" + "接下来详细解释这件事情，确保全部文字都被保留，并且按照正确顺序播放。".repeat(14),
  "第一句话已经完成。这里是没有强标点的最后尾巴",
  "嗯。接下来这段话比较长，需要确认短音频之后的完整句子仍然保留。最后一个词是完成。",
  "**Hello world.**\n- Go [home](https://home.example/path).\n```js\nnotSpeech();\n```\n最后尾巴",
  "甲。、、乙。🙂𠀀最后：尾巴",
  "今日はいい天気です。Then we mix 中文 and English. 最後は日本語。",
  "句子主体已经写完",
  "句子主体已经写完。！"
];

function normalizedSpeech(source: string): string {
  return prepareSpeechSegment(speechTextFromMarkdown(source));
}

/** Prepared speakable content is conserved; boundary whitespace may be normalized. */
function expectConserved(source: string, emitted: string[], label: string): void {
  const normalized = normalizedSpeech(source);
  let cursor = 0;
  for (const segment of emitted) {
    expect(segment, label).toBe(prepareSpeechSegment(segment));
    const index = normalized.indexOf(segment, cursor);
    expect(index, `${label} missing ${JSON.stringify(segment)} in ${JSON.stringify(normalized.slice(cursor))}`).toBeGreaterThanOrEqual(0);
    const skipped = normalized.slice(cursor, index);
    expect(skipped.replace(/\s/g, ""), `${label} dropped source ${JSON.stringify(skipped)}`).toBe("");
    cursor = index + segment.length;
  }
  expect(normalized.slice(cursor).replace(/\s/g, ""), `${label} leftover ${JSON.stringify(normalized.slice(cursor))}`).toBe("");
}

function splitBySeed(source: string, seed: number): string[] {
  if (seed === 0) return Array.from(source);
  const deltas: string[] = [];
  let random = seed + 1;
  for (let start = 0; start < source.length; ) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const length = 1 + (random % 17);
    deltas.push(source.slice(start, start + length));
    start += length;
  }
  return deltas;
}

describe("complete speech stream conservation", () => {
  it.each(responses)("conserves the complete response at arbitrary delta boundaries: %s", (source) => {
    for (let seed = 0; seed < 100; seed += 1) {
      const state = { playing: false, synthesizing: false, playbackEnded: 0 };
      const observed: string[] = [];
      const segmenter = new SpeechSegmenter({
        pipeline: () => state,
        onRelease: (text) => {
          observed.push(text);
          state.playbackEnded = observed.length;
        }
      });
      const emitted: string[] = [];
      state.playing = seed % 3 === 0;
      state.synthesizing = seed % 3 === 1;
      for (const delta of splitBySeed(source, seed)) {
        emitted.push(...segmenter.push(delta));
      }
      emitted.push(...segmenter.flush("completed"));
      const label = `seed ${seed}`;
      expect(emitted, label).toEqual(observed);
      expectConserved(source, emitted, label);
      expect(segmenter.flush("completed")).toEqual([]);
      expect(segmenter.push("late stale delta")).toEqual([]);
    }
  });

  it("keeps word spaces and split contractions exactly, including whitespace-only deltas", () => {
    const source = "I'm here and you're welcome. Please don't leave the final word behind";
    const segmenter = new SpeechSegmenter();
    const emitted = [...source].flatMap((delta) => segmenter.push(delta));
    emitted.push(...segmenter.flush("completed"));
    expectConserved(source, emitted, "contractions");
    expect(emitted.join("")).toContain("I'm");
    expect(emitted.join("")).toContain("you're");
    expect(emitted.join("")).not.toMatch(/I ' m|H e l l o/);
  });

  it("holds a terminal punctuation run until lookahead or final flush, without a timer", () => {
    const segmenter = new SpeechSegmenter();
    for (const delta of ["好了", "。", "！", "？", "；", "：", "—", "—"]) {
      expect(segmenter.push(delta)).toEqual([]);
    }
    expect(segmenter.flush("completed")).toEqual(["好了。！？；：——"]);
    expect(segmenter.flush("completed")).toEqual([]);
  });

  it("conserves punctuation-only deltas and trailing punctuation arriving after the body", () => {
    const source = "请听：第一句，第二句。！？；：——";
    const deltas = ["请听", "：", "第一句", "，", "第二句", "。", "！", "？", "；", "：", "—", "—"];
    const segmenter = new SpeechSegmenter();
    const emitted = deltas.flatMap((delta) => segmenter.push(delta));
    emitted.push(...segmenter.flush("completed"));
    expectConserved(source, emitted, "punctuation-only");
  });

  it("cancellation discards pending speech and cannot be revived by completion", () => {
    const segmenter = new SpeechSegmenter();
    expect(segmenter.push("第一句。还有尾巴")).toEqual(["第一句。"]);
    expect(segmenter.flush("cancelled")).toEqual([]);
    expect(segmenter.flush("completed")).toEqual([]);
    segmenter.reset();
    expect(segmenter.push("下一轮。")).toEqual([]);
    expect(segmenter.flush("completed")).toEqual(["下一轮。"]);
  });
});
