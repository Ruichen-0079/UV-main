import { describe, expect, it } from "vitest";
import {
  createBehaviorPolicyController,
  LIFECYCLE_PULSE_TTL_MS
} from "./behavior-policy-controller.js";
import {
  createInitialCompanionPresence,
  type CompanionPresenceProjection
} from "./companion-presence.js";
import type { SuppliedGazeTarget } from "./companion-gaze.js";

type FakeTimer = {
  callback: () => void;
  dueAt: number;
  cancelled: boolean;
};

function createHarness() {
  let now = 0;
  const timers: FakeTimer[] = [];
  const writes: Array<SuppliedGazeTarget | null> = [];
  const controller = createBehaviorPolicyController({
    sessionId: "test-session",
    controllerId: "test-controller",
    now: () => now,
    setTimer(callback, delayMs) {
      const timer = { callback, dueAt: now + delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(handle) {
      (handle as FakeTimer).cancelled = true;
    },
    setGazeTarget(target) {
      writes.push(target);
    }
  });

  function setNow(value: number): void {
    now = value;
  }

  function fire(timer: FakeTimer, at = timer.dueAt): void {
    now = at;
    timer.callback();
  }

  function latestTimer(): FakeTimer {
    const timer = timers[timers.length - 1];
    if (!timer) throw new Error("expected a timer");
    return timer;
  }

  return { controller, timers, writes, setNow, fire, latestTimer };
}

function presence(
  overrides: Partial<CompanionPresenceProjection> = {}
): CompanionPresenceProjection {
  return {
    ...createInitialCompanionPresence(),
    epoch: "turn-a",
    capabilities: { tts: "unknown", audio: "unknown", live2d: "available" },
    ...overrides
  };
}

function targetWrites(harness: ReturnType<typeof createHarness>): SuppliedGazeTarget[] {
  return harness.writes.filter((value): value is SuppliedGazeTarget => value !== null);
}

describe("BehaviorPolicyController", () => {
  it("establishes an initial baseline without fabricating a lifecycle pulse", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes).toEqual([]);
  });

  it("emits one listening pulse and releases it while listening remains active", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.setNow(10);
    harness.controller.updatePresence(presence({ activity: "listening" }));
    expect(targetWrites(harness)).toHaveLength(1);
    expect(harness.controller.getState().active.kind).toBe("attention");

    harness.setNow(100);
    harness.controller.updatePresence(presence({ activity: "listening" }));
    expect(targetWrites(harness)).toHaveLength(1);

    harness.fire(harness.latestTimer(), 10 + LIFECYCLE_PULSE_TTL_MS.listening);
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes.at(-1)).toBeNull();
  });

  it("emits one thinking pulse and does not loop while thinking remains active", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    expect(targetWrites(harness)).toHaveLength(1);
    expect(targetWrites(harness)[0]).toMatchObject({ x: 0, y: -0.24 });

    harness.setNow(100);
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    expect(targetWrites(harness)).toHaveLength(1);
  });

  it("emits speaking only on inactive-to-active speech truth", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ speech: "active" }));
    expect(targetWrites(harness)).toHaveLength(1);
    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      reason: "speech-active"
    });

    harness.setNow(100);
    harness.controller.updatePresence(presence({ speech: "active" }));
    expect(targetWrites(harness)).toHaveLength(1);
  });

  it("emits one interruption reaction without bypassing P6-A priority", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ speech: "active" }));
    harness.controller.updatePresence(presence({ speech: "active", transition: "interrupted" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      reason: "speech-active"
    });
    expect(targetWrites(harness)).toHaveLength(1);
  });

  it("lets a higher-priority listening pulse preempt thinking and fences the old timer", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    const thinkingTimer = harness.latestTimer();
    harness.setNow(10);
    harness.controller.updatePresence(presence({ activity: "listening" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      reason: "listening-entry"
    });
    const listeningTimer = harness.latestTimer();

    harness.fire(thinkingTimer, 100);
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      reason: "listening-entry"
    });
    expect(harness.writes.at(-1)).not.toBeNull();

    harness.fire(listeningTimer, 10 + LIFECYCLE_PULSE_TTL_MS.listening);
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes.at(-1)).toBeNull();
  });

  it("replaces a same-priority thinking pulse with newer speaking and fences thinking", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    const thinkingTimer = harness.latestTimer();
    harness.setNow(10);
    harness.controller.updatePresence(presence({ activity: "thinking", speech: "active" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      reason: "speech-active"
    });
    const speakingTimer = harness.latestTimer();

    harness.fire(thinkingTimer, 100);
    expect(harness.controller.getState().active).toMatchObject({ reason: "speech-active" });
    harness.fire(speakingTimer, 10 + LIFECYCLE_PULSE_TTL_MS.speaking);
    expect(harness.controller.getState().active.kind).toBe("none");
  });

  it("reconciles a stale turn before a current lower-priority turn can be admitted", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    harness.setNow(10);
    harness.controller.updatePresence(presence({ epoch: "turn-b", activity: "idle" }));
    expect(harness.controller.getState().active.kind).toBe("none");
    harness.controller.updatePresence(presence({ epoch: "turn-b", activity: "listening" }));
    expect(harness.controller.getState().active.kind).toBe("attention");
  });

  it("keeps an early timer firing active and reschedules the same exact pulse", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    const earlyTimer = harness.latestTimer();
    harness.fire(earlyTimer, 100);
    expect(harness.controller.getState().active.kind).toBe("gaze");
    expect(harness.writes.at(-1)).not.toBeNull();
    const lateTimer = harness.latestTimer();
    expect(lateTimer).not.toBe(earlyTimer);
    harness.fire(lateTimer, LIFECYCLE_PULSE_TTL_MS.thinking);
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes.at(-1)).toBeNull();
  });

  it("releases visual policy on Live2D downgrade without replaying on recovery", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    harness.controller.updatePresence(
      presence({
        activity: "thinking",
        capabilities: { tts: "unknown", audio: "unknown", live2d: "unavailable" }
      })
    );
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes.at(-1)).toBeNull();
    harness.controller.updatePresence(
      presence({
        activity: "thinking",
        capabilities: { tts: "unknown", audio: "unknown", live2d: "available" }
      })
    );
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(targetWrites(harness)).toHaveLength(1);
  });

  it("does not let a disposed controller timer affect a replacement controller", () => {
    const first = createHarness();
    first.controller.updatePresence(presence());
    first.controller.updatePresence(presence({ activity: "thinking" }));
    const oldTimer = first.latestTimer();
    first.controller.dispose();
    expect(first.writes.at(-1)).toBeNull();

    const second = createHarness();
    second.controller.updatePresence(presence());
    second.fire(oldTimer, 100);
    expect(second.writes).toEqual([]);
    expect(second.controller.getState().active.kind).toBe("none");
  });

  it("does not throw or corrupt policy when execution fails", () => {
    let now = 0;
    const callbacks: Array<() => void> = [];
    const controller = createBehaviorPolicyController({
      sessionId: "test-session",
      now: () => now,
      setTimer(callback) {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimer() {},
      setGazeTarget() {
        throw new Error("Lumi unavailable");
      }
    });
    controller.updatePresence(presence());
    expect(() => controller.updatePresence(presence({ activity: "thinking" }))).not.toThrow();
    expect(controller.getState().active.kind).toBe("gaze");
    now = LIFECYCLE_PULSE_TTL_MS.thinking;
    expect(() => callbacks[0]?.()).not.toThrow();
    expect(controller.getState().active.kind).toBe("none");
  });
});
