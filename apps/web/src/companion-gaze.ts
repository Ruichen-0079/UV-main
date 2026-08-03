/**
 * Natural gaze / head / body-follow for the companion (Neuro-leaning presence).
 *
 * The scheduler owns eye-ball, head, and soft body targets. Blink/breath remain
 * in companion-presence.ts and the mouth remains exclusively audio controlled.
 *
 * Time base is monotically accumulated from frame deltas (not absolute wall
 * clocks) so hold timers stay correct even if rAF timestamps and
 * performance.now() origins ever disagree.
 *
 * Motion is a continuous cascade (no hard delay gates):
 *   eye target → eye current (fast)
 *   → head desired from eye current → head current (medium)
 *   → body desired from head current → body current (slow)
 * Each stage only uses exponential smoothing, so lag feels gradual rather than
 * "wait then snap".
 */

/**
 * Eyes lead, head follows, body lags furthest.
 *
 * Head angles normalize eye values against the eye range once (no double-shrink).
 * Body follows the live head pose only — never an independent random walk.
 */
export const GAZE_CONFIG = {
  /** ParamEyeBallX (Cubism typically [-1, 1]). */
  eyeXRange: [-0.92, 0.92] as const,
  /** ParamEyeBallY — strong up/down presence. */
  eyeYRange: [-0.5, 0.55] as const,
  /** Longer holds = slightly lower retarget frequency. */
  holdMinMs: 1700,
  holdMaxMs: 5000,
  centerProbability: 0.32,
  leftProbability: 0.22,
  rightProbability: 0.22,
  /** Explicit look-up / look-down share of holds. */
  verticalProbability: 0.24,
  /** Fast eyes. */
  eyeResponseMs: 200,
  /** ParamAngleX degrees at full horizontal eye extreme. */
  headAngleXMax: 18,
  /** ParamAngleY degrees at full vertical eye extreme. */
  headAngleYMax: 12,
  /** ParamAngleZ degrees at full horizontal eye extreme. */
  headAngleZMax: 7.5,
  /**
   * Head eases toward the angle mapped from the *live* eye pose.
   * Larger than eyeResponse so the cascade is continuous, not gated.
   */
  headResponseMs: 480,
  headReturnResponseMs: 700,
  /** Single post-normalize scale; 1 = head reaches headAngle*Max at eye extreme. */
  headXGain: 1,
  headYGain: 1,
  headZGain: 1,
  /**
   * Body follows live head current at this fraction, then soft-clamped.
   */
  bodyFollowFraction: 0.4,
  bodyResponseMs: 980,
  bodyReturnResponseMs: 1300,
  bodyAngleXMax: 6.5,
  bodyAngleYMax: 4.2,
  bodyAngleZMax: 4,
  maxFrameDeltaMs: 100,
  /**
   * Soft phase constants retained for diagnostics / API stability.
   * Cascade uses response times instead of hard delay gates.
   */
  headDelayMinMs: 0,
  headDelayMaxMs: 0,
  bodyDelayMinMs: 0,
  bodyDelayMaxMs: 0
} as const;

export type GazeTargetRegion = "center" | "left" | "right" | "vertical";

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
  /** Absolute scheduler time (elapsedMs) when the current hold ends. */
  holdUntil: number;
  /** Alias for diagnostics that expect nextTargetAt. */
  nextTargetAt: number;
  headTargetX: number;
  headTargetY: number;
  headTargetZ: number;
  headCurrentX: number;
  headCurrentY: number;
  headCurrentZ: number;
  /** Always 0 in cascade mode (no hard head gate). */
  headDelayUntil: number;
  bodyTargetX: number;
  bodyTargetY: number;
  bodyTargetZ: number;
  bodyCurrentX: number;
  bodyCurrentY: number;
  bodyCurrentZ: number;
  /** Always 0 in cascade mode (no hard body gate). */
  bodyDelayUntil: number;
};

export type GazeScheduler = {
  /**
   * Advance the scheduler.
   * Prefer (nowMs, interrupted) — delta is derived from the previous sample.
   * (nowMs, deltaMs, interrupted) is also accepted for explicit dt injection.
   */
  sample(nowMilliseconds: number, interrupted?: boolean): GazeFrame;
  sample(nowMilliseconds: number, deltaMilliseconds: number, interrupted?: boolean): GazeFrame;
  reset(nowMilliseconds?: number): void;
  dispose(): void;
  isDisposed(): boolean;
  getDebug(): GazeFrame;
};

/**
 * Map an eye-ball value into a head angle (degrees).
 *
 * Normalize by the configured eye range so a full eye extreme reaches
 * `headMax * gain` degrees. Multiplying raw eye values by `headMax * gain`
 * without normalizing double-shrinks (e.g. 0.32×5×0.85≈1.4°).
 */
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

/**
 * Body follows the head pose at a fixed fraction, then soft-clamped.
 * No independent random body target.
 */
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

/** Frame-rate independent exponential smoothing with a bounded frame step. */
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
  /** Monotonic scheduler clock in ms since first sample (or last reset). */
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
  let holdUntil = sampleHold(random);
  let headTargetX = 0;
  let headTargetY = 0;
  let headTargetZ = 0;
  let bodyTargetX = 0;
  let bodyTargetY = 0;
  let bodyTargetZ = 0;
  let previousInterrupted = false;
  let lastExtremeRegion: GazeTargetRegion | null = null;
  let repeatedExtremeCount = 0;
  let lastFrameDeltaMs = 0;

  function chooseTarget(atElapsed: number): void {
    const roll = clamp01(random());
    let nextRegion: GazeTargetRegion;
    if (roll < GAZE_CONFIG.centerProbability) nextRegion = "center";
    else if (roll < GAZE_CONFIG.centerProbability + GAZE_CONFIG.leftProbability) nextRegion = "left";
    else if (
      roll <
      GAZE_CONFIG.centerProbability + GAZE_CONFIG.leftProbability + GAZE_CONFIG.rightProbability
    ) {
      nextRegion = "right";
    } else nextRegion = "vertical";

    // Do not stare at the same extreme twice in a row. Fallback is center.
    if (
      (nextRegion === "left" || nextRegion === "right" || nextRegion === "vertical") &&
      nextRegion === lastExtremeRegion &&
      repeatedExtremeCount >= 1
    ) {
      nextRegion = "center";
    }
    if (nextRegion === "left" || nextRegion === "right" || nextRegion === "vertical") {
      repeatedExtremeCount = nextRegion === lastExtremeRegion ? repeatedExtremeCount + 1 : 1;
      lastExtremeRegion = nextRegion;
    } else {
      repeatedExtremeCount = 0;
      lastExtremeRegion = null;
    }

    const xRoll = clamp01(random());
    const yRoll = clamp01(random());
    // Quiet micro-drift while resting center.
    const centerX = (xRoll - 0.5) * Math.abs(GAZE_CONFIG.eyeXRange[1]) * 0.22;
    const centerY = (yRoll - 0.5) * Math.abs(GAZE_CONFIG.eyeYRange[1]) * 0.2;
    switch (nextRegion) {
      case "left":
        targetX = lerp(GAZE_CONFIG.eyeXRange[0] * 0.7, GAZE_CONFIG.eyeXRange[0], xRoll);
        // Side looks also pick up a soft vertical component for life.
        targetY = lerp(GAZE_CONFIG.eyeYRange[0] * 0.55, GAZE_CONFIG.eyeYRange[1] * 0.55, yRoll);
        break;
      case "right":
        targetX = lerp(GAZE_CONFIG.eyeXRange[1] * 0.7, GAZE_CONFIG.eyeXRange[1], xRoll);
        targetY = lerp(GAZE_CONFIG.eyeYRange[0] * 0.55, GAZE_CONFIG.eyeYRange[1] * 0.55, yRoll);
        break;
      case "vertical":
        // Full-band look-up / look-down with slight horizontal ease.
        targetX = centerX * 1.4;
        targetY =
          yRoll < 0.5
            ? lerp(GAZE_CONFIG.eyeYRange[0] * 0.65, GAZE_CONFIG.eyeYRange[0], yRoll * 2)
            : lerp(GAZE_CONFIG.eyeYRange[1] * 0.65, GAZE_CONFIG.eyeYRange[1], (yRoll - 0.5) * 2);
        break;
      case "center":
        targetX = centerX;
        targetY = centerY;
        break;
    }
    targetX = clamp(targetX, GAZE_CONFIG.eyeXRange[0], GAZE_CONFIG.eyeXRange[1]);
    targetY = clamp(targetY, GAZE_CONFIG.eyeYRange[0], GAZE_CONFIG.eyeYRange[1]);
    targetRegion = nextRegion;
    holdUntil = atElapsed + sampleHold(random);
  }

  function resolveArgs(
    nowMilliseconds: number,
    second?: number | boolean,
    third?: boolean
  ): { delta: number; interrupted: boolean; wallNow: number } {
    const wallNow = sanitizeNow(nowMilliseconds);
    if (typeof second === "boolean" || second === undefined) {
      // sample(now, interrupted?)
      const interrupted = Boolean(second);
      let delta = 0;
      if (Number.isFinite(lastWallNow)) {
        delta = Math.max(0, wallNow - lastWallNow);
      }
      lastWallNow = wallNow;
      return { delta, interrupted, wallNow };
    }
    // sample(now, deltaMs, interrupted?)
    const delta = Math.max(0, Number.isFinite(second) ? second : 0);
    const interrupted = Boolean(third);
    lastWallNow = wallNow;
    return { delta, interrupted, wallNow };
  }

  function sample(
    nowMilliseconds: number,
    second?: number | boolean,
    third?: boolean
  ): GazeFrame {
    const { delta, interrupted } = resolveArgs(nowMilliseconds, second, third);
    const frameDelta = Math.min(delta, GAZE_CONFIG.maxFrameDeltaMs);
    lastFrameDeltaMs = frameDelta;

    if (disposed) {
      return frame(false);
    }

    if (!initialized) {
      initialized = true;
      elapsedMs = 0;
      // First target is a center pause so mount does not jump.
      targetX = 0;
      targetY = 0;
      targetRegion = "center";
      holdUntil = sampleHold(random);
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
      // Keep the hold clock finite so leaving interrupted can retarget.
      holdUntil = elapsedMs + GAZE_CONFIG.holdMaxMs;
      headTargetX = 0;
      headTargetY = 0;
      headTargetZ = 0;
      bodyTargetX = 0;
      bodyTargetY = 0;
      bodyTargetZ = 0;
      previousInterrupted = true;
    } else {
      if (previousInterrupted) {
        previousInterrupted = false;
        // Retarget immediately after interruption ends.
        holdUntil = elapsedMs;
      }
      if (elapsedMs >= holdUntil) {
        chooseTarget(elapsedMs);
      }
    }

    // --- Continuous cascade -------------------------------------------------
    // 1) Eyes ease toward the hold target (fast).
    currentX = smoothTowards(currentX, targetX, frameDelta, GAZE_CONFIG.eyeResponseMs);
    currentY = smoothTowards(currentY, targetY, frameDelta, GAZE_CONFIG.eyeResponseMs);

    // 2) Head desired is mapped from the *live* eye pose every frame, then
    //    eased. Eyes therefore lead without a hard delay gate.
    const desiredHeadX = mapEyeToHeadAngle(
      currentX,
      GAZE_CONFIG.eyeXRange,
      GAZE_CONFIG.headAngleXMax,
      GAZE_CONFIG.headXGain
    );
    const desiredHeadY = mapEyeToHeadAngle(
      currentY,
      GAZE_CONFIG.eyeYRange,
      GAZE_CONFIG.headAngleYMax,
      GAZE_CONFIG.headYGain
    );
    const desiredHeadZ = mapEyeToHeadAngle(
      currentX,
      GAZE_CONFIG.eyeXRange,
      GAZE_CONFIG.headAngleZMax,
      GAZE_CONFIG.headZGain
    );
    headTargetX = desiredHeadX;
    headTargetY = desiredHeadY;
    headTargetZ = desiredHeadZ;

    const headReturning =
      Math.hypot(desiredHeadX, desiredHeadY) + 1e-6 < Math.hypot(headCurrentX, headCurrentY);
    const headResponse = headReturning
      ? GAZE_CONFIG.headReturnResponseMs
      : GAZE_CONFIG.headResponseMs;
    headCurrentX = smoothTowards(headCurrentX, desiredHeadX, frameDelta, headResponse);
    headCurrentY = smoothTowards(headCurrentY, desiredHeadY, frameDelta, headResponse);
    headCurrentZ = smoothTowards(headCurrentZ, desiredHeadZ, frameDelta, headResponse);

    // 3) Body desired is mapped from the *live* head pose, then eased slower.
    //    No independent random body target.
    const desiredBodyX = mapHeadToBodyAngle(
      headCurrentX,
      GAZE_CONFIG.bodyFollowFraction,
      GAZE_CONFIG.bodyAngleXMax
    );
    const desiredBodyY = mapHeadToBodyAngle(
      headCurrentY,
      GAZE_CONFIG.bodyFollowFraction,
      GAZE_CONFIG.bodyAngleYMax
    );
    const desiredBodyZ = mapHeadToBodyAngle(
      headCurrentZ,
      GAZE_CONFIG.bodyFollowFraction,
      GAZE_CONFIG.bodyAngleZMax
    );
    bodyTargetX = desiredBodyX;
    bodyTargetY = desiredBodyY;
    bodyTargetZ = desiredBodyZ;

    const bodyReturning =
      Math.hypot(desiredBodyX, desiredBodyY) + 1e-6 < Math.hypot(bodyCurrentX, bodyCurrentY);
    const bodyResponse = bodyReturning
      ? GAZE_CONFIG.bodyReturnResponseMs
      : GAZE_CONFIG.bodyResponseMs;
    bodyCurrentX = smoothTowards(bodyCurrentX, desiredBodyX, frameDelta, bodyResponse);
    bodyCurrentY = smoothTowards(bodyCurrentY, desiredBodyY, frameDelta, bodyResponse);
    bodyCurrentZ = smoothTowards(bodyCurrentZ, desiredBodyZ, frameDelta, bodyResponse);

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
      bodyDelayUntil: 0
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
      holdUntil = sampleHold(random);
      headTargetX = 0;
      headTargetY = 0;
      headTargetZ = 0;
      bodyTargetX = 0;
      bodyTargetY = 0;
      bodyTargetZ = 0;
      previousInterrupted = false;
      lastExtremeRegion = null;
      repeatedExtremeCount = 0;
      lastFrameDeltaMs = 0;
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

function sampleHold(random: () => number): number {
  const a = clamp01(random());
  const b = clamp01(random());
  return lerp(GAZE_CONFIG.holdMinMs, GAZE_CONFIG.holdMaxMs, (a + b) / 2);
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
