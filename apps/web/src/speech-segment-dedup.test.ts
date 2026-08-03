import { describe, expect, it } from "vitest";
import { createSpeechSegmentDeduper } from "./speech-segment-dedup.js";

describe("createSpeechSegmentDeduper", () => {
  it("deduplicates the same (requestId, sequence) pair", () => {
    const deduper = createSpeechSegmentDeduper();
    expect(deduper.isNew("turn-1", 0)).toBe(true);
    expect(deduper.isNew("turn-1", 0)).toBe(false);
    expect(deduper.isNew("turn-1", 1)).toBe(true);
  });

  it("keeps sequences independent across turns", () => {
    const deduper = createSpeechSegmentDeduper();
    deduper.isNew("turn-1", 0);
    expect(deduper.isNew("turn-2", 0)).toBe(true);
    expect(deduper.isNew("turn-2", 0)).toBe(false);
  });
});
