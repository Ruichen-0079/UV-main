import { describe, expect, it } from "vitest";
import {
  createSpeechPipelineFeedback,
  reduceSpeechPipelineFeedback
} from "./speech-pipeline-feedback.js";

describe("speech pipeline feedback", () => {
  it("starts with no audible or in-flight speech", () => {
    expect(createSpeechPipelineFeedback()).toEqual({
      playing: false,
      synthesizing: false,
      playbackEnded: 0
    });
  });

  it("tracks synthesis as future audio without marking playback", () => {
    let state = createSpeechPipelineFeedback();
    state = reduceSpeechPipelineFeedback(state, { type: "queue-state", state: "synthesizing" });
    expect(state).toEqual({ playing: false, synthesizing: true, playbackEnded: 0 });
  });

  it("marks playing audio and clears the synthesis flag", () => {
    let state = createSpeechPipelineFeedback();
    state = reduceSpeechPipelineFeedback(state, { type: "queue-state", state: "synthesizing" });
    state = reduceSpeechPipelineFeedback(state, { type: "queue-state", state: "playing" });
    expect(state).toEqual({ playing: true, synthesizing: false, playbackEnded: 0 });
  });

  it("counts playback ends and clears the playing flag", () => {
    let state = createSpeechPipelineFeedback();
    state = reduceSpeechPipelineFeedback(state, { type: "queue-state", state: "playing" });
    state = reduceSpeechPipelineFeedback(state, { type: "playback-ended" });
    expect(state).toEqual({ playing: false, synthesizing: false, playbackEnded: 1 });
    state = reduceSpeechPipelineFeedback(state, { type: "playback-ended" });
    expect(state.playbackEnded).toBe(2);
  });

  it("treats stopped, errored and idle queues as not producing audio", () => {
    for (const terminal of ["idle", "stopped", "error"] as const) {
      let state = createSpeechPipelineFeedback();
      state = reduceSpeechPipelineFeedback(state, { type: "queue-state", state: "playing" });
      state = reduceSpeechPipelineFeedback(state, { type: "queue-state", state: terminal });
      expect(state.playing).toBe(false);
      expect(state.synthesizing).toBe(false);
    }
  });
});
