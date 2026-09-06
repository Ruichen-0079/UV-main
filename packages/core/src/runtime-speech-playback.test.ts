import { describe, expect, it } from "vitest";
import {
  admitSpeechPlaybackEffect,
  createSpeechPlaybackStore,
  reportSpeechPlaybackOutcome,
  revokeAudibleSpeechPlayback
} from "./runtime-speech-playback.js";

describe("Runtime speech playback effect fence", () => {
  it("admits one speech effect and applies STARTED then COMPLETED", () => {
    const store = createSpeechPlaybackStore();
    const admitted = admitSpeechPlaybackEffect(store, {
      sessionId: "s",
      requestId: "turn-1",
      createId: () => "fx-1"
    });
    expect(admitted).toMatchObject({
      effectId: "speech.fx-1",
      requestId: "turn-1",
      state: "ADMITTED"
    });
    expect(
      reportSpeechPlaybackOutcome(store, { effectId: "speech.fx-1", outcome: "STARTED" })?.state
    ).toBe("STARTED");
    expect(
      reportSpeechPlaybackOutcome(store, { effectId: "speech.fx-1", outcome: "COMPLETED" })?.state
    ).toBe("COMPLETED");
  });

  it("revokes audible playback to INTERRUPTED and rejects a late COMPLETED", () => {
    const store = createSpeechPlaybackStore();
    admitSpeechPlaybackEffect(store, {
      sessionId: "s",
      requestId: "turn-a",
      createId: () => "fx-a"
    });
    reportSpeechPlaybackOutcome(store, { effectId: "speech.fx-a", outcome: "STARTED" });
    const revoked = revokeAudibleSpeechPlayback(store);
    expect(revoked?.state).toBe("INTERRUPTED");
    expect(revoked?.requestId).toBe("turn-a");
    expect(
      reportSpeechPlaybackOutcome(store, { effectId: "speech.fx-a", outcome: "COMPLETED" })?.state
    ).toBe("INTERRUPTED");
    expect(
      reportSpeechPlaybackOutcome(store, { effectId: "speech.fx-a", outcome: "INTERRUPTED" })?.state
    ).toBe("INTERRUPTED");
  });

  it("ignores a stale effectId from an old window callback", () => {
    const store = createSpeechPlaybackStore();
    admitSpeechPlaybackEffect(store, {
      sessionId: "s",
      requestId: "turn-old",
      createId: () => "old"
    });
    reportSpeechPlaybackOutcome(store, { effectId: "speech.old", outcome: "STARTED" });
    admitSpeechPlaybackEffect(store, {
      sessionId: "s",
      requestId: "turn-new",
      createId: () => "new"
    });
    expect(store.current?.effectId).toBe("speech.new");
    expect(store.current?.state).toBe("ADMITTED");
    expect(
      reportSpeechPlaybackOutcome(store, { effectId: "speech.old", outcome: "COMPLETED" })?.state
    ).toBe("ADMITTED");
    expect(
      reportSpeechPlaybackOutcome(store, { effectId: "speech.old", outcome: "INTERRUPTED" })?.state
    ).toBe("ADMITTED");
  });
});
