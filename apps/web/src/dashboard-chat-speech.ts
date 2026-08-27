import { deriveEffectiveVoiceOutput } from "./capability-projection.js";
import type { SpeechQueueState } from "./speech-queue.js";

/** Dashboard chat uses the frozen P5-D selector without adding another policy. */
export function deriveDashboardTtsPolicy(
  input: Parameters<typeof deriveEffectiveVoiceOutput>[0]
): ReturnType<typeof deriveEffectiveVoiceOutput> {
  return deriveEffectiveVoiceOutput(input);
}

export function flushDashboardSpeechTail(
  tail: readonly string[],
  requestTts: boolean,
  enqueue: (text: string) => void,
  finish: () => void
): void {
  if (requestTts) {
    for (const text of tail) enqueue(text);
  }
  finish();
}

export function dashboardVoicePlaybackStatusLabel(
  status: SpeechQueueState,
  actualPlaybackActive: boolean
): string {
  if (actualPlaybackActive) return "Speaking…";
  switch (status) {
    case "synthesizing":
      return "Preparing speech…";
    case "playing":
      return "Speech queued…";
    case "stopped":
      return "Speech stopped; generated text is preserved.";
    case "error":
      return "Speech unavailable; text response is preserved.";
    default:
      return "";
  }
}
