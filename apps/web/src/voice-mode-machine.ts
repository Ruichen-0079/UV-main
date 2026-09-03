/**
 * Voice Mode state machine.
 *
 * A single explicit status replaces the previous boolean soup
 * (requestStatus + voiceCaptureStatus + voicePlaybackStatus +
 * actualPlaybackActive) for the hands-free voice path. Typed chat keeps its
 * existing states; this machine owns only the voice turn lifecycle:
 *
 *   idle -> recording -> transcribing -> thinking -> speaking -> idle
 *     ^________|_____________|______________|__________|         |
 *     |        capture/      stale/empty/   user       playback  |
 *     |        STT failed    aborted        interrupt  ended     |
 *     +--------------------> error ----------------------------+
 *     recovery: error/interrupted -> start() -> recording
 *               error/interrupted -> dismiss() -> idle
 *
 * Staleness is fenced by utteranceId: every async boundary (capture settle,
 * STT settle, Runtime delta/settlement, playback signal) carries the
 * utterance it belongs to, and events for a superseded utterance are
 * ignored. Voice identity (voiceprint/diarization/enrollment) is explicitly
 * out of scope; passthrough identity fields are untouched.
 */

export type VoiceModeStatus =
  | "idle"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "interrupted"
  | "error";

export type VoiceModeState = {
  status: VoiceModeStatus;
  /** Current (or most recently interrupted/failed) utterance, if any. */
  utteranceId: string | null;
  /** Recoverable error message; set only in `error`. */
  error: string | null;
};

export type VoiceModeEvent =
  | { type: "start"; utteranceId: string }
  | { type: "capture-started"; utteranceId: string }
  | { type: "capture-failed"; utteranceId: string; error: string }
  | { type: "stop-requested"; utteranceId: string }
  | { type: "capture-settled"; utteranceId: string }
  | { type: "transcribed"; utteranceId: string }
  | { type: "transcribe-failed"; utteranceId: string; error: string }
  | { type: "transcribe-aborted"; utteranceId: string }
  | { type: "runtime-first-sentence"; utteranceId: string }
  | { type: "runtime-completed"; utteranceId: string }
  | { type: "runtime-completed-silent"; utteranceId: string }
  | { type: "runtime-failed"; utteranceId: string; error: string }
  | { type: "runtime-aborted"; utteranceId: string }
  | { type: "playback-ended"; utteranceId: string }
  | { type: "playback-failed"; utteranceId: string; error: string }
  | { type: "interrupt"; utteranceId: string }
  | { type: "dismiss" };

export function createInitialVoiceModeState(): VoiceModeState {
  return { status: "idle", utteranceId: null, error: null };
}

function isCurrent(state: VoiceModeState, utteranceId: string): boolean {
  return state.utteranceId === utteranceId;
}

/**
 * Pure transition function. Events carrying a stale utteranceId are ignored
 * so late promises can never move a newer turn. `start` is valid from
 * idle/error/interrupted (repeated start while recording/transcribing is a
 * no-op handled by the controller; barge-in from thinking/speaking routes
 * through `interrupt` first so the interrupted turn stays observable).
 */
export function reduceVoiceMode(state: VoiceModeState, event: VoiceModeEvent): VoiceModeState {
  switch (event.type) {
    case "start": {
      if (state.status === "recording" || state.status === "transcribing") {
        // Repeated start while capturing: keep the in-flight utterance.
        return state;
      }
      if (
        state.status !== "idle" &&
        state.status !== "error" &&
        state.status !== "interrupted"
      ) {
        return state;
      }
      return { status: "recording", utteranceId: event.utteranceId, error: null };
    }
    case "capture-started": {
      if (state.status !== "recording" || !isCurrent(state, event.utteranceId)) return state;
      return state;
    }
    case "capture-failed": {
      if (state.status !== "recording" || !isCurrent(state, event.utteranceId)) return state;
      return { status: "error", utteranceId: event.utteranceId, error: event.error };
    }
    case "stop-requested": {
      if (state.status !== "recording" || !isCurrent(state, event.utteranceId)) return state;
      return state;
    }
    case "capture-settled": {
      if (state.status !== "recording" || !isCurrent(state, event.utteranceId)) return state;
      return { ...state, status: "transcribing" };
    }
    case "transcribed": {
      if (state.status !== "transcribing" || !isCurrent(state, event.utteranceId)) return state;
      return { ...state, status: "thinking" };
    }
    case "transcribe-failed": {
      if (state.status !== "transcribing" || !isCurrent(state, event.utteranceId)) return state;
      return { status: "error", utteranceId: event.utteranceId, error: event.error };
    }
    case "transcribe-aborted": {
      // Aborted STT never enters Runtime. If the utterance is still current
      // (abort came from an explicit stop), park in interrupted; a stale
      // abort is ignored so it cannot disturb the newer turn.
      if (!isCurrent(state, event.utteranceId)) return state;
      if (state.status !== "transcribing") return state;
      return { status: "interrupted", utteranceId: event.utteranceId, error: null };
    }
    case "runtime-first-sentence": {
      if (state.status !== "thinking" || !isCurrent(state, event.utteranceId)) return state;
      return { ...state, status: "speaking" };
    }
    case "runtime-completed": {
      // Runtime stream finished but sentences are still queued/playing.
      if (!isCurrent(state, event.utteranceId)) return state;
      if (state.status !== "thinking" && state.status !== "speaking") return state;
      return state;
    }
    case "runtime-completed-silent": {
      // Runtime finished without any speakable sentence: nothing will play.
      if (!isCurrent(state, event.utteranceId)) return state;
      if (state.status !== "thinking" && state.status !== "speaking") return state;
      return { status: "idle", utteranceId: null, error: null };
    }
    case "runtime-failed": {
      if (!isCurrent(state, event.utteranceId)) return state;
      if (state.status !== "thinking" && state.status !== "speaking") return state;
      return { status: "error", utteranceId: event.utteranceId, error: event.error };
    }
    case "runtime-aborted": {
      if (!isCurrent(state, event.utteranceId)) return state;
      if (state.status !== "thinking" && state.status !== "speaking") return state;
      return { status: "interrupted", utteranceId: event.utteranceId, error: null };
    }
    case "playback-ended": {
      if (!isCurrent(state, event.utteranceId)) return state;
      if (state.status !== "speaking" && state.status !== "thinking") return state;
      return { status: "idle", utteranceId: null, error: null };
    }
    case "playback-failed": {
      // Playback failure must not lock Voice Mode: text is preserved in chat
      // and the user can immediately start a new utterance.
      if (!isCurrent(state, event.utteranceId)) return state;
      if (state.status !== "speaking" && state.status !== "thinking") return state;
      return { status: "error", utteranceId: event.utteranceId, error: event.error };
    }
    case "interrupt": {
      if (!isCurrent(state, event.utteranceId)) return state;
      if (state.status === "idle" || state.status === "error") return state;
      return { status: "interrupted", utteranceId: event.utteranceId, error: null };
    }
    case "dismiss": {
      if (state.status !== "error" && state.status !== "interrupted") return state;
      return { status: "idle", utteranceId: null, error: null };
    }
  }
}

export function voiceModeStatusLabel(status: VoiceModeStatus): string {
  switch (status) {
    case "idle":
      return "Voice idle";
    case "recording":
      return "Listening…";
    case "transcribing":
      return "Transcribing…";
    case "thinking":
      return "Thinking…";
    case "speaking":
      return "Speaking…";
    case "interrupted":
      return "Interrupted";
    case "error":
      return "Voice error";
  }
}
