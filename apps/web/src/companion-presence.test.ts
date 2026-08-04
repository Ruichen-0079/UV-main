import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLINK_CONFIG,
  BLINK_MAX_INTERVAL_MS,
  BLINK_MIN_INTERVAL_MS,
  createCompanionBlinkScheduler,
  createInterruptedResetScheduler,
  createPresenceBehaviorTransition,
  getCompanionAnimation,
  PRESENCE_BEHAVIOR_PROFILES,
  reduceCompanionPresence
} from "./companion-presence.js";

describe("reduceCompanionPresence", () => {
  afterEach(() => vi.useRealTimers());
  it("follows generation state and queue state transitions", () => {
    let presence = reduceCompanionPresence("idle", { type: "generation", state: "thinking" });
    expect(presence).toBe("thinking");

    presence = reduceCompanionPresence(presence, { type: "queue", state: "synthesizing" });
    expect(presence).toBe("thinking");

    presence = reduceCompanionPresence(presence, { type: "queue", state: "playing" });
    expect(presence).toBe("speaking");

    presence = reduceCompanionPresence(presence, { type: "generation", state: "idle" });
    expect(presence).toBe("speaking");

    presence = reduceCompanionPresence(presence, { type: "queue", state: "idle" });
    expect(presence).toBe("idle");
  });

  it("maps stopped and error queue states", () => {
    expect(reduceCompanionPresence("thinking", { type: "queue", state: "stopped" })).toBe(
      "interrupted"
    );
    expect(reduceCompanionPresence("interrupted", { type: "queue", state: "error" })).toBe(
      "interrupted"
    );
  });

  it("keeps interrupted transient until its timer, while a new turn can override it", () => {
    expect(reduceCompanionPresence("interrupted", { type: "queue", state: "idle" })).toBe(
      "interrupted"
    );
    expect(reduceCompanionPresence("interrupted", { type: "generation", state: "idle" })).toBe(
      "interrupted"
    );
    expect(reduceCompanionPresence("interrupted", { type: "generation", state: "listening" })).toBe(
      "listening"
    );
    expect(reduceCompanionPresence("interrupted", { type: "generation", state: "thinking" })).toBe(
      "thinking"
    );
  });

  it("maps interrupted generation state", () => {
    expect(reduceCompanionPresence("thinking", { type: "generation", state: "interrupted" })).toBe(
      "interrupted"
    );
  });

  it("tracks listening before thinking", () => {
    expect(reduceCompanionPresence("idle", { type: "generation", state: "listening" })).toBe(
      "listening"
    );
    expect(reduceCompanionPresence("listening", { type: "generation", state: "thinking" })).toBe(
      "thinking"
    );
  });

  it("produces breathing and eye frames while idle and speaking", () => {
    const idle = getCompanionAnimation("idle", 1000);
    const blink = getCompanionAnimation("idle", 3690, 0.8);
    expect(idle.breath).toBeGreaterThan(0);
    expect(idle.blink).toBe(0);
    expect(blink.blink).toBeGreaterThan(0);
    expect(getCompanionAnimation("thinking", 3690).blink).toBe(0);
    expect(getCompanionAnimation("thinking", 3690).breath).toBeGreaterThan(0);
    expect(getCompanionAnimation("speaking", 3690, 0.8)).toEqual({
      blink: 0.8,
      breath: expect.any(Number)
    });
  });

  it("keeps state behavior in one normalized profile table with absolute envelopes", () => {
    for (const profile of Object.values(PRESENCE_BEHAVIOR_PROFILES)) {
      const weights = profile.targetRegionWeights;
      expect(
        weights.center + weights.left + weights.right + weights.upper + weights.lower
      ).toBeCloseTo(1, 8);
      expect(profile.targetHoldMaxMs).toBeGreaterThanOrEqual(profile.targetHoldMinMs);
      expect(profile.eyeXMax).toBeGreaterThan(0);
      expect(profile.headXMax).toBeGreaterThan(0);
      expect(profile.bodyXMax).toBeGreaterThan(0);
      expect(profile.transitionMs).toBeGreaterThan(0);
    }
    expect(PRESENCE_BEHAVIOR_PROFILES.listening.targetRegionWeights.center).toBeGreaterThan(
      PRESENCE_BEHAVIOR_PROFILES.idle.targetRegionWeights.center
    );
    expect(PRESENCE_BEHAVIOR_PROFILES.thinking.targetRegionWeights.upper).toBeGreaterThan(
      PRESENCE_BEHAVIOR_PROFILES.idle.targetRegionWeights.upper
    );
    expect(PRESENCE_BEHAVIOR_PROFILES.speaking.eyeXMax).toBeLessThan(
      PRESENCE_BEHAVIOR_PROFILES.idle.eyeXMax
    );
    expect(PRESENCE_BEHAVIOR_PROFILES.speaking.eyeXMax).toBeGreaterThan(
      PRESENCE_BEHAVIOR_PROFILES.listening.eyeXMax
    );
    // Per-state transition durations (not a single average).
    expect(PRESENCE_BEHAVIOR_PROFILES.listening.transitionMs).toBeLessThan(
      PRESENCE_BEHAVIOR_PROFILES.thinking.transitionMs
    );
    expect(PRESENCE_BEHAVIOR_PROFILES.interrupted.transitionMs).toBeLessThan(
      PRESENCE_BEHAVIOR_PROFILES.idle.transitionMs
    );
  });

  it("interpolates profile values without rebuilding the behavior owner", () => {
    const transition = createPresenceBehaviorTransition("idle");
    const initial = transition.sample("idle", 0, 100);
    // speaking transitionMs = 380 → halfway at 190ms
    const middle = transition.sample("speaking", 190, 200);
    expect(initial.activeState).toBe("idle");
    expect(middle.activeState).toBe("speaking");
    expect(middle.previousState).toBe("idle");
    expect(middle.transitionProgress).toBeCloseTo(0.5, 5);
    expect(middle.effectiveTransitionMs).toBe(PRESENCE_BEHAVIOR_PROFILES.speaking.transitionMs);
    expect(middle.effective.eyeXMax).toBeGreaterThan(PRESENCE_BEHAVIOR_PROFILES.speaking.eyeXMax);
    expect(middle.effective.eyeXMax).toBeLessThan(PRESENCE_BEHAVIOR_PROFILES.idle.eyeXMax);
    const complete = transition.sample("speaking", 190, 300);
    expect(complete.transitionProgress).toBe(1);
    expect(complete.effective).toEqual(PRESENCE_BEHAVIOR_PROFILES.speaking);
    expect(complete.lastPresenceTransitionAt).toBe(200);
  });

  it("keeps interrupted breathing alive while forcing the blink output open", () => {
    const frame = getCompanionAnimation(
      "interrupted",
      1000,
      1,
      PRESENCE_BEHAVIOR_PROFILES.interrupted
    );
    expect(frame.blink).toBe(0);
    expect(frame.breath).toBeGreaterThan(0);
  });

  it("keeps blink timing in the natural, centralized config ranges", () => {
    expect(BLINK_CONFIG.minIntervalMs).toBeGreaterThanOrEqual(1600);
    expect(BLINK_CONFIG.maxIntervalMs).toBeLessThanOrEqual(5200);
    expect(BLINK_CONFIG.closeMs).toBeGreaterThanOrEqual(70);
    expect(BLINK_CONFIG.closeMs).toBeLessThanOrEqual(100);
    expect(BLINK_CONFIG.holdMs).toBeGreaterThanOrEqual(45);
    expect(BLINK_CONFIG.holdMs).toBeLessThanOrEqual(80);
    expect(BLINK_CONFIG.openMs).toBeGreaterThanOrEqual(100);
    expect(BLINK_CONFIG.openMs).toBeLessThanOrEqual(150);
    const fullBlink = BLINK_CONFIG.closeMs + BLINK_CONFIG.holdMs + BLINK_CONFIG.openMs;
    expect(fullBlink).toBeGreaterThanOrEqual(220);
    expect(fullBlink).toBeLessThanOrEqual(330);
    expect(PRESENCE_BEHAVIOR_PROFILES.idle.doubleBlinkProbability).toBeGreaterThanOrEqual(0.16);
    expect(PRESENCE_BEHAVIOR_PROFILES.thinking.doubleBlinkProbability).toBeGreaterThanOrEqual(0.18);
  });

  it("applies the profile blink interval bounds to the next blink", () => {
    const sequence = [0, 0, 1, 0, 0];
    let index = 0;
    const scheduler = createCompanionBlinkScheduler(() => sequence[index++] ?? 0, 0);
    const profile = PRESENCE_BEHAVIOR_PROFILES.speaking;
    const firstEnd =
      profile.blinkIntervalMinMs + BLINK_CONFIG.closeMs + BLINK_CONFIG.holdMs + BLINK_CONFIG.openMs;
    // Initial schedule uses idle profile defaults via constructor; force a finished blink:
    scheduler.sample(firstEnd, "speaking", profile);
    const next = scheduler.getNextBlinkAt();
    expect(next).toBeGreaterThanOrEqual(firstEnd + profile.blinkIntervalMinMs * 0.5 - 1);
    expect(next).toBeLessThanOrEqual(
      firstEnd + profile.blinkIntervalMaxMs * profile.blinkIntervalScale + 1
    );
  });

  it("uses injected randomness for bounded, non-fixed blink intervals", () => {
    const earliest = createCompanionBlinkScheduler(() => 0, 0);
    const latest = createCompanionBlinkScheduler(() => 1, 0);
    const idleMin = PRESENCE_BEHAVIOR_PROFILES.idle.blinkIntervalMinMs;
    const idleMax = PRESENCE_BEHAVIOR_PROFILES.idle.blinkIntervalMaxMs;
    expect(earliest.getNextBlinkAt()).toBe(idleMin);
    expect(latest.getNextBlinkAt()).toBe(idleMax);
    expect(latest.getNextBlinkAt()).not.toBe((idleMin + idleMax) / 2);
    expect(earliest.getPhase(0)).toBe("waiting");
    expect(earliest.getPhase(idleMin + 20)).toBe("closing");
    expect(earliest.getPhase(idleMin + BLINK_CONFIG.closeMs + 5)).toBe("holding");
    expect(earliest.getPhase(idleMin + BLINK_CONFIG.closeMs + BLINK_CONFIG.holdMs + 5)).toBe(
      "opening"
    );
  });

  it("allows one finite double blink without looping", () => {
    // Construction samples nextInterval (2 randoms). Subsequent finish samples:
    // double check, optional gap, then interval pair.
    const sequence = [
      0,
      0, // initial interval → min
      0, // first finish: force double (random < probability)
      0, // double gap → min
      0,
      0 // after the double, nextInterval → min (doublePending path skips another roll)
    ];
    let index = 0;
    const scheduler = createCompanionBlinkScheduler(() => sequence[index++] ?? 1, 0);
    const firstBlinkEnd =
      BLINK_MIN_INTERVAL_MS + BLINK_CONFIG.closeMs + BLINK_CONFIG.holdMs + BLINK_CONFIG.openMs;
    expect(scheduler.sample(firstBlinkEnd)).toBe(0);
    const next = scheduler.getNextBlinkAt();
    expect(next).toBe(firstBlinkEnd + BLINK_CONFIG.doubleBlinkGapMinMs);
    const secondEnd =
      next + BLINK_CONFIG.doubleCloseMs + BLINK_CONFIG.doubleHoldMs + BLINK_CONFIG.doubleOpenMs;
    expect(scheduler.sample(secondEnd)).toBe(0);
    expect(scheduler.getNextBlinkAt()).toBe(secondEnd + BLINK_MIN_INTERVAL_MS);
  });

  it("holds a fully closed eye value long enough to be visible across several frames", () => {
    const scheduler = createCompanionBlinkScheduler(() => 0, 0);
    const holdStart = BLINK_MIN_INTERVAL_MS + BLINK_CONFIG.closeMs;
    const samples: number[] = [];
    for (let t = holdStart; t < holdStart + BLINK_CONFIG.holdMs; t += 16) {
      samples.push(scheduler.sample(t));
    }
    expect(samples.length).toBeGreaterThanOrEqual(3);
    expect(samples.every((value) => value === 1)).toBe(true);
    expect(scheduler.getPhase(holdStart + 10)).toBe("holding");
  });

  it("continues blinking while speaking and freezes only when interrupted", () => {
    const scheduler = createCompanionBlinkScheduler(() => 0, 0);
    expect(scheduler.sample(BLINK_MIN_INTERVAL_MS + 20, "speaking")).toBeGreaterThan(0);
    expect(scheduler.sample(BLINK_MIN_INTERVAL_MS + 20, "interrupted")).toBe(0);
  });

  it("stops writing after dispose and can be replaced by a fresh scheduler", () => {
    const first = createCompanionBlinkScheduler(() => 0, 0);
    first.dispose();
    expect(first.sample(BLINK_MIN_INTERVAL_MS + 20)).toBe(0);
    expect(first.getPhase(BLINK_MIN_INTERVAL_MS + 20)).toBe("waiting");
    const second = createCompanionBlinkScheduler(() => 0, 1000);
    expect(second.getNextBlinkAt()).toBe(1000 + BLINK_MIN_INTERVAL_MS);
    expect(second.sample(1000 + BLINK_MIN_INTERVAL_MS + 20)).toBeGreaterThan(0);
  });

  it("returns interrupted to idle and invalidates old resets", () => {
    vi.useFakeTimers();
    const reset = vi.fn();
    const scheduler = createInterruptedResetScheduler(reset, 320);
    scheduler.schedule();
    scheduler.invalidate();
    vi.advanceTimersByTime(400);
    expect(reset).not.toHaveBeenCalled();
    scheduler.schedule();
    vi.advanceTimersByTime(320);
    expect(reset).toHaveBeenCalledOnce();
    scheduler.dispose();
    scheduler.schedule();
    vi.advanceTimersByTime(400);
    expect(reset).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
