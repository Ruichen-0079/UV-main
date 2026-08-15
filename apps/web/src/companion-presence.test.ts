import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLINK_CONFIG,
  BLINK_MAX_INTERVAL_MS,
  BLINK_MIN_INTERVAL_MS,
  createCompanionPresenceEpochGuard,
  createInitialCompanionPresence,
  createCompanionBlinkScheduler,
  createInterruptedResetScheduler,
  createPresenceBehaviorTransition,
  getCompanionPresentationState,
  getCompanionAnimation,
  PRESENCE_BEHAVIOR_PROFILES,
  reduceCompanionPresence,
  type CompanionPresenceEvent
} from "./companion-presence.js";

describe("normalized companion presence", () => {
  afterEach(() => vi.useRealTimers());
  it("keeps activity, queue stages, and actual playback orthogonal", () => {
    let presence = createInitialCompanionPresence();
    presence = reduceCompanionPresence(presence, { type: "turn-start", epoch: "turn-1" });
    expect(presence).toMatchObject({
      epoch: "turn-1",
      lifecycle: "active",
      activity: "thinking",
      speech: "inactive"
    });

    presence = reduceCompanionPresence(presence, {
      type: "queue",
      epoch: "turn-1",
      state: "synthesizing"
    });
    expect(presence.speech).toBe("preparing");
    expect(getCompanionPresentationState(presence)).toBe("thinking");

    presence = reduceCompanionPresence(presence, {
      type: "queue",
      epoch: "turn-1",
      state: "playing"
    });
    expect(presence.speech).toBe("queued");
    expect(getCompanionPresentationState(presence)).toBe("thinking");

    presence = reduceCompanionPresence(presence, {
      type: "playback",
      epoch: "turn-1",
      state: "started"
    });
    expect(presence.speech).toBe("active");
    expect(getCompanionPresentationState(presence)).toBe("speaking");

    presence = reduceCompanionPresence(presence, {
      type: "generation",
      epoch: "turn-1",
      state: "idle"
    });
    expect(presence).toMatchObject({
      lifecycle: "generation-complete",
      activity: "idle",
      speech: "active"
    });
    expect(getCompanionPresentationState(presence)).toBe("speaking");

    presence = reduceCompanionPresence(presence, {
      type: "playback",
      epoch: "turn-1",
      state: "ended"
    });
    expect(presence.speech).toBe("completed");
    expect(getCompanionPresentationState(presence)).toBe("idle");
  });

  it("keeps queue stop/error separate from activity", () => {
    let presence = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-1"
    });
    presence = reduceCompanionPresence(presence, {
      type: "queue",
      epoch: "turn-1",
      state: "stopped"
    });
    expect(presence).toMatchObject({
      activity: "thinking",
      speech: "cancelled",
      transition: "interrupted"
    });
    presence = reduceCompanionPresence(presence, {
      type: "transition-expired",
      epoch: "turn-1"
    });
    presence = reduceCompanionPresence(presence, {
      type: "queue",
      epoch: "turn-1",
      state: "error"
    });
    expect(presence.speech).toBe("error");
    presence = reduceCompanionPresence(presence, {
      type: "queue",
      epoch: "turn-1",
      state: "idle"
    });
    expect(presence.speech).toBe("error");
    expect(presence.activity).toBe("thinking");
  });

  it("keeps speech cancellation transient without cancelling generation", () => {
    let presence = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-1"
    });
    presence = reduceCompanionPresence(presence, {
      type: "speech-cancelled",
      epoch: "turn-1"
    });
    expect(presence).toMatchObject({
      lifecycle: "active",
      activity: "thinking",
      speech: "cancelled",
      transition: "interrupted"
    });
    presence = reduceCompanionPresence(presence, {
      type: "transition-expired",
      epoch: "turn-1"
    });
    expect(presence.transition).toBe("none");
  });

  it("rejects stale events after a newer turn starts", () => {
    let presence = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "old"
    });
    presence = reduceCompanionPresence(presence, {
      type: "turn-start",
      epoch: "new"
    });
    const current = presence;

    const staleEvents: CompanionPresenceEvent[] = [
      { type: "generation", epoch: "old", state: "thinking" as const },
      { type: "generation", epoch: "old", state: "idle" as const },
      { type: "queue", epoch: "old", state: "playing" as const },
      { type: "playback", epoch: "old", state: "started" as const }
    ];
    for (const event of staleEvents) {
      presence = reduceCompanionPresence(presence, event);
    }

    expect(presence).toEqual(current);
  });

  it("retires old turn starts before they can replace the current epoch", () => {
    const guard = createCompanionPresenceEpochGuard();
    let presence = createInitialCompanionPresence();

    if (guard.accept("turn-a")) {
      presence = reduceCompanionPresence(presence, { type: "turn-start", epoch: "turn-a" });
    }
    if (guard.accept("turn-b")) {
      presence = reduceCompanionPresence(presence, { type: "turn-start", epoch: "turn-b" });
    }
    const current = presence;

    expect(guard.accept("turn-a")).toBe(false);
    expect(presence).toEqual(current);
    expect(
      reduceCompanionPresence(presence, {
        type: "playback",
        epoch: "turn-a",
        state: "started"
      })
    ).toEqual(current);

    guard.dispose();
  });

  it("keeps all retired epochs rejected across later turns", () => {
    const guard = createCompanionPresenceEpochGuard();
    expect(guard.accept("turn-a")).toBe(true);
    expect(guard.accept("turn-b")).toBe(true);
    expect(guard.accept("turn-c")).toBe(true);
    expect(guard.accept("turn-a")).toBe(false);
    expect(guard.accept("turn-b")).toBe(false);
    expect(guard.accept("turn-c")).toBe(false);
    guard.dispose();
  });

  it("does not revive a cancelled epoch or accept duplicate terminal events", () => {
    let presence = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-1"
    });
    presence = reduceCompanionPresence(presence, {
      type: "playback",
      epoch: "turn-1",
      state: "started"
    });
    presence = reduceCompanionPresence(presence, {
      type: "generation",
      epoch: "turn-1",
      state: "interrupted"
    });
    expect(getCompanionPresentationState(presence)).toBe("speaking");
    presence = reduceCompanionPresence(presence, {
      type: "playback",
      epoch: "turn-1",
      state: "stopped"
    });
    const cancelled = presence;

    presence = reduceCompanionPresence(presence, {
      type: "generation",
      epoch: "turn-1",
      state: "thinking"
    });
    expect(presence).toEqual(cancelled);
    expect(
      reduceCompanionPresence(presence, {
        type: "playback",
        epoch: "turn-1",
        state: "stopped"
      })
    ).toEqual(cancelled);
  });

  it("invalidates activity on disconnect without making Live2D capability offline", () => {
    let presence = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-1"
    });
    presence = reduceCompanionPresence(presence, {
      type: "capability",
      capability: "live2d",
      state: "available"
    });
    presence = reduceCompanionPresence(presence, { type: "disconnect", state: "offline" });
    expect(presence).toMatchObject({
      lifecycle: "invalidated",
      activity: "idle",
      connectivity: "offline",
      capabilities: { live2d: "available" }
    });
    presence = reduceCompanionPresence(presence, { type: "connectivity", state: "online" });
    expect(presence).toMatchObject({
      lifecycle: "invalidated",
      activity: "idle",
      connectivity: "online"
    });
    presence = reduceCompanionPresence(presence, { type: "turn-start", epoch: "turn-2" });
    expect(presence).toMatchObject({ epoch: "turn-2", lifecycle: "active", activity: "thinking" });
  });

  it("does not restore interruption after generation completion", () => {
    let presence = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-1"
    });
    presence = reduceCompanionPresence(presence, {
      type: "generation",
      epoch: "turn-1",
      state: "idle"
    });
    const completed = presence;

    expect(
      reduceCompanionPresence(presence, {
        type: "generation",
        epoch: "turn-1",
        state: "interrupted"
      })
    ).toEqual(completed);
  });

  it("cleans invalidated playback without restoring interruption", () => {
    let presence = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-1"
    });
    presence = reduceCompanionPresence(presence, {
      type: "playback",
      epoch: "turn-1",
      state: "started"
    });
    presence = reduceCompanionPresence(presence, { type: "disconnect", state: "offline" });
    presence = reduceCompanionPresence(presence, {
      type: "playback",
      epoch: "turn-1",
      state: "stopped"
    });

    expect(presence).toMatchObject({
      lifecycle: "invalidated",
      activity: "idle",
      connectivity: "offline",
      speech: "cancelled",
      transition: "none"
    });
  });

  it("accepts explicit listening input without inventing an epoch", () => {
    let presence = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "interaction",
      state: "listening"
    });
    expect(presence).toMatchObject({ epoch: null, lifecycle: "none", activity: "listening" });
    presence = reduceCompanionPresence(presence, { type: "interaction", state: "idle" });
    expect(presence.activity).toBe("idle");
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
