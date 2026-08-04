import { describe, expect, it } from "vitest";
import { createCompanionSpeechBuffer } from "./companion-speech-buffer.js";

describe("createCompanionSpeechBuffer", () => {
  it("buffers sequence 0 until the matching turn is ready, then drains in order", () => {
    const buffer = createCompanionSpeechBuffer();
    buffer.setActiveTurn("turn-a");
    expect(
      buffer.push({
        requestId: "turn-a",
        sequence: 0,
        text: "Hello.",
        language: "en"
      })
    ).toBe(true);
    expect(
      buffer.push({
        requestId: "turn-a",
        sequence: 1,
        text: "Next.",
        language: "en"
      })
    ).toBe(true);
    expect(buffer.size()).toBe(2);
    expect(buffer.drain("turn-a").map((segment) => segment.sequence)).toEqual([0, 1]);
    expect(buffer.size()).toBe(0);
  });

  it("rejects foreign turns and does not replay old turns after clear", () => {
    const buffer = createCompanionSpeechBuffer();
    buffer.setActiveTurn("turn-a");
    buffer.push({ requestId: "turn-a", sequence: 0, text: "Hello.", language: "en" });
    expect(
      buffer.push({ requestId: "turn-b", sequence: 0, text: "stale", language: "en" })
    ).toBe(false);
    buffer.clear();
    expect(buffer.drain("turn-a")).toEqual([]);
    expect(buffer.getActiveTurn()).toBeNull();
  });

  it("dedupes the same sequence and respects capacity", () => {
    const buffer = createCompanionSpeechBuffer(1);
    buffer.setActiveTurn("turn-a");
    expect(
      buffer.push({ requestId: "turn-a", sequence: 0, text: "Hello.", language: "en" })
    ).toBe(true);
    expect(
      buffer.push({ requestId: "turn-a", sequence: 0, text: "Hello.", language: "en" })
    ).toBe(false);
    expect(
      buffer.push({ requestId: "turn-a", sequence: 1, text: "Two.", language: "en" })
    ).toBe(false);
    expect(buffer.size()).toBe(1);
  });

  it("can adopt the first speak as the active turn when start-generation has not arrived", () => {
    const buffer = createCompanionSpeechBuffer();
    expect(
      buffer.push({ requestId: "early", sequence: 0, text: "Hello.", language: "en" })
    ).toBe(true);
    expect(buffer.getActiveTurn()).toBe("early");
    buffer.setActiveTurn("early");
    expect(buffer.drain("early")[0]?.text).toBe("Hello.");
  });
});
