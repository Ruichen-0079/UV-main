import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLINK_CONFIG,
  BLINK_MAX_INTERVAL_MS,
  BLINK_MIN_INTERVAL_MS,
  createCompanionBlinkScheduler,
  createInterruptedResetScheduler,
  getCompanionAnimation,
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
    expect(
      reduceCompanionPresence("interrupted", { type: "generation", state: "listening" })
    ).toBe("listening");
    expect(
      reduceCompanionPresence("interrupted", { type: "generation", state: "thinking" })
    ).toBe("thinking");
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

  it("keeps blink timing in the natural, centralized config ranges", () => {
    expect(BLINK_CONFIG.minIntervalMs).toBeGreaterThanOrEqual(2000);
    expect(BLINK_CONFIG.maxIntervalMs).toBeLessThanOrEqual(4800);
    expect(BLINK_CONFIG.closeMs).toBeGreaterThanOrEqual(70);
    expect(BLINK_CONFIG.closeMs).toBeLessThanOrEqual(100);
    expect(BLINK_CONFIG.holdMs).toBeGreaterThanOrEqual(45);
    expect(BLINK_CONFIG.holdMs).toBeLessThanOrEqual(80);
    expect(BLINK_CONFIG.openMs).toBeGreaterThanOrEqual(100);
    expect(BLINK_CONFIG.openMs).toBeLessThanOrEqual(150);
    const fullBlink = BLINK_CONFIG.closeMs + BLINK_CONFIG.holdMs + BLINK_CONFIG.openMs;
    expect(fullBlink).toBeGreaterThanOrEqual(220);
    expect(fullBlink).toBeLessThanOrEqual(330);
    expect(BLINK_CONFIG.doubleBlinkProbability).toBeGreaterThanOrEqual(0.1);
    expect(BLINK_CONFIG.doubleBlinkProbability).toBeLessThanOrEqual(0.16);
  });

  it("uses injected randomness for bounded, non-fixed blink intervals", () => {
    const earliest = createCompanionBlinkScheduler(() => 0, 0);
    const latest = createCompanionBlinkScheduler(() => 1, 0);
    expect(earliest.getNextBlinkAt()).toBe(BLINK_MIN_INTERVAL_MS);
    expect(latest.getNextBlinkAt()).toBe(BLINK_MAX_INTERVAL_MS);
    expect(latest.getNextBlinkAt()).not.toBe(
      (BLINK_MIN_INTERVAL_MS + BLINK_MAX_INTERVAL_MS) / 2
    );
    expect(earliest.getPhase(0)).toBe("waiting");
    expect(earliest.getPhase(BLINK_MIN_INTERVAL_MS + 20)).toBe("closing");
    expect(earliest.getPhase(BLINK_MIN_INTERVAL_MS + BLINK_CONFIG.closeMs + 5)).toBe("holding");
    expect(
      earliest.getPhase(
        BLINK_MIN_INTERVAL_MS + BLINK_CONFIG.closeMs + BLINK_CONFIG.holdMs + 5
      )
    ).toBe("opening");
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
