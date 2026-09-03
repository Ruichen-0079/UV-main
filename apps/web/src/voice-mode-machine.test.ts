import { describe, expect, it } from "vitest";
import {
  createInitialVoiceModeState,
  reduceVoiceMode,
  voiceModeStatusLabel,
  type VoiceModeState
} from "./voice-mode-machine.js";

function run(state: VoiceModeState, events: Parameters<typeof reduceVoiceMode>[1][]): VoiceModeState {
  return events.reduce(reduceVoiceMode, state);
}

describe("voice mode machine", () => {
  it("starts idle and labels every status for the voice surface", () => {
    expect(createInitialVoiceModeState()).toEqual({ status: "idle", utteranceId: null, error: null });
    expect(voiceModeStatusLabel("recording")).toBe("Listening…");
    expect(voiceModeStatusLabel("transcribing")).toBe("Transcribing…");
    expect(voiceModeStatusLabel("thinking")).toBe("Thinking…");
    expect(voiceModeStatusLabel("speaking")).toBe("Speaking…");
    expect(voiceModeStatusLabel("interrupted")).toBe("Interrupted");
    expect(voiceModeStatusLabel("error")).toBe("Voice error");
  });

  it("walks the happy path recording -> transcribing -> thinking -> speaking -> idle", () => {
    const state = run(createInitialVoiceModeState(), [
      { type: "start", utteranceId: "u-1" },
      { type: "capture-started", utteranceId: "u-1" },
      { type: "capture-settled", utteranceId: "u-1" },
      { type: "transcribed", utteranceId: "u-1" },
      { type: "runtime-first-sentence", utteranceId: "u-1" },
      { type: "runtime-completed", utteranceId: "u-1" },
      { type: "playback-ended", utteranceId: "u-1" }
    ]);
    expect(state).toEqual({ status: "idle", utteranceId: null, error: null });
  });

  it("returns to idle when runtime completes without any speakable sentence", () => {
    const state = run(createInitialVoiceModeState(), [
      { type: "start", utteranceId: "u-1" },
      { type: "capture-settled", utteranceId: "u-1" },
      { type: "transcribed", utteranceId: "u-1" },
      { type: "runtime-completed-silent", utteranceId: "u-1" }
    ]);
    expect(state.status).toBe("idle");
  });

  it("ignores repeated start while recording or transcribing", () => {
    const recording = reduceVoiceMode(createInitialVoiceModeState(), {
      type: "start",
      utteranceId: "u-1"
    });
    expect(reduceVoiceMode(recording, { type: "start", utteranceId: "u-2" })).toBe(recording);
    const transcribing = reduceVoiceMode(recording, {
      type: "capture-settled",
      utteranceId: "u-1"
    });
    expect(reduceVoiceMode(transcribing, { type: "start", utteranceId: "u-2" })).toBe(transcribing);
  });

  it("recovers from capture, STT, runtime, and playback failures via error -> start", () => {
    for (const failing of [
      { status: "recording", event: { type: "capture-failed", utteranceId: "u-1", error: "mic" } },
      {
        status: "transcribing",
        event: { type: "transcribe-failed", utteranceId: "u-1", error: "stt" }
      },
      { status: "thinking", event: { type: "runtime-failed", utteranceId: "u-1", error: "rt" } },
      { status: "speaking", event: { type: "playback-failed", utteranceId: "u-1", error: "play" } }
    ] as const) {
      const setup: Parameters<typeof reduceVoiceMode>[1][] = [
        { type: "start", utteranceId: "u-1" }
      ];
      if (failing.status !== "recording") setup.push({ type: "capture-settled", utteranceId: "u-1" });
      if (failing.status === "thinking" || failing.status === "speaking") {
        setup.push({ type: "transcribed", utteranceId: "u-1" });
      }
      if (failing.status === "speaking") {
        setup.push({ type: "runtime-first-sentence", utteranceId: "u-1" });
      }
      const failed = run(createInitialVoiceModeState(), [...setup, failing.event]);
      expect(failed.status).toBe("error");
      expect(failed.error).toBeTruthy();
      const retried = reduceVoiceMode(failed, { type: "start", utteranceId: "u-2" });
      expect(retried).toEqual({ status: "recording", utteranceId: "u-2", error: null });
    }
  });

  it("parks an aborted STT or runtime turn as interrupted and dismisses back to idle", () => {
    const abortedStt = run(createInitialVoiceModeState(), [
      { type: "start", utteranceId: "u-1" },
      { type: "capture-settled", utteranceId: "u-1" },
      { type: "transcribe-aborted", utteranceId: "u-1" }
    ]);
    expect(abortedStt.status).toBe("interrupted");
    expect(reduceVoiceMode(abortedStt, { type: "dismiss" }).status).toBe("idle");

    const abortedRuntime = run(createInitialVoiceModeState(), [
      { type: "start", utteranceId: "u-1" },
      { type: "capture-settled", utteranceId: "u-1" },
      { type: "transcribed", utteranceId: "u-1" },
      { type: "runtime-aborted", utteranceId: "u-1" }
    ]);
    expect(abortedRuntime.status).toBe("interrupted");
  });

  it("ignores stale events from a superseded utterance", () => {
    let state = run(createInitialVoiceModeState(), [
      { type: "start", utteranceId: "u-1" },
      { type: "capture-settled", utteranceId: "u-1" },
      { type: "transcribed", utteranceId: "u-1" },
      { type: "interrupt", utteranceId: "u-1" },
      { type: "start", utteranceId: "u-2" }
    ]);
    expect(state).toEqual({ status: "recording", utteranceId: "u-2", error: null });
    // Every late u-1 callback is a no-op against the live u-2 turn.
    for (const stale of [
      { type: "transcribed", utteranceId: "u-1" },
      { type: "transcribe-failed", utteranceId: "u-1", error: "late" },
      { type: "runtime-first-sentence", utteranceId: "u-1" },
      { type: "runtime-completed", utteranceId: "u-1" },
      { type: "runtime-failed", utteranceId: "u-1", error: "late" },
      { type: "playback-ended", utteranceId: "u-1" },
      { type: "playback-failed", utteranceId: "u-1", error: "late" },
      { type: "capture-failed", utteranceId: "u-1", error: "late" }
    ] as const) {
      const next = reduceVoiceMode(state, stale);
      expect(next).toBe(state);
    }
    state = run(state, [
      { type: "capture-settled", utteranceId: "u-2" },
      { type: "transcribed", utteranceId: "u-2" }
    ]);
    expect(state.status).toBe("thinking");
  });

  it("keeps playback failure recoverable instead of locking voice mode", () => {
    const failed = run(createInitialVoiceModeState(), [
      { type: "start", utteranceId: "u-1" },
      { type: "capture-settled", utteranceId: "u-1" },
      { type: "transcribed", utteranceId: "u-1" },
      { type: "runtime-first-sentence", utteranceId: "u-1" },
      { type: "playback-failed", utteranceId: "u-1", error: "audio gone" }
    ]);
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("audio gone");
    expect(reduceVoiceMode(failed, { type: "start", utteranceId: "u-2" }).status).toBe(
      "recording"
    );
  });
});
