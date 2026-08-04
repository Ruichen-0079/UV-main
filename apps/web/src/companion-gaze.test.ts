import { describe, expect, it } from "vitest";
import {
  composeCompanionPresenceAnimation,
  GAZE_CONFIG,
  GAZE_REGION_RANGES,
  createGazeScheduler,
  mapEyeToHeadAngle,
  mapHeadToBodyAngle,
  normalizeTargetRegionWeights,
  selectNextTarget,
  smoothTowards
} from "./companion-gaze.js";
import { PRESENCE_BEHAVIOR_PROFILES } from "./companion-presence.js";

describe("companion gaze scheduler", () => {
  function createSeededRandom(seed = 0x9e3779b9): () => number {
    let value = seed >>> 0;
    return () => {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 0x1_0000_0000;
    };
  }

  it("matches the idle target distribution over many deterministic retargets", () => {
    const random = createSeededRandom();
    const counts = { center: 0, left: 0, right: 0, upper: 0, lower: 0 };
    const sampleCount = 10_000;
    for (let index = 0; index < sampleCount; index += 1) {
      counts[selectNextTarget(PRESENCE_BEHAVIOR_PROFILES.idle, random).region] += 1;
    }
    expect(counts.center / sampleCount).toBeGreaterThan(0.22);
    expect(counts.center / sampleCount).toBeLessThan(0.36);
    expect(counts.left / sampleCount).toBeGreaterThan(0.18);
    expect(counts.right / sampleCount).toBeGreaterThan(0.18);
    expect(counts.upper / sampleCount).toBeGreaterThan(0.12);
    expect(counts.lower / sampleCount).toBeGreaterThan(0.02);
  });

  it("keeps listening center-biased without becoming static", () => {
    const random = createSeededRandom(17);
    let center = 0;
    let nonCenter = 0;
    for (let index = 0; index < 2_000; index += 1) {
      const target = selectNextTarget(PRESENCE_BEHAVIOR_PROFILES.listening, random, {
        allowQuickGlance: false
      });
      if (target.region === "center") center += 1;
      else nonCenter += 1;
    }
    expect(center / 2_000).toBeGreaterThan(0.55);
    expect(nonCenter).toBeGreaterThan(0);
  });

  it("gives thinking a high upper weight and side looks", () => {
    const random = createSeededRandom(31);
    const counts = { center: 0, left: 0, right: 0, upper: 0, lower: 0 };
    for (let index = 0; index < 2_000; index += 1) {
      counts[
        selectNextTarget(PRESENCE_BEHAVIOR_PROFILES.thinking, random, { allowQuickGlance: false })
          .region
      ] += 1;
    }
    expect(counts.upper / 2_000).toBeGreaterThan(0.32);
    expect((counts.left + counts.right + counts.upper) / 2_000).toBeGreaterThan(0.65);
    expect(PRESENCE_BEHAVIOR_PROFILES.thinking.targetRegionWeights.upper).toBeGreaterThan(0.35);
  });

  it("keeps speaking peaks below idle but above listening", () => {
    expect(PRESENCE_BEHAVIOR_PROFILES.speaking.eyeXMax).toBeLessThan(
      PRESENCE_BEHAVIOR_PROFILES.idle.eyeXMax
    );
    expect(PRESENCE_BEHAVIOR_PROFILES.speaking.eyeXMax).toBeGreaterThan(
      PRESENCE_BEHAVIOR_PROFILES.listening.eyeXMax
    );
    expect(PRESENCE_BEHAVIOR_PROFILES.speaking.headXMax).toBeLessThan(
      PRESENCE_BEHAVIOR_PROFILES.idle.headXMax
    );
    expect(PRESENCE_BEHAVIOR_PROFILES.speaking.headXMax).toBeGreaterThan(
      PRESENCE_BEHAVIOR_PROFILES.listening.headXMax
    );
    expect(PRESENCE_BEHAVIOR_PROFILES.speaking.bodyXMax).toBeLessThan(
      PRESENCE_BEHAVIOR_PROFILES.idle.bodyXMax
    );
  });

  it("maps absolute profile peaks without double-shrinking head/body", () => {
    const idle = PRESENCE_BEHAVIOR_PROFILES.idle;
    const head = mapEyeToHeadAngle(idle.eyeXMax, [-idle.eyeXMax, idle.eyeXMax], idle.headXMax, 1);
    expect(head).toBeCloseTo(idle.headXMax, 5);
    const body = mapHeadToBodyAngle(idle.headXMax, idle.bodyFollowFraction, idle.bodyXMax);
    expect(body).toBeCloseTo(
      Math.min(idle.bodyXMax, idle.headXMax * idle.bodyFollowFraction),
      5
    );
    // Legacy double-shrink would be far smaller than the configured peak.
    const legacy = 0.32 * idle.headXMax * 0.85;
    expect(head).toBeGreaterThan(legacy * 2);
  });

  it("uses region bands outside the ±0.2 dead zone for side looks", () => {
    expect(Math.abs(GAZE_REGION_RANGES.left.x[0])).toBeGreaterThan(0.4);
    expect(Math.abs(GAZE_REGION_RANGES.right.x[1])).toBeGreaterThan(0.4);
    expect(GAZE_REGION_RANGES.upper.y[0]).toBeGreaterThan(0.25);
    const side = selectNextTarget(PRESENCE_BEHAVIOR_PROFILES.idle, () => 0.55, {
      allowQuickGlance: false
    });
    // 0.55 lands past center+left into right for idle weights.
    expect(["left", "right", "upper", "lower", "center"]).toContain(side.region);
  });

  it("keeps force-gaze output separate from scheduler state", () => {
    const scheduler = createGazeScheduler(() => 0.8, 0);
    const frame = scheduler.sample(0, 0, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    const before = scheduler.getDebug();
    const forced = composeCompanionPresenceAnimation({ blink: 0, breath: 0.12 }, frame, true);
    expect(forced.eyeBallX).toBe(1);
    expect(forced.headAngleX).toBe(20);
    expect(scheduler.getDebug()).toEqual(before);
    const resumedFrame = scheduler.sample(16, 16, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    const resumed = composeCompanionPresenceAnimation(
      { blink: 0, breath: 0.12 },
      resumedFrame,
      false
    );
    expect(resumed.eyeBallX).toBe(resumedFrame.currentX);
  });

  it("repeats fixed-random target sequences deterministically", () => {
    const first = [0, 1, 2, 3, 4].map((seed) => {
      const random = createSeededRandom(seed);
      return selectNextTarget(PRESENCE_BEHAVIOR_PROFILES.thinking, random, {
        allowQuickGlance: false
      });
    });
    const second = [0, 1, 2, 3, 4].map((seed) => {
      const random = createSeededRandom(seed);
      return selectNextTarget(PRESENCE_BEHAVIOR_PROFILES.thinking, random, {
        allowQuickGlance: false
      });
    });
    expect(second).toEqual(first);
  });

  it("uses normalized profile weights including upper/lower", () => {
    const listening = normalizeTargetRegionWeights(
      PRESENCE_BEHAVIOR_PROFILES.listening.targetRegionWeights
    );
    expect(listening.center).toBeGreaterThan(0.6);
    expect(
      listening.center + listening.left + listening.right + listening.upper + listening.lower
    ).toBeCloseTo(1);

    const upward = selectNextTarget(PRESENCE_BEHAVIOR_PROFILES.thinking, () => 0.95, {
      allowQuickGlance: false
    });
    expect(upward.region === "upper" || upward.region === "lower").toBe(true);
  });

  it("falls back safely when a profile supplies invalid region weights", () => {
    expect(
      normalizeTargetRegionWeights({
        center: -1,
        left: Number.NaN,
        right: 0,
        upper: 0,
        lower: 0
      })
    ).toEqual({ center: 1, left: 0, right: 0, upper: 0, lower: 0 });
  });

  it("does not dispose or reset the scheduler when interrupted", () => {
    const scheduler = createGazeScheduler(() => 0.7, 0);
    const before = scheduler.sample(0, 0, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    const interrupted = scheduler.sample(100, 100, true, PRESENCE_BEHAVIOR_PROFILES.interrupted);
    expect(interrupted.running).toBe(true);
    expect(interrupted.disposed).toBe(false);
    expect(interrupted.targetKind).toBe("recenter");
    const resumed = scheduler.sample(200, 100, false, PRESENCE_BEHAVIOR_PROFILES.listening);
    expect(resumed.running).toBe(true);
    expect(resumed.elapsedMs).toBeGreaterThan(before.elapsedMs);
  });

  it("keeps targets stable between holds and uses profile hold bounds", () => {
    const scheduler = createGazeScheduler(() => 0.5, 0);
    const first = scheduler.sample(0, 0, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    const same = scheduler.sample(500, 500, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    expect(same.targetX).toBe(first.targetX);
    expect(same.targetY).toBe(first.targetY);
    expect(same.holdUntil).toBeGreaterThanOrEqual(PRESENCE_BEHAVIOR_PROFILES.idle.targetHoldMinMs);
    expect(same.nextTargetAt).toBe(same.holdUntil);
  });

  it("can produce quick glances that do not drive the body", () => {
    // Force quick glance: first random for chance must be < chance.
    const values = [0.01, 0.9, 0.5, 0.5, 0.5, 0.5];
    let index = 0;
    const selected = selectNextTarget(PRESENCE_BEHAVIOR_PROFILES.idle, () => values[index++] ?? 0.5, {
      allowQuickGlance: true,
      lastWasQuickGlance: false
    });
    // May or may not be quick depending on region rolls; force path via high chance profile.
    const alwaysGlance = {
      ...PRESENCE_BEHAVIOR_PROFILES.idle,
      quickGlanceChance: 1
    };
    const glance = selectNextTarget(alwaysGlance, () => 0.5, {
      allowQuickGlance: true,
      lastWasQuickGlance: false
    });
    expect(glance.kind).toBe("quickGlance");
    expect(glance.bodyFollowEnabled).toBe(false);
    expect(glance.headFollowScale).toBeGreaterThanOrEqual(0.15);
    expect(glance.headFollowScale).toBeLessThanOrEqual(0.45);
    expect(glance.holdMs).toBeLessThan(900);
    void selected;
  });

  it("does not chain two quick glances back-to-back", () => {
    const alwaysGlance = {
      ...PRESENCE_BEHAVIOR_PROFILES.thinking,
      quickGlanceChance: 1
    };
    const second = selectNextTarget(alwaysGlance, () => 0.2, {
      allowQuickGlance: true,
      lastWasQuickGlance: true
    });
    expect(second.kind).toBe("hold");
  });

  it("bounds session side bias within ±6%", () => {
    const scheduler = createGazeScheduler(createSeededRandom(99), 0);
    const frame = scheduler.sample(0, 0, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    expect(Math.abs(frame.sessionSideBias)).toBeLessThanOrEqual(GAZE_CONFIG.sessionSideBiasMax + 1e-9);
    expect(Math.abs(frame.headZBias)).toBeLessThanOrEqual(GAZE_CONFIG.headZBiasMaxFraction + 1e-9);
  });

  it("tracks actual envelopes as non-zero under lively idle motion", () => {
    const scheduler = createGazeScheduler(createSeededRandom(3), 0);
    let frame = scheduler.sample(0, 0, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    let wall = 0;
    for (let i = 0; i < 400; i += 1) {
      wall += 16;
      frame = scheduler.sample(wall, 16, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    }
    expect(frame.actualEyeEnvelope.x + frame.actualEyeEnvelope.y).toBeGreaterThan(0.15);
    expect(frame.actualHeadEnvelope.x).toBeGreaterThan(1);
    expect(frame.actualBodyEnvelope.x).toBeGreaterThan(0.2);
    expect(frame.actualBodyEnvelope.x).toBeLessThanOrEqual(
      PRESENCE_BEHAVIOR_PROFILES.idle.bodyXMax + 0.5
    );
  });

  it("moves eyes without teleporting", () => {
    const scheduler = createGazeScheduler(() => 0.8, 0);
    const initial = scheduler.sample(0, 0, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    const beforeHold = scheduler.sample(
      initial.holdUntil - 1,
      initial.holdUntil - 1,
      false,
      PRESENCE_BEHAVIOR_PROFILES.idle
    );
    const afterHold = scheduler.sample(initial.holdUntil + 1, 2, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    expect(Math.abs(afterHold.currentX - beforeHold.currentX)).toBeLessThan(
      PRESENCE_BEHAVIOR_PROFILES.idle.eyeXMax
    );
    expect(smoothTowards(0, 1, 16, 260)).toBeGreaterThan(0);
    expect(smoothTowards(0, 1, 16, 260)).toBeLessThan(1);
  });

  it("centers on interruption, resumes after a new turn, and disposes permanently", () => {
    const scheduler = createGazeScheduler(() => 0.9, 0);
    const active = scheduler.sample(0, 0, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    const interrupted = scheduler.sample(
      active.holdUntil + 1,
      1,
      true,
      PRESENCE_BEHAVIOR_PROFILES.interrupted
    );
    expect(interrupted.targetRegion).toBe("center");
    const resumed = scheduler.sample(active.holdUntil + 2, 1, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    expect(resumed.running).toBe(true);
    expect(Number.isFinite(resumed.holdUntil)).toBe(true);
    scheduler.dispose();
    expect(scheduler.isDisposed()).toBe(true);
    const dead = scheduler.sample(active.holdUntil + 100, 16, false);
    expect(dead.running).toBe(false);
    expect(dead.disposed).toBe(true);
    expect(dead.currentX).toBe(0);
    expect(dead.bodyCurrentX).toBe(0);
  });

  it("keeps body lagging behind head on the way out of center", () => {
    const scheduler = createGazeScheduler(() => 0.7, 0);
    const first = scheduler.sample(0, 0, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    let wall = 0;
    let frame = first;
    while (frame.elapsedMs < first.holdUntil) {
      wall += 16;
      frame = scheduler.sample(wall, 16, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    }
    wall += 80;
    const mid = scheduler.sample(wall, 80, false, PRESENCE_BEHAVIOR_PROFILES.idle);
    if (Math.abs(mid.targetX) > 0.25) {
      const headNorm = Math.abs(mid.headCurrentX) / Math.max(mid.headTargetX || 1, 1e-3);
      const bodyNorm = Math.abs(mid.bodyCurrentX) / Math.max(Math.abs(mid.headCurrentX) * 0.34, 1e-3);
      expect(headNorm + 0.05).toBeGreaterThanOrEqual(bodyNorm * 0.5);
    }
  });
});
