import type { SpeechQueueState } from "./speech-queue.js";
import type { CompanionGenerationState } from "./companion-bus.js";

export type CompanionPresenceState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "interrupted";

export type CompanionPresenceEvent =
  | { type: "generation"; state: CompanionGenerationState }
  | { type: "queue"; state: SpeechQueueState };

/**
 * Drives the companion window's Lumi presence from two sources:
 * - main window generation state (thinking / idle / interrupted)
 * - the local speech queue state (synthesizing / playing / stopped / idle)
 * Speaking always wins until the queue actually returns to idle. Interrupted
 * is held until its tokenized reset timer so stop callbacks cannot collapse it
 * synchronously; a new generation state still overrides it immediately.
 */
export function reduceCompanionPresence(
  current: CompanionPresenceState,
  event: CompanionPresenceEvent
): CompanionPresenceState {
  switch (event.type) {
    case "generation":
      return reduceGeneration(current, event.state);
    case "queue":
      return reduceQueue(current, event.state);
  }
}

function reduceGeneration(
  current: CompanionPresenceState,
  state: CompanionGenerationState
): CompanionPresenceState {
  switch (state) {
    case "listening":
      return "listening";
    case "thinking":
      return "thinking";
    case "interrupted":
      return "interrupted";
    case "idle":
      return current === "speaking" || current === "interrupted" ? current : "idle";
  }
}

function reduceQueue(current: CompanionPresenceState, state: SpeechQueueState): CompanionPresenceState {
  switch (state) {
    case "synthesizing":
      return "thinking";
    case "playing":
      return "speaking";
    case "stopped":
      return "interrupted";
    case "idle":
    case "error":
      return current === "interrupted" ? "interrupted" : "idle";
  }
}

export type CompanionAnimationFrame = {
  /** 0 is open, 1 is closed. */
  blink: number;
  /** A small normalized breath value for ParamBreath. */
  breath: number;
};

/** Pure, deterministic idle animation values for the Companion surface. */
export function getCompanionAnimation(
  state: CompanionPresenceState,
  nowMilliseconds: number,
  blink = 0
): CompanionAnimationFrame {
  if (state === "interrupted") {
    return { blink: 0, breath: 0 };
  }
  const now = Number.isFinite(nowMilliseconds) ? Math.max(0, nowMilliseconds) : 0;
  const baseline = state === "idle" ? 0.12 : 0.16;
  const amplitude = state === "idle" || state === "speaking" ? 0.04 : 0.025;
  const breath = baseline + Math.sin((now / 2600) * Math.PI * 2) * amplitude;
  return { blink: Math.min(1, Math.max(0, blink)), breath };
}

/**
 * Central blink configuration. All timing lives here — do not scatter magic
 * numbers across companion-page / Lumi code.
 */
export const BLINK_CONFIG = {
  /** Ordinary idle gap between blinks (inclusive range, non-uniform sample). */
  minIntervalMs: 2000,
  maxIntervalMs: 4800,
  /** Closing phase duration. */
  closeMs: 85,
  /** Fully closed hold — long enough to be visible at ~60 FPS. */
  holdMs: 55,
  /** Opening phase duration. */
  openMs: 120,
  /** Chance of scheduling one follow-up blink after a complete blink. */
  doubleBlinkProbability: 0.13,
  /** Gap between first and second blink of a double. */
  doubleBlinkGapMinMs: 130,
  doubleBlinkGapMaxMs: 240,
  /** Second blink of a double is slightly faster. */
  doubleCloseMs: 70,
  doubleHoldMs: 45,
  doubleOpenMs: 100,
  /** Thinking slightly shortens the waiting interval. */
  thinkingIntervalScale: 0.85
} as const;

/** @deprecated Prefer BLINK_CONFIG.minIntervalMs */
export const BLINK_MIN_INTERVAL_MS = BLINK_CONFIG.minIntervalMs;
/** @deprecated Prefer BLINK_CONFIG.maxIntervalMs */
export const BLINK_MAX_INTERVAL_MS = BLINK_CONFIG.maxIntervalMs;

export type CompanionBlinkScheduler = {
  sample(nowMilliseconds: number, presence?: CompanionPresenceState): number;
  getPhase(nowMilliseconds: number): "waiting" | "closing" | "holding" | "opening";
  reset(nowMilliseconds?: number): void;
  dispose(): void;
  getNextBlinkAt(): number;
  getConfig(): typeof BLINK_CONFIG;
};

/**
 * Schedules one smooth, synchronized blink at a time. Randomness is sampled
 * only when a blink finishes, never from the animation frame callback.
 * Speaking continues to blink; only interrupted freezes eyes open.
 */
export function createCompanionBlinkScheduler(
  random: () => number = Math.random,
  initialNowMilliseconds = 0
): CompanionBlinkScheduler {
  let nextBlinkAt = initialNowMilliseconds + nextInterval(random, "idle");
  let disposed = false;
  let doublePending = false;
  let activeCloseMs: number = BLINK_CONFIG.closeMs;
  let activeHoldMs: number = BLINK_CONFIG.holdMs;
  let activeOpenMs: number = BLINK_CONFIG.openMs;

  function totalDuration(): number {
    return activeCloseMs + activeHoldMs + activeOpenMs;
  }

  function sample(nowMilliseconds: number, presence: CompanionPresenceState = "idle"): number {
    if (disposed) return 0;
    if (presence === "interrupted") return 0;
    const now = Number.isFinite(nowMilliseconds) ? Math.max(0, nowMilliseconds) : 0;
    const phase = phaseAt(now, nextBlinkAt, activeCloseMs, activeHoldMs, activeOpenMs);
    if (phase === "waiting" && now < nextBlinkAt) return 0;
    const elapsed = now - nextBlinkAt;
    if (phase === "closing") {
      return Math.sin((elapsed / activeCloseMs) * (Math.PI / 2));
    }
    if (phase === "holding") return 1;
    if (phase === "opening") {
      return Math.cos(((elapsed - activeCloseMs - activeHoldMs) / activeOpenMs) * (Math.PI / 2));
    }

    // Blink finished — schedule the next one once (not every frame).
    if (doublePending) {
      doublePending = false;
      activeCloseMs = BLINK_CONFIG.closeMs;
      activeHoldMs = BLINK_CONFIG.holdMs;
      activeOpenMs = BLINK_CONFIG.openMs;
      nextBlinkAt = now + nextInterval(random, presence);
    } else if (random() < BLINK_CONFIG.doubleBlinkProbability) {
      doublePending = true;
      activeCloseMs = BLINK_CONFIG.doubleCloseMs;
      activeHoldMs = BLINK_CONFIG.doubleHoldMs;
      activeOpenMs = BLINK_CONFIG.doubleOpenMs;
      nextBlinkAt = now + nextDoubleGap(random);
    } else {
      activeCloseMs = BLINK_CONFIG.closeMs;
      activeHoldMs = BLINK_CONFIG.holdMs;
      activeOpenMs = BLINK_CONFIG.openMs;
      nextBlinkAt = now + nextInterval(random, presence);
    }
    return 0;
  }

  return {
    sample,
    getPhase(nowMilliseconds) {
      if (disposed) return "waiting";
      const now = Number.isFinite(nowMilliseconds) ? Math.max(0, nowMilliseconds) : 0;
      return phaseAt(now, nextBlinkAt, activeCloseMs, activeHoldMs, activeOpenMs);
    },
    reset(nowMilliseconds = 0) {
      disposed = false;
      doublePending = false;
      activeCloseMs = BLINK_CONFIG.closeMs;
      activeHoldMs = BLINK_CONFIG.holdMs;
      activeOpenMs = BLINK_CONFIG.openMs;
      const now = Number.isFinite(nowMilliseconds) ? Math.max(0, nowMilliseconds) : 0;
      nextBlinkAt = now + nextInterval(random, "idle");
    },
    dispose() {
      disposed = true;
      doublePending = false;
      nextBlinkAt = Number.POSITIVE_INFINITY;
    },
    getNextBlinkAt() {
      return nextBlinkAt;
    },
    getConfig() {
      return BLINK_CONFIG;
    }
  };
}

function phaseAt(
  now: number,
  nextBlinkAt: number,
  closeMs: number,
  holdMs: number,
  openMs: number
): "waiting" | "closing" | "holding" | "opening" {
  if (now < nextBlinkAt) return "waiting";
  const elapsed = now - nextBlinkAt;
  if (elapsed < closeMs) return "closing";
  if (elapsed < closeMs + holdMs) return "holding";
  if (elapsed < closeMs + holdMs + openMs) return "opening";
  return "waiting";
}

export type InterruptedResetScheduler = {
  schedule(): void;
  invalidate(): void;
  dispose(): void;
};

export function createInterruptedResetScheduler(
  onReset: () => void,
  delayMilliseconds = 320
): InterruptedResetScheduler {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    schedule() {
      if (disposed) return;
      clear();
      const currentGeneration = ++generation;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed && currentGeneration === generation) onReset();
      }, delayMilliseconds);
    },
    invalidate() {
      generation += 1;
      clear();
    },
    dispose() {
      disposed = true;
      generation += 1;
      clear();
    }
  };
}

/** Non-uniform interval: prefer the middle of the range over extremes. */
function nextInterval(random: () => number, presence: CompanionPresenceState): number {
  const a = clamp01(random());
  const b = clamp01(random());
  // Average of two uniforms → triangular-ish, peaks near mid-range.
  const normalized = (a + b) / 2;
  let interval =
    BLINK_CONFIG.minIntervalMs +
    normalized * (BLINK_CONFIG.maxIntervalMs - BLINK_CONFIG.minIntervalMs);
  if (presence === "thinking") {
    interval *= BLINK_CONFIG.thinkingIntervalScale;
  }
  return interval;
}

function nextDoubleGap(random: () => number): number {
  const normalized = clamp01(random());
  return (
    BLINK_CONFIG.doubleBlinkGapMinMs +
    normalized * (BLINK_CONFIG.doubleBlinkGapMaxMs - BLINK_CONFIG.doubleBlinkGapMinMs)
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
