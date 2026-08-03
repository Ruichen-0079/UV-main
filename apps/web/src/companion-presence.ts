import type { PresenceState } from "./lumi-live2d.js";
import type { SpeechQueueState } from "./speech-queue.js";
import type { CompanionGenerationState } from "./companion-bus.js";

export type CompanionPresenceEvent =
  | { type: "generation"; state: CompanionGenerationState }
  | { type: "queue"; state: SpeechQueueState };

/**
 * Drives the companion window's Lumi presence from two sources:
 * - main window generation state (thinking / idle / interrupted)
 * - the local speech queue state (synthesizing / playing / stopped / idle)
 * Speaking always wins until the queue actually returns to idle.
 */
export function reduceCompanionPresence(
  current: PresenceState,
  event: CompanionPresenceEvent
): PresenceState {
  switch (event.type) {
    case "generation":
      return reduceGeneration(current, event.state);
    case "queue":
      return reduceQueue(current, event.state);
  }
}

function reduceGeneration(current: PresenceState, state: CompanionGenerationState): PresenceState {
  switch (state) {
    case "thinking":
      return "thinking";
    case "interrupted":
      return "interrupted";
    case "idle":
      return current === "speaking" ? "speaking" : "idle";
  }
}

function reduceQueue(current: PresenceState, state: SpeechQueueState): PresenceState {
  switch (state) {
    case "synthesizing":
      return "thinking";
    case "playing":
      return "speaking";
    case "stopped":
      return "interrupted";
    case "idle":
    case "error":
      return "idle";
  }
}
