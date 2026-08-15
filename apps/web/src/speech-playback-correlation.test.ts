import { describe, expect, it } from "vitest";
import {
  correlateSpeechPlayback,
  createSpeechPlaybackCorrelation,
  retireActiveSpeechPlayback
} from "./speech-playback-correlation.js";

const segment = (requestId: string, sequence: number) => ({ requestId, sequence });

describe("speech playback correlation", () => {
  it("keeps a newer same-turn segment active after an old terminal callback", () => {
    let state = createSpeechPlaybackCorrelation();
    const first = segment("turn-a", 0);
    const second = segment("turn-a", 1);

    state = correlateSpeechPlayback(state, "started", first).state;
    state = correlateSpeechPlayback(state, "terminal", first).state;
    state = correlateSpeechPlayback(state, "started", second).state;
    const stale = correlateSpeechPlayback(state, "terminal", first);

    expect(stale.accepted).toBe(false);
    expect(stale.state.active).toEqual(second);
  });

  it("rejects an old terminal callback while a newer segment is active", () => {
    let state = createSpeechPlaybackCorrelation();
    const first = segment("turn-a", 0);
    const second = segment("turn-a", 1);

    state = correlateSpeechPlayback(state, "started", first).state;
    state = correlateSpeechPlayback(state, "started", second).state;
    const stale = correlateSpeechPlayback(state, "terminal", first);

    expect(stale.accepted).toBe(false);
    expect(stale.state.active).toEqual(second);
  });

  it("rejects a late start after a segment has been terminally retired", () => {
    let state = createSpeechPlaybackCorrelation();
    const first = segment("turn-a", 0);

    state = correlateSpeechPlayback(state, "terminal", first).state;
    const lateStart = correlateSpeechPlayback(state, "started", first);

    expect(lateStart.accepted).toBe(false);
    expect(lateStart.state.active).toBeNull();
  });

  it("does not allow an old turn callback into a current turn session", () => {
    let state = createSpeechPlaybackCorrelation();
    const oldSegment = segment("turn-a", 0);
    const currentSegment = segment("turn-b", 0);

    state = correlateSpeechPlayback(state, "started", oldSegment).state;
    const stale = correlateSpeechPlayback(state, "terminal", currentSegment);

    expect(stale.accepted).toBe(false);
    expect(stale.state.active).toEqual(oldSegment);
    state = createSpeechPlaybackCorrelation();
    expect(correlateSpeechPlayback(state, "started", currentSegment).accepted).toBe(true);
  });

  it("retires active and attached resources on session cancellation", () => {
    let state = createSpeechPlaybackCorrelation();
    const current = segment("turn-a", 0);
    state = correlateSpeechPlayback(state, "attached", current).state;
    state = correlateSpeechPlayback(state, "started", current).state;
    state = retireActiveSpeechPlayback(state);

    expect(state.active).toBeNull();
    expect(state.attached).toBeNull();
    expect(correlateSpeechPlayback(state, "started", current).accepted).toBe(false);
  });

  it("accepts the matching detach once after a terminal event", () => {
    let state = createSpeechPlaybackCorrelation();
    const current = segment("turn-a", 0);
    state = correlateSpeechPlayback(state, "attached", current).state;
    state = correlateSpeechPlayback(state, "started", current).state;
    state = correlateSpeechPlayback(state, "terminal", current).state;

    const detached = correlateSpeechPlayback(state, "detached", current);
    expect(detached.accepted).toBe(true);
    expect(detached.state.attached).toBeNull();
    expect(correlateSpeechPlayback(detached.state, "detached", current).accepted).toBe(false);
  });
});
