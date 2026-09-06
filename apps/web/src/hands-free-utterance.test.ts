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
    const utterance = buffer.push(pcm(500));
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
