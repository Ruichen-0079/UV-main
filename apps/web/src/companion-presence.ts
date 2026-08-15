import type { SpeechQueueState } from "./speech-queue.js";
import type { CompanionGenerationState } from "./companion-bus.js";

/**
 * Visual behavior state derived from the normalized projection below.
 *
 * This is intentionally not the product Presence contract.  It is retained
 * as the small input vocabulary used by the existing blink/gaze mechanics.
 */
export type CompanionPresentationState =
  "idle" | "listening" | "thinking" | "speaking" | "interrupted";

/** @deprecated Use CompanionPresentationState for animation-only consumers. */
export type CompanionPresenceState = CompanionPresentationState;

export type CompanionPresenceActivity = "idle" | "listening" | "thinking";
export type CompanionPresenceConnectivity = "unknown" | "online" | "reconnecting" | "offline";
export type CompanionPresenceCapabilityState = "unknown" | "available" | "unavailable";
export type CompanionPresenceSpeech =
  "inactive" | "queued" | "preparing" | "ready" | "active" | "completed" | "cancelled" | "error";
export type CompanionPresenceTransition = "none" | "interrupted";
export type CompanionPresenceLifecycle =
  "none" | "active" | "generation-complete" | "cancelled" | "invalidated";

export type CompanionPresenceCapabilities = {
  tts: CompanionPresenceCapabilityState;
  audio: CompanionPresenceCapabilityState;
  live2d: CompanionPresenceCapabilityState;
};

export type CompanionPresenceProjection = {
  /** The current request id; request ids are the current web-side turn epoch. */
  epoch: string | null;
  /** Generation/speech terminality is tracked independently from speech playback. */
  lifecycle: CompanionPresenceLifecycle;
  activity: CompanionPresenceActivity;
  connectivity: CompanionPresenceConnectivity;
  speech: CompanionPresenceSpeech;
  capabilities: CompanionPresenceCapabilities;
  transition: CompanionPresenceTransition;
};

export function createInitialCompanionPresence(
  connectivity: CompanionPresenceConnectivity = "unknown"
): CompanionPresenceProjection {
  return {
    epoch: null,
    lifecycle: "none",
    activity: "idle",
    connectivity,
    speech: "inactive",
    capabilities: {
      tts: "unknown",
      audio: "unknown",
      live2d: "unknown"
    },
    transition: "none"
  };
}

/**
 * Session-local guard for turn-start inputs. Request ids are opaque, so the
 * current id alone cannot distinguish a new turn from a delayed old start.
 * The owning surface keeps retired ids here without putting history into the
 * public Presence projection.
 */
export type CompanionPresenceEpochGuard = {
  accept(epoch: string): boolean;
  dispose(): void;
};

export function createCompanionPresenceEpochGuard(): CompanionPresenceEpochGuard {
  let currentEpoch: string | null = null;
  const retiredEpochs = new Set<string>();

  return {
    accept(epoch) {
      if (!isValidEpoch(epoch) || epoch === currentEpoch || retiredEpochs.has(epoch)) {
        return false;
      }
      if (currentEpoch !== null) retiredEpochs.add(currentEpoch);
      currentEpoch = epoch;
      return true;
    },
    dispose() {
      currentEpoch = null;
      retiredEpochs.clear();
    }
  };
}

export type PresenceTargetRegionWeights = {
  center: number;
  left: number;
  right: number;
  upper: number;
  lower: number;
};

/**
 * State-specific behavior is data, not a second set of state machines.  The
 * gaze scheduler and the Presence RAF both consume the same interpolated
 * profile, so a state change never rebuilds a scheduler or jumps a pose.
 *
 * Amplitude fields are **final peak envelopes** (what the model may actually
 * reach). The gaze mapper must not multiply them by a second oversized base.
 */
export type PresenceBehaviorProfile = {
  targetRegionWeights: PresenceTargetRegionWeights;
  targetHoldMinMs: number;
  targetHoldMaxMs: number;
  /** Final |ParamEyeBallX| peak. */
  eyeXMax: number;
  eyeYMin: number;
  eyeYMax: number;
  eyeResponseMs: number;
  /** Final |ParamAngle*| peaks in degrees. */
  headXMax: number;
  headYMax: number;
  headZMax: number;
  headDelayMinMs: number;
  headDelayMaxMs: number;
  headResponseMs: number;
  /** Final |ParamBodyAngle*| peaks in degrees. */
  bodyXMax: number;
  bodyYMax: number;
  bodyZMax: number;
  /** Body tracks head at this fraction, then soft-capped by body*Max. */
  bodyFollowFraction: number;
  bodyDelayMs: number;
  bodyResponseMs: number;
  blinkIntervalMinMs: number;
  blinkIntervalMaxMs: number;
  /** Multiplier applied after interval sampling (usually 1). */
  blinkIntervalScale: number;
  doubleBlinkProbability: number;
  breathSpeedScale: number;
  breathAmplitudeScale: number;
  breathBaseline: number;
  breathAmplitude: number;
  recenterBias: number;
  /** Profile blend duration when entering this state. */
  transitionMs: number;
  quickGlanceChance: number;
  quickGlanceHoldMinMs: number;
  quickGlanceHoldMaxMs: number;
  quickGlanceAmplitudeScale: number;
  /** Head follows only this fraction of a quick-glance eye target. */
  quickGlanceHeadFollow: number;
  /**
   * Relative envelope tags for diagnostics / tests (1 = idle peak reference).
   * Not re-multiplied into mapping when absolute peaks are present.
   */
  eyeAmplitudeScale: number;
  headAmplitudeScale: number;
  bodyAmplitudeScale: number;
};

export const PRESENCE_BEHAVIOR_PROFILES: Record<CompanionPresenceState, PresenceBehaviorProfile> = {
  idle: {
    targetRegionWeights: { center: 0.28, left: 0.24, right: 0.24, upper: 0.18, lower: 0.06 },
    targetHoldMinMs: 1200,
    targetHoldMaxMs: 3600,
    eyeXMax: 0.72,
    eyeYMin: -0.26,
    eyeYMax: 0.44,
    eyeResponseMs: 200,
    headXMax: 11,
    headYMax: 7,
    headZMax: 4.5,
    headDelayMinMs: 130,
    headDelayMaxMs: 230,
    headResponseMs: 540,
    bodyXMax: 4,
    bodyYMax: 2,
    bodyZMax: 3,
    bodyFollowFraction: 0.34,
    bodyDelayMs: 380,
    bodyResponseMs: 1150,
    blinkIntervalMinMs: 1800,
    blinkIntervalMaxMs: 4200,
    blinkIntervalScale: 1,
    doubleBlinkProbability: 0.18,
    breathSpeedScale: 1,
    breathAmplitudeScale: 1,
    breathBaseline: 0.13,
    breathAmplitude: 0.045,
    recenterBias: 0,
    transitionMs: 420,
    quickGlanceChance: 0.18,
    quickGlanceHoldMinMs: 380,
    quickGlanceHoldMaxMs: 720,
    quickGlanceAmplitudeScale: 0.92,
    quickGlanceHeadFollow: 0.32,
    eyeAmplitudeScale: 1,
    headAmplitudeScale: 1,
    bodyAmplitudeScale: 1
  },
  listening: {
    targetRegionWeights: { center: 0.66, left: 0.12, right: 0.12, upper: 0.08, lower: 0.02 },
    targetHoldMinMs: 1800,
    targetHoldMaxMs: 4000,
    eyeXMax: 0.34,
    eyeYMin: -0.12,
    eyeYMax: 0.2,
    eyeResponseMs: 180,
    headXMax: 4.5,
    headYMax: 2.5,
    headZMax: 1.8,
    headDelayMinMs: 100,
    headDelayMaxMs: 180,
    headResponseMs: 490,
    bodyXMax: 1.5,
    bodyYMax: 1,
    bodyZMax: 1,
    bodyFollowFraction: 0.28,
    bodyDelayMs: 420,
    bodyResponseMs: 1300,
    blinkIntervalMinMs: 2200,
    blinkIntervalMaxMs: 4800,
    blinkIntervalScale: 1.02,
    doubleBlinkProbability: 0.1,
    breathSpeedScale: 1,
    breathAmplitudeScale: 0.92,
    breathBaseline: 0.14,
    breathAmplitude: 0.032,
    recenterBias: 0.75,
    transitionMs: 320,
    quickGlanceChance: 0.05,
    quickGlanceHoldMinMs: 350,
    quickGlanceHoldMaxMs: 600,
    quickGlanceAmplitudeScale: 0.65,
    quickGlanceHeadFollow: 0.22,
    eyeAmplitudeScale: 0.47,
    headAmplitudeScale: 0.41,
    bodyAmplitudeScale: 0.38
  },
  thinking: {
    targetRegionWeights: { center: 0.18, left: 0.17, right: 0.17, upper: 0.42, lower: 0.06 },
    targetHoldMinMs: 1000,
    targetHoldMaxMs: 3000,
    eyeXMax: 0.78,
    eyeYMin: -0.2,
    eyeYMax: 0.52,
    eyeResponseMs: 200,
    headXMax: 9,
    headYMax: 7,
    headZMax: 6,
    headDelayMinMs: 180,
    headDelayMaxMs: 300,
    headResponseMs: 680,
    bodyXMax: 3,
    bodyYMax: 1.8,
    bodyZMax: 4,
    bodyFollowFraction: 0.32,
    bodyDelayMs: 520,
    bodyResponseMs: 1350,
    blinkIntervalMinMs: 1500,
    blinkIntervalMaxMs: 3500,
    blinkIntervalScale: 0.9,
    doubleBlinkProbability: 0.21,
    breathSpeedScale: 0.91,
    breathAmplitudeScale: 1,
    breathBaseline: 0.15,
    breathAmplitude: 0.038,
    recenterBias: 0.04,
    transitionMs: 520,
    quickGlanceChance: 0.25,
    quickGlanceHoldMinMs: 400,
    quickGlanceHoldMaxMs: 850,
    quickGlanceAmplitudeScale: 0.98,
    quickGlanceHeadFollow: 0.36,
    eyeAmplitudeScale: 1.08,
    headAmplitudeScale: 0.82,
    bodyAmplitudeScale: 0.75
  },
  speaking: {
    targetRegionWeights: { center: 0.52, left: 0.18, right: 0.18, upper: 0.09, lower: 0.03 },
    targetHoldMinMs: 1100,
    targetHoldMaxMs: 2900,
    eyeXMax: 0.5,
    eyeYMin: -0.15,
    eyeYMax: 0.27,
    eyeResponseMs: 220,
    headXMax: 6.5,
    headYMax: 3.5,
    headZMax: 2.8,
    headDelayMinMs: 160,
    headDelayMaxMs: 260,
    headResponseMs: 590,
    bodyXMax: 2.2,
    bodyYMax: 1.2,
    bodyZMax: 1.8,
    bodyFollowFraction: 0.3,
    bodyDelayMs: 400,
    bodyResponseMs: 1200,
    blinkIntervalMinMs: 1900,
    blinkIntervalMaxMs: 4100,
    blinkIntervalScale: 1.02,
    doubleBlinkProbability: 0.14,
    breathSpeedScale: 1.04,
    breathAmplitudeScale: 0.95,
    breathBaseline: 0.14,
    breathAmplitude: 0.035,
    recenterBias: 0.18,
    transitionMs: 380,
    quickGlanceChance: 0.12,
    quickGlanceHoldMinMs: 350,
    quickGlanceHoldMaxMs: 650,
    quickGlanceAmplitudeScale: 0.75,
    quickGlanceHeadFollow: 0.28,
    eyeAmplitudeScale: 0.69,
    headAmplitudeScale: 0.59,
    bodyAmplitudeScale: 0.55
  },
  interrupted: {
    targetRegionWeights: { center: 1, left: 0, right: 0, upper: 0, lower: 0 },
    targetHoldMinMs: 900,
    targetHoldMaxMs: 1400,
    eyeXMax: 0.08,
    eyeYMin: -0.04,
    eyeYMax: 0.06,
    eyeResponseMs: 220,
    headXMax: 1.2,
    headYMax: 0.8,
    headZMax: 0.6,
    headDelayMinMs: 0,
    headDelayMaxMs: 0,
    headResponseMs: 320,
    bodyXMax: 0.8,
    bodyYMax: 0.5,
    bodyZMax: 0.6,
    bodyFollowFraction: 0.2,
    bodyDelayMs: 0,
    bodyResponseMs: 520,
    blinkIntervalMinMs: 2000,
    blinkIntervalMaxMs: 4800,
    blinkIntervalScale: 1,
    doubleBlinkProbability: 0,
    breathSpeedScale: 0.92,
    breathAmplitudeScale: 0.75,
    breathBaseline: 0.1,
    breathAmplitude: 0.02,
    recenterBias: 1,
    transitionMs: 220,
    quickGlanceChance: 0,
    quickGlanceHoldMinMs: 300,
    quickGlanceHoldMaxMs: 400,
    quickGlanceAmplitudeScale: 0.4,
    quickGlanceHeadFollow: 0.15,
    eyeAmplitudeScale: 0.12,
    headAmplitudeScale: 0.12,
    bodyAmplitudeScale: 0.15
  }
};

export type PresenceBehaviorSnapshot = {
  activeState: CompanionPresenceState;
  previousState: CompanionPresenceState;
  transitionProgress: number;
  effective: PresenceBehaviorProfile;
  lastPresenceTransitionAt: number;
  effectiveTransitionMs: number;
};

export type PresenceBehaviorTransition = {
  sample(
    state: CompanionPresenceState,
    deltaMilliseconds: number,
    nowMilliseconds?: number
  ): PresenceBehaviorSnapshot;
  reset(state?: CompanionPresenceState): void;
  getDebug(): PresenceBehaviorSnapshot;
};

export function createPresenceBehaviorTransition(
  initialState: CompanionPresenceState = "idle"
): PresenceBehaviorTransition {
  let activeState = initialState;
  let previousState = initialState;
  let from = cloneProfile(PRESENCE_BEHAVIOR_PROFILES[initialState]);
  let target = cloneProfile(from);
  let effective = cloneProfile(from);
  let progress = 1;
  let transitionClock = 0;
  let lastPresenceTransitionAt = 0;
  let activeTransitionMs = Math.max(1, target.transitionMs);

  function sample(
    state: CompanionPresenceState,
    deltaMilliseconds: number,
    nowMilliseconds = transitionClock
  ): PresenceBehaviorSnapshot {
    const delta = clampNonNegative(deltaMilliseconds);
    transitionClock += delta;
    if (state !== activeState) {
      previousState = activeState;
      activeState = state;
      from = cloneProfile(effective);
      target = cloneProfile(PRESENCE_BEHAVIOR_PROFILES[state]);
      activeTransitionMs = Math.max(1, target.transitionMs);
      progress = 0;
      lastPresenceTransitionAt = Number.isFinite(nowMilliseconds)
        ? Math.max(0, nowMilliseconds)
        : transitionClock;
    }
    if (progress < 1) {
      progress = Math.min(1, progress + delta / activeTransitionMs);
      effective = progress >= 1 ? cloneProfile(target) : interpolateProfile(from, target, progress);
    }
    return snapshot();
  }

  function snapshot(): PresenceBehaviorSnapshot {
    return {
      activeState,
      previousState,
      transitionProgress: progress,
      effective: cloneProfile(effective),
      lastPresenceTransitionAt,
      effectiveTransitionMs: activeTransitionMs
    };
  }

  return {
    sample,
    reset(state = "idle") {
      activeState = state;
      previousState = state;
      from = cloneProfile(PRESENCE_BEHAVIOR_PROFILES[state]);
      target = cloneProfile(from);
      effective = cloneProfile(from);
      progress = 1;
      transitionClock = 0;
      lastPresenceTransitionAt = 0;
      activeTransitionMs = Math.max(1, target.transitionMs);
    },
    getDebug: snapshot
  };
}

export function getPresenceBehaviorProfile(state: CompanionPresenceState): PresenceBehaviorProfile {
  return cloneProfile(PRESENCE_BEHAVIOR_PROFILES[state]);
}

export type CompanionPresenceEvent =
  | { type: "turn-start"; epoch: string }
  | { type: "interaction"; state: "listening" | "idle"; epoch?: string }
  | { type: "generation"; epoch: string; state: CompanionGenerationState }
  | { type: "queue"; epoch: string; state: SpeechQueueState }
  | {
      type: "playback";
      epoch: string;
      state: "started" | "ended" | "stopped" | "error";
    }
  | { type: "speech-cancelled"; epoch: string }
  | { type: "connectivity"; state: CompanionPresenceConnectivity }
  | { type: "disconnect"; state: "reconnecting" | "offline" }
  | {
      type: "capability";
      capability: keyof CompanionPresenceCapabilities;
      state: CompanionPresenceCapabilityState;
    }
  | { type: "transition-expired"; epoch: string };

/**
 * The single UI-facing Presence projection owner for the companion path.
 *
 * Request ids are the current web-side turn epochs. Generation terminality is
 * intentionally separate from speech playback: a completed response may
 * still have queued or active audio. Queue `playing` means that playback was
 * scheduled, not that media has actually started; only playbackStarted maps to
 * visible speech.
 */
export function reduceCompanionPresence(
  current: CompanionPresenceProjection,
  event: CompanionPresenceEvent
): CompanionPresenceProjection {
  switch (event.type) {
    case "turn-start":
      return reduceTurnStart(current, event.epoch);
    case "interaction":
      return reduceInteraction(current, event);
    case "generation":
      return reduceGeneration(current, event);
    case "queue":
      return reduceQueue(current, event);
    case "playback":
      return reducePlayback(current, event);
    case "speech-cancelled":
      return reduceSpeechCancelled(current, event.epoch);
    case "connectivity":
      return { ...current, connectivity: event.state };
    case "disconnect":
      return reduceDisconnect(current, event.state);
    case "capability":
      return {
        ...current,
        capabilities: { ...current.capabilities, [event.capability]: event.state }
      };
    case "transition-expired":
      return current.epoch === event.epoch && current.transition === "interrupted"
        ? { ...current, transition: "none" }
        : current;
  }
}

/**
 * Generation interruption is a resource-cancelling operation, so callers must
 * use the same lifecycle admission rule as the reducer before performing
 * side-effects for it.
 */
export function canInterruptGeneration(
  current: CompanionPresenceProjection,
  epoch: string
): boolean {
  return isCurrentEpoch(current, epoch) && current.lifecycle === "active";
}

function reduceTurnStart(
  current: CompanionPresenceProjection,
  epoch: string
): CompanionPresenceProjection {
  if (!isValidEpoch(epoch) || current.epoch === epoch) return current;
  return {
    ...current,
    epoch,
    lifecycle: "active",
    activity: "thinking",
    speech: "inactive",
    transition: "none"
  };
}

function reduceInteraction(
  current: CompanionPresenceProjection,
  event: Extract<CompanionPresenceEvent, { type: "interaction" }>
): CompanionPresenceProjection {
  if (event.epoch && !isCurrentEpoch(current, event.epoch)) return current;
  if (!event.epoch && current.epoch && isInvalidated(current)) return current;
  if (event.state === "listening") {
    return {
      ...current,
      activity: "listening",
      transition: "none"
    };
  }
  return {
    ...current,
    activity: "idle",
    transition: "none"
  };
}

function reduceGeneration(
  current: CompanionPresenceProjection,
  event: Extract<CompanionPresenceEvent, { type: "generation" }>
): CompanionPresenceProjection {
  if (!isCurrentEpoch(current, event.epoch)) return current;

  if (event.state === "interrupted") {
    if (!canInterruptGeneration(current, event.epoch)) return current;
    return {
      ...current,
      lifecycle: "cancelled",
      activity: "idle",
      speech: current.speech === "active" ? current.speech : "cancelled",
      transition: "interrupted"
    };
  }

  if (event.state === "idle") {
    if (current.lifecycle !== "active") return current;
    return {
      ...current,
      lifecycle: "generation-complete",
      activity: "idle",
      transition: "none"
    };
  }

  if (current.lifecycle !== "active") return current;
  return {
    ...current,
    activity: event.state,
    transition: "none"
  };
}

function reduceQueue(
  current: CompanionPresenceProjection,
  event: Extract<CompanionPresenceEvent, { type: "queue" }>
): CompanionPresenceProjection {
  if (!isCurrentEpoch(current, event.epoch)) return current;
  if (isInvalidated(current) && !isQueueTerminal(event.state)) return current;

  switch (event.state) {
    case "synthesizing":
      return { ...current, speech: "preparing" };
    case "playing":
      // Queue scheduling is not actual browser playback.
      return { ...current, speech: "queued" };
    case "stopped":
      return {
        ...current,
        speech: "cancelled",
        transition: current.lifecycle === "invalidated" ? current.transition : "interrupted"
      };
    case "error":
      return { ...current, speech: "error" };
    case "idle":
      if (
        current.speech === "active" ||
        current.speech === "completed" ||
        current.speech === "cancelled" ||
        current.speech === "error"
      ) {
        return current;
      }
      if (current.lifecycle === "cancelled" || current.lifecycle === "invalidated") {
        return current;
      }
      return {
        ...current,
        speech: current.lifecycle === "generation-complete" ? "completed" : "inactive"
      };
  }
}

function reducePlayback(
  current: CompanionPresenceProjection,
  event: Extract<CompanionPresenceEvent, { type: "playback" }>
): CompanionPresenceProjection {
  if (!isCurrentEpoch(current, event.epoch)) return current;

  switch (event.state) {
    case "started":
      if (isInvalidated(current)) return current;
      return { ...current, speech: "active", transition: "none" };
    case "ended":
      return { ...current, speech: "completed" };
    case "stopped":
      return {
        ...current,
        speech: "cancelled",
        transition: current.lifecycle === "invalidated" ? current.transition : "interrupted"
      };
    case "error":
      return { ...current, speech: "error" };
  }
}

function reduceSpeechCancelled(
  current: CompanionPresenceProjection,
  epoch: string
): CompanionPresenceProjection {
  if (!isCurrentEpoch(current, epoch)) return current;
  return {
    ...current,
    speech: "cancelled",
    transition: current.lifecycle === "invalidated" ? current.transition : "interrupted"
  };
}

function reduceDisconnect(
  current: CompanionPresenceProjection,
  state: "reconnecting" | "offline"
): CompanionPresenceProjection {
  if (!current.epoch) {
    return { ...current, connectivity: state, activity: "idle", transition: "none" };
  }
  return {
    ...current,
    lifecycle: "invalidated",
    activity: "idle",
    connectivity: state,
    transition: "none"
  };
}

function isCurrentEpoch(current: CompanionPresenceProjection, epoch: string): boolean {
  return isValidEpoch(epoch) && current.epoch === epoch;
}

function isValidEpoch(epoch: string): boolean {
  return epoch.trim().length > 0;
}

function isInvalidated(current: CompanionPresenceProjection): boolean {
  return current.lifecycle === "cancelled" || current.lifecycle === "invalidated";
}

function isQueueTerminal(state: SpeechQueueState): boolean {
  return state === "idle" || state === "stopped" || state === "error";
}

/**
 * Converts the orthogonal projection into the existing animation vocabulary.
 * This is a derived presentation input, not another product Presence owner.
 */
export function getCompanionPresentationState(
  projection: CompanionPresenceProjection
): CompanionPresentationState {
  if (projection.speech === "active") return "speaking";
  if (projection.transition === "interrupted") return "interrupted";
  if (
    projection.activity === "thinking" ||
    projection.speech === "queued" ||
    projection.speech === "preparing" ||
    projection.speech === "ready"
  ) {
    return "thinking";
  }
  return projection.activity;
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
  blink = 0,
  profile: PresenceBehaviorProfile = PRESENCE_BEHAVIOR_PROFILES[state]
): CompanionAnimationFrame {
  const now = Number.isFinite(nowMilliseconds) ? Math.max(0, nowMilliseconds) : 0;
  const speed = Math.max(0, profile.breathSpeedScale);
  const breathScale = Math.max(0, profile.breathAmplitudeScale);
  const breath =
    profile.breathBaseline * breathScale +
    Math.sin((now / 2600) * Math.PI * 2 * speed) * profile.breathAmplitude * breathScale;
  return {
    blink: state === "interrupted" ? 0 : Math.min(1, Math.max(0, blink)),
    breath: Math.min(1, Math.max(0, breath))
  };
}

/**
 * Central blink configuration. All timing lives here — do not scatter magic
 * numbers across companion-page / Lumi code. Per-state interval/double chance
 * come from PresenceBehaviorProfile.
 */
export const BLINK_CONFIG = {
  /** Fallback ordinary idle gap when a profile omits bounds. */
  minIntervalMs: 1800,
  maxIntervalMs: 4200,
  closeMs: 85,
  holdMs: 55,
  openMs: 120,
  doubleBlinkProbability: 0.16,
  doubleBlinkGapMinMs: 130,
  doubleBlinkGapMaxMs: 240,
  doubleCloseMs: 70,
  doubleHoldMs: 45,
  doubleOpenMs: 100,
  thinkingIntervalScale: 0.9
} as const;

/** @deprecated Prefer BLINK_CONFIG.minIntervalMs */
export const BLINK_MIN_INTERVAL_MS = BLINK_CONFIG.minIntervalMs;
/** @deprecated Prefer BLINK_CONFIG.maxIntervalMs */
export const BLINK_MAX_INTERVAL_MS = BLINK_CONFIG.maxIntervalMs;

export type CompanionBlinkScheduler = {
  sample(
    nowMilliseconds: number,
    presence?: CompanionPresenceState,
    profile?: PresenceBehaviorProfile
  ): number;
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

  function sample(
    nowMilliseconds: number,
    presence: CompanionPresenceState = "idle",
    profile: PresenceBehaviorProfile = PRESENCE_BEHAVIOR_PROFILES[presence]
  ): number {
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

    if (doublePending) {
      doublePending = false;
      activeCloseMs = BLINK_CONFIG.closeMs;
      activeHoldMs = BLINK_CONFIG.holdMs;
      activeOpenMs = BLINK_CONFIG.openMs;
      nextBlinkAt = now + nextInterval(random, presence, profile);
    } else if (random() < Math.max(0, Math.min(1, profile.doubleBlinkProbability))) {
      doublePending = true;
      activeCloseMs = BLINK_CONFIG.doubleCloseMs;
      activeHoldMs = BLINK_CONFIG.doubleHoldMs;
      activeOpenMs = BLINK_CONFIG.doubleOpenMs;
      nextBlinkAt = now + nextDoubleGap(random);
    } else {
      activeCloseMs = BLINK_CONFIG.closeMs;
      activeHoldMs = BLINK_CONFIG.holdMs;
      activeOpenMs = BLINK_CONFIG.openMs;
      nextBlinkAt = now + nextInterval(random, presence, profile);
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
function nextInterval(
  random: () => number,
  presence: CompanionPresenceState,
  profile: PresenceBehaviorProfile = PRESENCE_BEHAVIOR_PROFILES[presence]
): number {
  const a = clamp01(random());
  const b = clamp01(random());
  const normalized = (a + b) / 2;
  const min = Math.max(400, Math.min(profile.blinkIntervalMinMs, profile.blinkIntervalMaxMs));
  const max = Math.max(min, profile.blinkIntervalMaxMs);
  let interval = min + normalized * (max - min);
  if (presence === "thinking") {
    interval *= BLINK_CONFIG.thinkingIntervalScale;
  }
  return interval * Math.max(0.5, profile.blinkIntervalScale);
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

function clampNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function cloneProfile(profile: PresenceBehaviorProfile): PresenceBehaviorProfile {
  return {
    ...profile,
    targetRegionWeights: { ...profile.targetRegionWeights }
  };
}

function interpolateProfile(
  from: PresenceBehaviorProfile,
  target: PresenceBehaviorProfile,
  progress: number
): PresenceBehaviorProfile {
  const t = clamp01(progress);
  const mix = (a: number, b: number) => a + (b - a) * t;
  return {
    targetRegionWeights: {
      center: mix(from.targetRegionWeights.center, target.targetRegionWeights.center),
      left: mix(from.targetRegionWeights.left, target.targetRegionWeights.left),
      right: mix(from.targetRegionWeights.right, target.targetRegionWeights.right),
      upper: mix(from.targetRegionWeights.upper, target.targetRegionWeights.upper),
      lower: mix(from.targetRegionWeights.lower, target.targetRegionWeights.lower)
    },
    targetHoldMinMs: mix(from.targetHoldMinMs, target.targetHoldMinMs),
    targetHoldMaxMs: mix(from.targetHoldMaxMs, target.targetHoldMaxMs),
    eyeXMax: mix(from.eyeXMax, target.eyeXMax),
    eyeYMin: mix(from.eyeYMin, target.eyeYMin),
    eyeYMax: mix(from.eyeYMax, target.eyeYMax),
    eyeResponseMs: mix(from.eyeResponseMs, target.eyeResponseMs),
    headXMax: mix(from.headXMax, target.headXMax),
    headYMax: mix(from.headYMax, target.headYMax),
    headZMax: mix(from.headZMax, target.headZMax),
    headDelayMinMs: mix(from.headDelayMinMs, target.headDelayMinMs),
    headDelayMaxMs: mix(from.headDelayMaxMs, target.headDelayMaxMs),
    headResponseMs: mix(from.headResponseMs, target.headResponseMs),
    bodyXMax: mix(from.bodyXMax, target.bodyXMax),
    bodyYMax: mix(from.bodyYMax, target.bodyYMax),
    bodyZMax: mix(from.bodyZMax, target.bodyZMax),
    bodyFollowFraction: mix(from.bodyFollowFraction, target.bodyFollowFraction),
    bodyDelayMs: mix(from.bodyDelayMs, target.bodyDelayMs),
    bodyResponseMs: mix(from.bodyResponseMs, target.bodyResponseMs),
    blinkIntervalMinMs: mix(from.blinkIntervalMinMs, target.blinkIntervalMinMs),
    blinkIntervalMaxMs: mix(from.blinkIntervalMaxMs, target.blinkIntervalMaxMs),
    blinkIntervalScale: mix(from.blinkIntervalScale, target.blinkIntervalScale),
    doubleBlinkProbability: mix(from.doubleBlinkProbability, target.doubleBlinkProbability),
    breathSpeedScale: mix(from.breathSpeedScale, target.breathSpeedScale),
    breathAmplitudeScale: mix(from.breathAmplitudeScale, target.breathAmplitudeScale),
    breathBaseline: mix(from.breathBaseline, target.breathBaseline),
    breathAmplitude: mix(from.breathAmplitude, target.breathAmplitude),
    recenterBias: mix(from.recenterBias, target.recenterBias),
    transitionMs: mix(from.transitionMs, target.transitionMs),
    quickGlanceChance: mix(from.quickGlanceChance, target.quickGlanceChance),
    quickGlanceHoldMinMs: mix(from.quickGlanceHoldMinMs, target.quickGlanceHoldMinMs),
    quickGlanceHoldMaxMs: mix(from.quickGlanceHoldMaxMs, target.quickGlanceHoldMaxMs),
    quickGlanceAmplitudeScale: mix(
      from.quickGlanceAmplitudeScale,
      target.quickGlanceAmplitudeScale
    ),
    quickGlanceHeadFollow: mix(from.quickGlanceHeadFollow, target.quickGlanceHeadFollow),
    eyeAmplitudeScale: mix(from.eyeAmplitudeScale, target.eyeAmplitudeScale),
    headAmplitudeScale: mix(from.headAmplitudeScale, target.headAmplitudeScale),
    bodyAmplitudeScale: mix(from.bodyAmplitudeScale, target.bodyAmplitudeScale)
  };
}
