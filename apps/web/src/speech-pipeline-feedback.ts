import type { SpeechQueueState } from "./speech-queue.js";

/**
 * Minimal realtime view of the speech pipeline that a segmentation authority
 * can consult while a turn is still streaming. Populated exclusively from
 * signals that already exist — the queue's own state projection and playback
 * terminal events — so no second queue, bus authority or duration plumbing is
 * introduced. Deliberately duration-free (STATE-AWARE v1): buffered-audio
 * accounting would require cross-window duration telemetry that does not
 * exist yet.
 */
export type SpeechPipelineFeedback = {
  /** Audio is currently audible. */
  playing: boolean;
  /** Synthesis is producing future audio. */
  synthesizing: boolean;
  /** Playback-terminal ("ended") events observed for the active turn. */
  playbackEnded: number;
};

export function createSpeechPipelineFeedback(): SpeechPipelineFeedback {
  return { playing: false, synthesizing: false, playbackEnded: 0 };
}

export type SpeechPipelineFeedbackEvent =
  | { type: "queue-state"; state: SpeechQueueState }
  | { type: "playback-ended" };

export function reduceSpeechPipelineFeedback(
  current: SpeechPipelineFeedback,
  event: SpeechPipelineFeedbackEvent
): SpeechPipelineFeedback {
  if (event.type === "playback-ended") {
    return { ...current, playing: false, playbackEnded: current.playbackEnded + 1 };
  }
  switch (event.state) {
    case "synthesizing":
      return { ...current, playing: false, synthesizing: true };
    case "playing":
      return { ...current, playing: true, synthesizing: false };
    case "idle":
    case "stopped":
    case "error":
      return { ...current, playing: false, synthesizing: false };
  }
}
