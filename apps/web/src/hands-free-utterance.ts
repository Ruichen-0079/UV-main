/**
 * Device-local utterance buffer for hands-free Voice Mode.
 *
 * These states are capture/UI only. They are not Runtime turn states.
 * Bounded: max duration, max samples, pre-roll, trailing silence, disposal.
 */

export const HANDS_FREE_DEVICE_STATES = [
  "idle",
  "listening",
  "speech-active",
  "finalizing"
] as const;

export type HandsFreeDeviceState = (typeof HANDS_FREE_DEVICE_STATES)[number];

export const HANDS_FREE_MAX_UTTERANCE_MS = 60_000;
export const HANDS_FREE_PRE_ROLL_MS = 400;
export const HANDS_FREE_TRAILING_SILENCE_MS = 450;
export const HANDS_FREE_MIN_UTTERANCE_MS = 280;
export const HANDS_FREE_SAMPLE_RATE = 16_000;

const MAX_SAMPLES = (HANDS_FREE_MAX_UTTERANCE_MS / 1000) * HANDS_FREE_SAMPLE_RATE;
const PRE_ROLL_SAMPLES = (HANDS_FREE_PRE_ROLL_MS / 1000) * HANDS_FREE_SAMPLE_RATE;
const TRAILING_SAMPLES = (HANDS_FREE_TRAILING_SILENCE_MS / 1000) * HANDS_FREE_SAMPLE_RATE;
const MIN_SAMPLES = (HANDS_FREE_MIN_UTTERANCE_MS / 1000) * HANDS_FREE_SAMPLE_RATE;

export type HandsFreeUtterance = {
  captureEpoch: string;
  pcm: Int16Array;
  sampleRate: number;
  durationMs: number;
};

export type HandsFreeUtteranceBuffer = {
  state: HandsFreeDeviceState;
  captureEpoch: string;
  push(pcm: Int16Array): HandsFreeUtterance | null;
  observeVad(active: boolean, nowMs?: number): HandsFreeUtterance | null;
  dispose(): void;
};

export function createHandsFreeUtteranceBuffer(captureEpoch: string): HandsFreeUtteranceBuffer {
  const preRoll: Int16Array[] = [];
  let preRollSamples = 0;
  const active: Int16Array[] = [];
  let activeSamples = 0;
  let speechActive = false;
  let awaitingTrailing = false;
  let trailingSamples = 0;
  let disposed = false;
  let state: HandsFreeDeviceState = "listening";

  function concat(chunks: Int16Array[], total: number): Int16Array {
    const out = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function takeUtterance(): HandsFreeUtterance | null {
    const pcm = concat(active, activeSamples);
    active.length = 0;
    activeSamples = 0;
    trailingSamples = 0;
    awaitingTrailing = false;
    speechActive = false;
    state = "listening";
    if (pcm.length < MIN_SAMPLES) return null;
    return {
      captureEpoch,
      pcm,
      sampleRate: HANDS_FREE_SAMPLE_RATE,
      durationMs: Math.round((pcm.length / HANDS_FREE_SAMPLE_RATE) * 1000)
    };
  }

  return {
    get state() {
      return disposed ? "idle" : state;
    },
    captureEpoch,
    push(pcm: Int16Array): HandsFreeUtterance | null {
      if (disposed || pcm.length === 0) return null;
      if (!speechActive) {
        preRoll.push(pcm);
        preRollSamples += pcm.length;
        while (preRollSamples > PRE_ROLL_SAMPLES && preRoll.length > 1) {
          const dropped = preRoll.shift();
          preRollSamples -= dropped?.length ?? 0;
        }
        return null;
      }
      active.push(pcm);
      activeSamples += pcm.length;
      if (awaitingTrailing) trailingSamples += pcm.length;
      if (
        activeSamples >= MAX_SAMPLES ||
        (awaitingTrailing && trailingSamples >= TRAILING_SAMPLES)
      ) {
        state = "finalizing";
        return takeUtterance();
      }
      return null;
    },
    observeVad(activeFlag: boolean, _nowMs?: number): HandsFreeUtterance | null {
      if (disposed) return null;
      if (activeFlag) {
        if (!speechActive) {
          speechActive = true;
          awaitingTrailing = false;
          state = "speech-active";
          active.push(...preRoll);
          activeSamples += preRollSamples;
          preRoll.length = 0;
          preRollSamples = 0;
          trailingSamples = 0;
        } else {
          awaitingTrailing = false;
          trailingSamples = 0;
        }
        if (activeSamples >= MAX_SAMPLES) {
          state = "finalizing";
          return takeUtterance();
        }
        return null;
      }
      if (!speechActive) return null;
      awaitingTrailing = true;
      if (trailingSamples < TRAILING_SAMPLES) return null;
      state = "finalizing";
      return takeUtterance();
    },
    dispose() {
      disposed = true;
      state = "idle";
      preRoll.length = 0;
      active.length = 0;
      preRollSamples = 0;
      activeSamples = 0;
      speechActive = false;
    }
  };
}
