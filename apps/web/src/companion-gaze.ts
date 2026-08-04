/**
 * Natural gaze / head / body-follow for the companion (Neuro-leaning presence).
 *
 * Cascade (kept gradual — no hard delay gates):
 *   eye target → eye current (fast)
 *   → head desired from eye current → head current (medium)
 *   → body desired from head current → body current (slow)
 *
 * State envelopes come from PresenceBehaviorProfile absolute peaks so
 * base × scale double-shrink does not mute presence.
 */

import {
  PRESENCE_BEHAVIOR_PROFILES,
  type CompanionAnimationFrame,
  type PresenceBehaviorProfile,
  type PresenceTargetRegionWeights
} from "./companion-presence.js";

/**
 * Region sampling bands (absolute eye targets). Final clamp uses profile peaks.
 */
export const GAZE_REGION_RANGES = {
  center: { x: [-0.12, 0.12] as const, y: [-0.06, 0.12] as const },
  left: { x: [-0.75, -0.45] as const, y: [-0.12, 0.22] as const },
  right: { x: [0.45, 0.75] as const, y: [-0.12, 0.22] as const },
  upper: { x: [-0.5, 0.5] as const, y: [0.3, 0.52] as const },
  lower: { x: [-0.35, 0.35] as const, y: [-0.3, -0.18] as const }
} as const;

/** Fallbacks / diagnostics only — mapping prefers profile absolute peaks. */
export const GAZE_CONFIG = {
  eyeXRange: [-0.78, 0.78] as const,
  eyeYRange: [-0.3, 0.52] as const,
  holdMinMs: 1200,
  holdMaxMs: 3600,
  eyeResponseMs: 200,
  headAngleXMax: 11,
  headAngleYMax: 7,
  headAngleZMax: 6,
  headResponseMs: 540,
  headReturnResponseMs: 700,
  headXGain: 1,
  headYGain: 1,
  headZGain: 1,
  bodyFollowFraction: 0.34,
  bodyResponseMs: 1150,
  bodyReturnResponseMs: 1450,
  bodyAngleXMax: 4,
  bodyAngleYMax: 2,
  bodyAngleZMax: 3,
  maxFrameDeltaMs: 100,
  headDelayMinMs: 0,
  headDelayMaxMs: 0,
  bodyDelayMinMs: 0,
  bodyDelayMaxMs: 0,
  sessionSideBiasMax: 0.06,
  headZBiasMaxFraction: 0.1
} as const;

export type GazeTargetRegion = "center" | "left" | "right" | "upper" | "lower";
export type GazeTargetKind = "hold" | "quickGlance" | "recenter";

export type GazeFrame = {
  running: boolean;
  disposed: boolean;
  elapsedMs: number;
  frameDeltaMs: number;
  targetX: number;
  targetY: number;
  currentX: number;
  currentY: number;
  targetRegion: GazeTargetRegion;
  targetKind: GazeTargetKind;
  holdUntil: number;
  nextTargetAt: number;
  headTargetX: number;
  headTargetY: number;
  headTargetZ: number;
  headCurrentX: number;
  headCurrentY: number;
  headCurrentZ: number;
  headDelayUntil: number;
  bodyTargetX: number;
  bodyTargetY: number;
  bodyTargetZ: number;
  bodyCurrentX: number;
  bodyCurrentY: number;
  bodyCurrentZ: number;
  bodyDelayUntil: number;
  quickGlanceActive: boolean;
  sessionSideBias: number;
  headZBias: number;
  /** Peak |values| observed this scheduler lifetime (actual envelope). */
  actualEyeEnvelope: { x: number; y: number };
  actualHeadEnvelope: { x: number; y: number; z: number };
  actualBodyEnvelope: { x: number; y: number; z: number };
};

export type CompanionPresenceOutput = CompanionAnimationFrame & {
  eyeBallX: number;
  eyeBallY: number;
  headAngleX: number;
  headAngleY: number;
  headAngleZ: number;
  bodyAngleX: number;
  bodyAngleY: number;
  bodyAngleZ: number;
};

export function composeCompanionPresenceAnimation(
  animation: CompanionAnimationFrame,
  gaze: GazeFrame,
  forceGaze = false
): CompanionPresenceOutput {
  if (forceGaze) {
    return {
      blink: animation.blink,
      breath: animation.breath,
      eyeBallX: 1,
      eyeBallY: 0.5,
      headAngleX: 20,
      headAngleY: 10,
      headAngleZ: 8,
      bodyAngleX: 6,
      bodyAngleY: 3,
      bodyAngleZ: 4
    };
  }
  return {
    blink: animation.blink,
    breath: animation.breath,
    eyeBallX: gaze.currentX,
    eyeBallY: gaze.currentY,
    headAngleX: gaze.headCurrentX,
    headAngleY: gaze.headCurrentY,
    headAngleZ: gaze.headCurrentZ,
    bodyAngleX: gaze.bodyCurrentX,
    bodyAngleY: gaze.bodyCurrentY,
    bodyAngleZ: gaze.bodyCurrentZ
  };
}

export type GazeScheduler = {
  sample(nowMilliseconds: number, interrupted?: boolean): GazeFrame;
  sample(
    nowMilliseconds: number,
    deltaMilliseconds: number,
    interrupted?: boolean,
    profile?: PresenceBehaviorProfile
  ): GazeFrame;
  reset(nowMilliseconds?: number): void;
  dispose(): void;
  isDisposed(): boolean;
  getDebug(): GazeFrame;
};

export function mapEyeToHeadAngle(
  eyeValue: number,
  eyeRange: readonly [number, number],
  headMax: number,
  gain = 1
): number {
  const eyeAbsMax = Math.max(Math.abs(eyeRange[0]), Math.abs(eyeRange[1]), 1e-6);
  const safeEye = Number.isFinite(eyeValue) ? eyeValue : 0;
  const normalized = clamp(safeEye / eyeAbsMax, -1, 1);
  const safeGain = Number.isFinite(gain) ? Math.max(0, gain) : 1;
  const safeMax = Number.isFinite(headMax) ? Math.max(0, headMax) : 0;
  return clamp(normalized * safeMax * safeGain, -safeMax, safeMax);
}

export function mapHeadToBodyAngle(
  headAngle: number,
  followFraction: number,
  bodyMax: number
): number {
  const safeHead = Number.isFinite(headAngle) ? headAngle : 0;
  const fraction = Number.isFinite(followFraction) ? Math.max(0, Math.min(1, followFraction)) : 0;
  const safeMax = Number.isFinite(bodyMax) ? Math.max(0, bodyMax) : 0;
  return clamp(safeHead * fraction, -safeMax, safeMax);
}

export function normalizeTargetRegionWeights(
  weights: PresenceTargetRegionWeights
): PresenceTargetRegionWeights {
  const safe = {
    center: finiteNonNegative(weights.center),
    left: finiteNonNegative(weights.left),
    right: finiteNonNegative(weights.right),
    upper: finiteNonNegative(weights.upper),
    lower: finiteNonNegative(weights.lower)
  };
  const total = safe.center + safe.left + safe.right + safe.upper + safe.lower;
  if (total <= 0) return { center: 1, left: 0, right: 0, upper: 0, lower: 0 };
  return {
    center: safe.center / total,
    left: safe.left / total,
    right: safe.right / total,
    upper: safe.upper / total,
    lower: safe.lower / total
  };
}

export type SelectedGazeTarget = {
  region: GazeTargetRegion;
  x: number;
  y: number;
  kind: GazeTargetKind;
  headFollowScale: number;
  bodyFollowEnabled: boolean;
  holdMs: number;
};

/** Select one target from a profile; randomness is sampled only on retarget. */
export function selectNextTarget(
  profile: PresenceBehaviorProfile,
  random: () => number,
  options: {
    sessionSideBias?: number;
    allowQuickGlance?: boolean;
    lastWasQuickGlance?: boolean;
    lastExtremeRegion?: GazeTargetRegion | null;
  } = {}
): SelectedGazeTarget {
  const sessionSideBias = clamp(
    options.sessionSideBias ?? 0,
    -GAZE_CONFIG.sessionSideBiasMax,
    GAZE_CONFIG.sessionSideBiasMax
  );
  const weights = normalizeTargetRegionWeights(applyRecenterBias(profile));
  const wantQuick =
    options.allowQuickGlance !== false &&
    !options.lastWasQuickGlance &&
    profile.quickGlanceChance > 0 &&
    random() < profile.quickGlanceChance;

  const roll = clamp01(random());
  let edge = weights.center;
  let region: GazeTargetRegion = "center";
  if (roll >= edge) {
    edge += weights.left;
    if (roll < edge) region = "left";
    else {
      edge += weights.right;
      if (roll < edge) region = "right";
      else {
        edge += weights.upper;
        region = roll < edge ? "upper" : "lower";
      }
    }
  }

  // Avoid repeating the same extreme region twice in a row.
  if (
    region !== "center" &&
    region === options.lastExtremeRegion &&
    !wantQuick
  ) {
    region = "center";
  }

  const band = GAZE_REGION_RANGES[region];
  const xRoll = clamp01(random());
  const yRoll = clamp01(random());
  let x = lerp(band.x[0], band.x[1], xRoll);
  let y = lerp(band.y[0], band.y[1], yRoll);

  // Soft session asymmetry (±6%) on horizontal targets.
  x *= 1 + sessionSideBias * (region === "left" || region === "right" || region === "upper" ? 1 : 0.4);

  const eyeXMax = Math.max(0.05, profile.eyeXMax);
  const eyeYMin = Math.min(0, profile.eyeYMin);
  const eyeYMax = Math.max(0, profile.eyeYMax);
  x = clamp(x, -eyeXMax, eyeXMax);
  y = clamp(y, eyeYMin, eyeYMax);

  if (wantQuick) {
    const glanceScale = Math.max(0.4, profile.quickGlanceAmplitudeScale);
    x = clamp(x * glanceScale, -eyeXMax, eyeXMax);
    y = clamp(y * glanceScale, eyeYMin, eyeYMax);
    const holdMin = Math.max(120, Math.min(profile.quickGlanceHoldMinMs, profile.quickGlanceHoldMaxMs));
    const holdMax = Math.max(holdMin, profile.quickGlanceHoldMaxMs);
    return {
      region,
      x,
      y,
      kind: "quickGlance",
      headFollowScale: clamp(profile.quickGlanceHeadFollow, 0.15, 0.45),
      bodyFollowEnabled: false,
      holdMs: lerp(holdMin, holdMax, clamp01(random()))
    };
  }

  const holdMin = Math.max(200, Math.min(profile.targetHoldMinMs, profile.targetHoldMaxMs));
  const holdMax = Math.max(holdMin, profile.targetHoldMaxMs);
  return {
    region,
    x,
    y,
    kind: "hold",
    headFollowScale: 1,
    bodyFollowEnabled: true,
    holdMs: lerp(holdMin, holdMax, (clamp01(random()) + clamp01(random())) / 2)
  };
}

export function smoothTowards(
  current: number,
  target: number,
  deltaMilliseconds: number,
  responseMilliseconds: number,
  maxDeltaMilliseconds = GAZE_CONFIG.maxFrameDeltaMs
): number {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeTarget = Number.isFinite(target) ? target : 0;
  const dt = Math.min(
    Math.max(0, Number.isFinite(deltaMilliseconds) ? deltaMilliseconds : 0),
    Math.max(1, maxDeltaMilliseconds)
  );
  const response = Math.max(1, Number.isFinite(responseMilliseconds) ? responseMilliseconds : 1);
  const alpha = 1 - Math.exp(-dt / response);
  return safeCurrent + (safeTarget - safeCurrent) * alpha;
}

export function createGazeScheduler(
  random: () => number = Math.random,
  _initialNowMilliseconds = 0
): GazeScheduler {
  let disposed = false;
  let initialized = false;
  let elapsedMs = 0;
  let lastWallNow = Number.NaN;
  let currentX = 0;
  let currentY = 0;
  let headCurrentX = 0;
  let headCurrentY = 0;
  let headCurrentZ = 0;
  let bodyCurrentX = 0;
  let bodyCurrentY = 0;
  let bodyCurrentZ = 0;
  let targetX = 0;
  let targetY = 0;
  let targetRegion: GazeTargetRegion = "center";
  let targetKind: GazeTargetKind = "hold";
  let headFollowScale = 1;
  let bodyFollowEnabled = true;
  let holdUntil = 0;
  let headTargetX = 0;
  let headTargetY = 0;
  let headTargetZ = 0;
  let bodyTargetX = 0;
  let bodyTargetY = 0;
  let bodyTargetZ = 0;
  let previousInterrupted = false;
  let lastExtremeRegion: GazeTargetRegion | null = null;
  let lastWasQuickGlance = false;
  let lastFrameDeltaMs = 0;
  // Deterministic per-scheduler bias from the injected RNG (fixed random tests stay stable).
  const sessionSideBias = (clamp01(random()) - 0.5) * 2 * GAZE_CONFIG.sessionSideBiasMax;
  const headZBias =
    (clamp01(random()) - 0.5) * 2 * GAZE_CONFIG.headZBiasMaxFraction;
  let peakEyeX = 0;
  let peakEyeY = 0;
  let peakHeadX = 0;
  let peakHeadY = 0;
  let peakHeadZ = 0;
  let peakBodyX = 0;
  let peakBodyY = 0;
  let peakBodyZ = 0;

  function chooseTarget(atElapsed: number, profile: PresenceBehaviorProfile): void {
    const selected = selectNextTarget(profile, random, {
      sessionSideBias,
      allowQuickGlance: true,
      lastWasQuickGlance,
      lastExtremeRegion
    });
    targetX = selected.x;
    targetY = selected.y;
    targetRegion = selected.region;
    targetKind = selected.kind;
    headFollowScale = selected.headFollowScale;
    bodyFollowEnabled = selected.bodyFollowEnabled;
    holdUntil = atElapsed + selected.holdMs;
    lastWasQuickGlance = selected.kind === "quickGlance";
    if (selected.region === "left" || selected.region === "right" || selected.region === "upper") {
      lastExtremeRegion = selected.region;
    } else if (selected.region === "lower") {
      lastExtremeRegion = "lower";
    } else {
      lastExtremeRegion = null;
    }
  }

  function resolveArgs(
    nowMilliseconds: number,
    second?: number | boolean,
    third?: boolean
  ): { delta: number; interrupted: boolean; wallNow: number } {
    const wallNow = sanitizeNow(nowMilliseconds);
    if (typeof second === "boolean" || second === undefined) {
      const interrupted = Boolean(second);
      let delta = 0;
      if (Number.isFinite(lastWallNow)) {
        delta = Math.max(0, wallNow - lastWallNow);
      }
      lastWallNow = wallNow;
      return { delta, interrupted, wallNow };
    }
    const delta = Math.max(0, Number.isFinite(second) ? second : 0);
    const interrupted = Boolean(third);
    lastWallNow = wallNow;
    return { delta, interrupted, wallNow };
  }

  function sample(
    nowMilliseconds: number,
    second?: number | boolean,
    third?: boolean,
    providedProfile?: PresenceBehaviorProfile
  ): GazeFrame {
    const { delta, interrupted } = resolveArgs(nowMilliseconds, second, third);
    const frameDelta = Math.min(delta, GAZE_CONFIG.maxFrameDeltaMs);
    lastFrameDeltaMs = frameDelta;
    const profile = providedProfile ?? PRESENCE_BEHAVIOR_PROFILES.idle;

    if (disposed) {
      return frame(false);
    }

    if (!initialized) {
      initialized = true;
      elapsedMs = 0;
      targetX = 0;
      targetY = 0;
      targetRegion = "center";
      targetKind = "hold";
      headFollowScale = 1;
      bodyFollowEnabled = true;
      holdUntil = elapsedMs + sampleHold(random, profile);
      headTargetX = 0;
      headTargetY = 0;
      headTargetZ = 0;
      bodyTargetX = 0;
      bodyTargetY = 0;
      bodyTargetZ = 0;
    } else {
      elapsedMs += frameDelta;
    }

    if (interrupted) {
      targetX = 0;
      targetY = 0;
      targetRegion = "center";
      targetKind = "recenter";
      headFollowScale = 1;
      bodyFollowEnabled = true;
      holdUntil = elapsedMs + Math.max(200, profile.targetHoldMaxMs);
      previousInterrupted = true;
    } else {
      if (previousInterrupted) {
        previousInterrupted = false;
        holdUntil = elapsedMs;
      }
      if (elapsedMs >= holdUntil) {
        chooseTarget(elapsedMs, profile);
      }
    }

    // --- Continuous cascade (gradual, no hard gates) ------------------------
    currentX = smoothTowards(currentX, targetX, frameDelta, profile.eyeResponseMs);
    currentY = smoothTowards(currentY, targetY, frameDelta, profile.eyeResponseMs);

    const eyeRangeX: [number, number] = [-profile.eyeXMax, profile.eyeXMax];
    const eyeRangeY: [number, number] = [profile.eyeYMin, profile.eyeYMax];
    const eyeForHeadX = currentX * headFollowScale;
    const eyeForHeadY = currentY * headFollowScale;

    const desiredHeadX = mapEyeToHeadAngle(
      eyeForHeadX,
      eyeRangeX,
      profile.headXMax,
      GAZE_CONFIG.headXGain
    );
    const desiredHeadY = mapEyeToHeadAngle(
      eyeForHeadY,
      eyeRangeY,
      profile.headYMax,
      GAZE_CONFIG.headYGain
    );
    const zBiasScale = 1 + headZBias;
    const desiredHeadZ = mapEyeToHeadAngle(
      eyeForHeadX,
      eyeRangeX,
      profile.headZMax * zBiasScale,
      GAZE_CONFIG.headZGain
    );
    headTargetX = desiredHeadX;
    headTargetY = desiredHeadY;
    headTargetZ = desiredHeadZ;

    const headReturning =
      Math.hypot(desiredHeadX, desiredHeadY) + 1e-6 < Math.hypot(headCurrentX, headCurrentY);
    const softHeadDelay = (profile.headDelayMinMs + profile.headDelayMaxMs) / 2;
    // interrupted uses snappy return (~260–380ms effective)
    const headResponse = interrupted
      ? Math.min(profile.headResponseMs, 340)
      : headReturning
        ? profile.headResponseMs * 1.35 + softHeadDelay * 0.35
        : profile.headResponseMs + softHeadDelay * 0.25;
    headCurrentX = smoothTowards(headCurrentX, desiredHeadX, frameDelta, headResponse);
    headCurrentY = smoothTowards(headCurrentY, desiredHeadY, frameDelta, headResponse);
    headCurrentZ = smoothTowards(headCurrentZ, desiredHeadZ, frameDelta, headResponse);

    const followFraction = bodyFollowEnabled ? Math.max(0, profile.bodyFollowFraction) : 0;
    const desiredBodyX = mapHeadToBodyAngle(headCurrentX, followFraction, profile.bodyXMax);
    const desiredBodyY = mapHeadToBodyAngle(headCurrentY, followFraction, profile.bodyYMax);
    const desiredBodyZ = mapHeadToBodyAngle(headCurrentZ, followFraction, profile.bodyZMax);
    bodyTargetX = desiredBodyX;
    bodyTargetY = desiredBodyY;
    bodyTargetZ = desiredBodyZ;

    const bodyReturning =
      Math.hypot(desiredBodyX, desiredBodyY) + 1e-6 < Math.hypot(bodyCurrentX, bodyCurrentY);
    const bodyResponse = interrupted
      ? Math.min(profile.bodyResponseMs, 560)
      : bodyReturning
        ? profile.bodyResponseMs * 1.25 + profile.bodyDelayMs * 0.35
        : profile.bodyResponseMs + profile.bodyDelayMs * 0.25;
    bodyCurrentX = smoothTowards(bodyCurrentX, desiredBodyX, frameDelta, bodyResponse);
    bodyCurrentY = smoothTowards(bodyCurrentY, desiredBodyY, frameDelta, bodyResponse);
    bodyCurrentZ = smoothTowards(bodyCurrentZ, desiredBodyZ, frameDelta, bodyResponse);

    peakEyeX = Math.max(peakEyeX, Math.abs(currentX));
    peakEyeY = Math.max(peakEyeY, Math.abs(currentY));
    peakHeadX = Math.max(peakHeadX, Math.abs(headCurrentX));
    peakHeadY = Math.max(peakHeadY, Math.abs(headCurrentY));
    peakHeadZ = Math.max(peakHeadZ, Math.abs(headCurrentZ));
    peakBodyX = Math.max(peakBodyX, Math.abs(bodyCurrentX));
    peakBodyY = Math.max(peakBodyY, Math.abs(bodyCurrentY));
    peakBodyZ = Math.max(peakBodyZ, Math.abs(bodyCurrentZ));

    return frame(true);
  }

  function frame(running: boolean): GazeFrame {
    return {
      running: running && !disposed,
      disposed,
      elapsedMs,
      frameDeltaMs: lastFrameDeltaMs,
      targetX,
      targetY,
      currentX: disposed ? 0 : currentX,
      currentY: disposed ? 0 : currentY,
      targetRegion,
      targetKind,
      holdUntil,
      nextTargetAt: holdUntil,
      headTargetX,
      headTargetY,
      headTargetZ,
      headCurrentX: disposed ? 0 : headCurrentX,
      headCurrentY: disposed ? 0 : headCurrentY,
      headCurrentZ: disposed ? 0 : headCurrentZ,
      headDelayUntil: 0,
      bodyTargetX,
      bodyTargetY,
      bodyTargetZ,
      bodyCurrentX: disposed ? 0 : bodyCurrentX,
      bodyCurrentY: disposed ? 0 : bodyCurrentY,
      bodyCurrentZ: disposed ? 0 : bodyCurrentZ,
      bodyDelayUntil: 0,
      quickGlanceActive: targetKind === "quickGlance",
      sessionSideBias,
      headZBias,
      actualEyeEnvelope: { x: peakEyeX, y: peakEyeY },
      actualHeadEnvelope: { x: peakHeadX, y: peakHeadY, z: peakHeadZ },
      actualBodyEnvelope: { x: peakBodyX, y: peakBodyY, z: peakBodyZ }
    };
  }

  return {
    sample,
    reset(nowMilliseconds = 0) {
      disposed = false;
      initialized = false;
      elapsedMs = 0;
      lastWallNow = sanitizeNow(nowMilliseconds);
      currentX = 0;
      currentY = 0;
      headCurrentX = 0;
      headCurrentY = 0;
      headCurrentZ = 0;
      bodyCurrentX = 0;
      bodyCurrentY = 0;
      bodyCurrentZ = 0;
      targetX = 0;
      targetY = 0;
      targetRegion = "center";
      targetKind = "hold";
      headFollowScale = 1;
      bodyFollowEnabled = true;
      holdUntil = 0;
      headTargetX = 0;
      headTargetY = 0;
      headTargetZ = 0;
      bodyTargetX = 0;
      bodyTargetY = 0;
      bodyTargetZ = 0;
      previousInterrupted = false;
      lastExtremeRegion = null;
      lastWasQuickGlance = false;
      lastFrameDeltaMs = 0;
      peakEyeX = 0;
      peakEyeY = 0;
      peakHeadX = 0;
      peakHeadY = 0;
      peakHeadZ = 0;
      peakBodyX = 0;
      peakBodyY = 0;
      peakBodyZ = 0;
    },
    dispose() {
      disposed = true;
      holdUntil = Number.POSITIVE_INFINITY;
      targetX = 0;
      targetY = 0;
      currentX = 0;
      currentY = 0;
      headTargetX = 0;
      headTargetY = 0;
      headTargetZ = 0;
      headCurrentX = 0;
      headCurrentY = 0;
      headCurrentZ = 0;
      bodyTargetX = 0;
      bodyTargetY = 0;
      bodyTargetZ = 0;
      bodyCurrentX = 0;
      bodyCurrentY = 0;
      bodyCurrentZ = 0;
    },
    isDisposed() {
      return disposed;
    },
    getDebug() {
      return frame(!disposed && initialized);
    }
  };
}

function sampleHold(
  random: () => number,
  profile: PresenceBehaviorProfile = PRESENCE_BEHAVIOR_PROFILES.idle
): number {
  const a = clamp01(random());
  const b = clamp01(random());
  const min = Math.max(0, Math.min(profile.targetHoldMinMs, profile.targetHoldMaxMs));
  const max = Math.max(min, profile.targetHoldMaxMs);
  return lerp(min, max, (a + b) / 2);
}

function sanitizeNow(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function lerp(min: number, max: number, value: number): number {
  return min + (max - min) * clamp01(value);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function applyRecenterBias(profile: PresenceBehaviorProfile): PresenceTargetRegionWeights {
  const bias = clamp01(profile.recenterBias);
  const weights = profile.targetRegionWeights;
  const center = finiteNonNegative(weights.center) * (1 + bias);
  const nonCenterScale = Math.max(0, 1 - bias * 0.55);
  return {
    center,
    left: finiteNonNegative(weights.left) * nonCenterScale,
    right: finiteNonNegative(weights.right) * nonCenterScale,
    upper: finiteNonNegative(weights.upper) * nonCenterScale,
    lower: finiteNonNegative(weights.lower) * nonCenterScale
  };
}
