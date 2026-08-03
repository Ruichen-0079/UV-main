import { describe, expect, it } from "vitest";
import {
  GAZE_CONFIG,
  createGazeScheduler,
  mapEyeToHeadAngle,
  mapHeadToBodyAngle,
  smoothTowards
} from "./companion-gaze.js";

describe("companion gaze scheduler", () => {
  it("keeps targets stable between holds and uses bounded intervals", () => {
    const scheduler = createGazeScheduler(() => 0.5, 0);
    const first = scheduler.sample(0, 0, false);
    const same = scheduler.sample(500, 500, false);
    expect(same.targetX).toBe(first.targetX);
    expect(same.targetY).toBe(first.targetY);
    expect(same.holdUntil).toBeGreaterThanOrEqual(GAZE_CONFIG.holdMinMs);
    expect(same.holdUntil).toBeLessThanOrEqual(GAZE_CONFIG.holdMaxMs);
    expect(same.nextTargetAt).toBe(same.holdUntil);
  });

  it("can deterministically choose a center target more often than an extreme", () => {
    const values = [0.1, 0.5, 0.5, 0.5, 0.1, 0.5, 0.5, 0.5];
    let index = 0;
    const scheduler = createGazeScheduler(() => values[index++] ?? 0.1, 0);
    const first = scheduler.sample(0, 0, false);
    expect(first.targetRegion).toBe("center");
    const next = scheduler.sample(first.holdUntil + 1, first.holdUntil + 1, false);
    expect(next.targetRegion).toBe("center");
  });

  it("moves eyes without teleporting and converges independently of frame rate", () => {
    const scheduler = createGazeScheduler(() => 0.8, 0);
    const initial = scheduler.sample(0, 0, false);
    const beforeHold = scheduler.sample(initial.holdUntil - 1, initial.holdUntil - 1, false);
    const afterHold = scheduler.sample(initial.holdUntil + 1, 2, false);
    expect(Math.abs(afterHold.currentX - beforeHold.currentX)).toBeLessThan(
      Math.abs(GAZE_CONFIG.eyeXRange[1])
    );
    expect(smoothTowards(0, 1, 16, 260)).toBeGreaterThan(0);
    expect(smoothTowards(0, 1, 16, 260)).toBeLessThan(1);
    expect(smoothTowards(0, 1, 10_000, 260)).toBeLessThan(1);
  });

  it("maps eye extremes to the calibrated head angles without double-shrinking", () => {
    const eyeXMax = Math.abs(GAZE_CONFIG.eyeXRange[1]);
    const eyeYMax = Math.max(
      Math.abs(GAZE_CONFIG.eyeYRange[0]),
      Math.abs(GAZE_CONFIG.eyeYRange[1])
    );
    expect(
      mapEyeToHeadAngle(eyeXMax, GAZE_CONFIG.eyeXRange, GAZE_CONFIG.headAngleXMax, GAZE_CONFIG.headXGain)
    ).toBeCloseTo(GAZE_CONFIG.headAngleXMax, 5);
    expect(
      mapEyeToHeadAngle(-eyeXMax, GAZE_CONFIG.eyeXRange, GAZE_CONFIG.headAngleXMax, GAZE_CONFIG.headXGain)
    ).toBeCloseTo(-GAZE_CONFIG.headAngleXMax, 5);
    expect(
      mapEyeToHeadAngle(eyeXMax / 2, GAZE_CONFIG.eyeXRange, GAZE_CONFIG.headAngleXMax, 1)
    ).toBeCloseTo(GAZE_CONFIG.headAngleXMax / 2, 5);
    expect(
      mapEyeToHeadAngle(eyeYMax, GAZE_CONFIG.eyeYRange, GAZE_CONFIG.headAngleYMax, GAZE_CONFIG.headYGain)
    ).toBeCloseTo(GAZE_CONFIG.headAngleYMax, 5);
    const legacy = eyeXMax * GAZE_CONFIG.headAngleXMax * 0.85;
    expect(legacy).toBeLessThan(GAZE_CONFIG.headAngleXMax);
    expect(
      mapEyeToHeadAngle(eyeXMax, GAZE_CONFIG.eyeXRange, GAZE_CONFIG.headAngleXMax, 1)
    ).toBeGreaterThan(legacy * 0.9);
  });

  it("maps body as a fraction of head without independent targets", () => {
    expect(mapHeadToBodyAngle(10, 0.3, 3.5)).toBeCloseTo(3, 5);
    expect(mapHeadToBodyAngle(10, 0.3, 2.5)).toBeCloseTo(2.5, 5); // soft cap
    expect(mapHeadToBodyAngle(-8, 0.3, 3.5)).toBeCloseTo(-2.4, 5);
    expect(mapHeadToBodyAngle(0, 0.3, 3.5)).toBe(0);
  });

  it("keeps presence-first amplitude and longer holds", () => {
    expect(Math.abs(GAZE_CONFIG.eyeXRange[1])).toBeGreaterThanOrEqual(0.8);
    expect(Math.abs(GAZE_CONFIG.eyeYRange[0])).toBeGreaterThanOrEqual(0.4);
    expect(Math.abs(GAZE_CONFIG.eyeYRange[1])).toBeGreaterThanOrEqual(0.45);
    expect(GAZE_CONFIG.headAngleXMax).toBeGreaterThanOrEqual(14);
    expect(GAZE_CONFIG.headAngleYMax).toBeGreaterThanOrEqual(10);
    expect(GAZE_CONFIG.headAngleZMax).toBeGreaterThanOrEqual(6);
    expect(GAZE_CONFIG.bodyFollowFraction).toBeGreaterThanOrEqual(0.3);
    expect(GAZE_CONFIG.bodyFollowFraction).toBeLessThanOrEqual(0.5);
    expect(GAZE_CONFIG.verticalProbability).toBeGreaterThanOrEqual(0.18);
    expect(GAZE_CONFIG.holdMinMs).toBeGreaterThanOrEqual(1500);
    expect(GAZE_CONFIG.eyeResponseMs).toBeLessThan(GAZE_CONFIG.headResponseMs);
    expect(GAZE_CONFIG.headResponseMs).toBeLessThan(GAZE_CONFIG.bodyResponseMs);
    expect(GAZE_CONFIG.headXGain).toBe(1);
  });

  it("drives multi-degree head and lagging body when the eye is at an extreme", () => {
    const scheduler = createGazeScheduler(() => 0.7, 0);
    const first = scheduler.sample(0, 0, false);
    let frame = first;
    let wall = 0;
    while (frame.elapsedMs < first.holdUntil + 1400) {
      wall += 16;
      frame = scheduler.sample(wall, 16, false);
    }
    expect(Math.abs(frame.targetX) + Math.abs(frame.targetY)).toBeGreaterThan(0.4);
    expect(Math.abs(frame.headTargetX) + Math.abs(frame.headTargetY)).toBeGreaterThan(6);
    expect(Math.abs(frame.headCurrentX)).toBeLessThanOrEqual(GAZE_CONFIG.headAngleXMax + 1e-6);
    // Body tracks live head current at a fraction — no independent walk.
    expect(Math.abs(frame.bodyTargetX)).toBeLessThanOrEqual(
      Math.abs(frame.headCurrentX) * GAZE_CONFIG.bodyFollowFraction + 1e-6
    );
    expect(Math.abs(frame.bodyTargetX)).toBeLessThanOrEqual(GAZE_CONFIG.bodyAngleXMax + 1e-6);
    expect(Math.abs(frame.bodyCurrentX)).toBeLessThanOrEqual(Math.abs(frame.headCurrentX) + 0.5);
  });

  it("cascades continuously: eyes lead head, head leads body (no hard gate snap)", () => {
    // Force a right extreme after first hold using a fixed sequence.
    // first sample uses random for hold only; after hold, region roll 0.7 → right.
    const scheduler = createGazeScheduler(() => 0.7, 0);
    const first = scheduler.sample(0, 0, false);
    let wall = 0;
    let frame = first;
    while (frame.elapsedMs < first.holdUntil) {
      wall += 16;
      frame = scheduler.sample(wall, 16, false);
    }
    // Immediately after retarget, step a few frames and compare cascade lead.
    wall += 16;
    frame = scheduler.sample(wall, 16, false);
    wall += 48;
    const mid = scheduler.sample(wall, 48, false);
    // Eye current should move toward target faster than head (normalized).
    const eyeNorm = Math.abs(mid.currentX) / Math.abs(GAZE_CONFIG.eyeXRange[1] || 1);
    const headNorm = Math.abs(mid.headCurrentX) / Math.max(GAZE_CONFIG.headAngleXMax, 1e-6);
    const bodyNorm =
      Math.abs(mid.bodyCurrentX) /
      Math.max(GAZE_CONFIG.headAngleXMax * GAZE_CONFIG.bodyFollowFraction, 1e-6);
    // Soft inequality: cascade ordering on the way out of center.
    if (Math.abs(mid.targetX) > 0.3) {
      expect(eyeNorm + 0.02).toBeGreaterThanOrEqual(headNorm);
      expect(headNorm + 0.02).toBeGreaterThanOrEqual(bodyNorm);
    }
    // Hard delay gates are disabled.
    expect(mid.headDelayUntil).toBe(0);
    expect(mid.bodyDelayUntil).toBe(0);
  });

  it("produces a non-zero target within holdMaxMs under real random sampling", () => {
    const scheduler = createGazeScheduler(Math.random, 0);
    let sawNonZero = false;
    let now = 0;
    for (let i = 0; i < 2500; i += 1) {
      now += 16;
      const frame = scheduler.sample(now, 16, false);
      if (Math.abs(frame.targetX) > 0.08 || Math.abs(frame.currentX) > 0.08) {
        sawNonZero = true;
        break;
      }
    }
    expect(sawNonZero).toBe(true);
  });

  it("returns head smoothly under interruption", () => {
    const scheduler = createGazeScheduler(() => 0.8, 0);
    const first = scheduler.sample(0, 0, false);
    const moved = scheduler.sample(first.holdUntil + 1, first.holdUntil + 1, false);
    expect(Math.abs(moved.headCurrentX)).toBeLessThanOrEqual(GAZE_CONFIG.headAngleXMax);
    expect(Math.abs(moved.headCurrentY)).toBeLessThanOrEqual(GAZE_CONFIG.headAngleYMax);
    expect(Math.abs(moved.headCurrentZ)).toBeLessThanOrEqual(GAZE_CONFIG.headAngleZMax);
    const interrupted = scheduler.sample(moved.holdUntil + 1, 1, true);
    expect(interrupted.targetX).toBe(0);
    expect(interrupted.targetY).toBe(0);
    expect(Math.abs(interrupted.headCurrentX)).toBeLessThanOrEqual(Math.abs(moved.headCurrentX));
  });

  it("centers on interruption, resumes after a new turn, and disposes permanently", () => {
    const scheduler = createGazeScheduler(() => 0.9, 0);
    const active = scheduler.sample(0, 0, false);
    const interrupted = scheduler.sample(active.holdUntil + 1, 1, true);
    expect(interrupted.targetRegion).toBe("center");
    const resumed = scheduler.sample(active.holdUntil + 2, 1, false);
    expect(resumed.running).toBe(true);
    expect(Number.isFinite(resumed.holdUntil)).toBe(true);
    scheduler.dispose();
    expect(scheduler.isDisposed()).toBe(true);
    const dead = scheduler.sample(active.holdUntil + 100, 16, false);
    expect(dead.running).toBe(false);
    expect(dead.disposed).toBe(true);
    expect(dead.currentX).toBe(0);
    expect(dead.bodyCurrentX).toBe(0);
    scheduler.reset(active.holdUntil + 100);
    expect(scheduler.isDisposed()).toBe(false);
    expect(scheduler.sample(active.holdUntil + 100, 0, false).running).toBe(true);
  });

  it("advances the hold clock from explicit frame deltas", () => {
    const scheduler = createGazeScheduler(() => 0.7, 0);
    const first = scheduler.sample(1000, 0, false);
    expect(first.targetRegion).toBe("center");
    let frame = first;
    let wall = 1000;
    while (frame.elapsedMs < first.holdUntil + 1) {
      wall += 50;
      frame = scheduler.sample(wall, 50, false);
    }
    expect(frame.targetRegion).not.toBe("center");
    expect(Math.abs(frame.targetX) + Math.abs(frame.targetY)).toBeGreaterThan(0.1);
    expect(frame.running).toBe(true);
    expect(frame.disposed).toBe(false);
  });
});
