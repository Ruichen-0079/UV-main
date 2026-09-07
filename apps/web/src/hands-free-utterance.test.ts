import { describe, expect, it } from "vitest";
import { HANDS_FREE_SAMPLE_RATE, createHandsFreeUtteranceBuffer } from "./hands-free-utterance.js";

function pcm(ms: number, value = 1000): Int16Array {
  const samples = Math.round((ms / 1000) * HANDS_FREE_SAMPLE_RATE);
  return Int16Array.from({ length: samples }, () => value);
}

describe("hands-free utterance buffer", () => {
  it("finalizes one utterance after speech then trailing silence", () => {
    const buffer = createHandsFreeUtteranceBuffer("epoch-1");
    expect(buffer.state).toBe("listening");
    buffer.push(pcm(200));
    expect(buffer.observeVad(true)).toBeNull();
    expect(buffer.state).toBe("speech-active");
    buffer.push(pcm(400));
    expect(buffer.observeVad(false)).toBeNull();
    const utterance = buffer.push(pcm(3000));
    expect(utterance?.captureEpoch).toBe("epoch-1");
    expect(utterance?.durationMs).toBeGreaterThan(250);
    expect(buffer.state).toBe("listening");
  });

  it("ignores callbacks after disposal", () => {
    const buffer = createHandsFreeUtteranceBuffer("epoch-gone");
    buffer.observeVad(true);
    buffer.push(pcm(400));
    buffer.dispose();
    expect(buffer.state).toBe("idle");
    expect(buffer.push(pcm(400))).toBeNull();
    expect(buffer.observeVad(false)).toBeNull();
  });

  it("does not treat pre-roll noise without ACTIVE as an utterance", () => {
    const buffer = createHandsFreeUtteranceBuffer("epoch-quiet");
    buffer.push(pcm(800));
    expect(buffer.observeVad(false)).toBeNull();
    expect(buffer.state).toBe("listening");
  });
});

it("keeps a thinking pause and continuation in one capture, fences stale ASR previews", () => {
  const buffer = createHandsFreeUtteranceBuffer("epoch");
  buffer.observeVad(true);
  buffer.push(pcm(800));
  buffer.observeVad(false);
  const old = buffer.preview()!;
  buffer.observeTranscript("因为……", old.revision);
  expect(buffer.push(pcm(900))).toBeNull();
  buffer.observeVad(true);
  buffer.push(pcm(800));
  buffer.observeVad(false);
  buffer.observeTranscript("Done.", old.revision);
  expect(buffer.push(pcm(800))).toBeNull();
  const current = buffer.preview()!;
  buffer.observeTranscript("可以再简化。", current.revision);
  const turn = buffer.push(pcm(400));
  expect(turn?.durationMs).toBe(3700);
  expect(buffer.push(pcm(4000))).toBeNull();
});
