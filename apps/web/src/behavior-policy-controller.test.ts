import { describe, expect, it } from "vitest";
import {
  createBehaviorPolicyController,
  LIFECYCLE_PULSE_TTL_MS,
  type BehaviorPolicyControllerOptions
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

function createHarness(sessionId?: unknown) {
  let now = 0;
  const timers: FakeTimer[] = [];
  const writes: Array<SuppliedGazeTarget | null> = [];
  const resolvedSessionId = arguments.length === 0 ? "test-session" : sessionId;
  const options: BehaviorPolicyControllerOptions = {
    sessionId: resolvedSessionId as string,
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
  };
  const controller = createBehaviorPolicyController(options);

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

  return { controller, options, timers, writes, setNow, fire, latestTimer };
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

  it("retires obsolete thinking before equal-clock speaking succession", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.setNow(100);
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    const thinkingTimer = harness.latestTimer();

    harness.controller.updatePresence(presence({ activity: "thinking", speech: "active" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      reason: "speech-active",
      payload: { target: "user" }
    });
    expect(targetWrites(harness).at(-1)).toMatchObject({ x: 0, y: 0.08 });

    harness.fire(thinkingTimer, 200);
    expect(harness.controller.getState().active).toMatchObject({ reason: "speech-active" });
    expect(targetWrites(harness).at(-1)).toMatchObject({ x: 0, y: 0.08 });
  });

  it("keeps P0 listening and P2 interruption priority behavior unchanged", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "listening" }));
    harness.controller.updatePresence(
      presence({ activity: "thinking", speech: "active", transition: "interrupted" })
    );
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      reason: "listening-entry"
    });
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

  it("uses session scope for listening even when a previous epoch is present", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence({ epoch: "turn-a" }));
    harness.controller.updatePresence(presence({ epoch: "turn-a", activity: "listening" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      scope: "session",
      sessionId: "test-session"
    });

    harness.setNow(10);
    harness.controller.updatePresence(presence({ epoch: "turn-b", activity: "thinking" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      scope: "session",
      sessionId: "test-session"
    });
  });

  it("uses the same session scope for epoch-null listening", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence({ epoch: null }));
    harness.controller.updatePresence(presence({ epoch: null, activity: "listening" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      scope: "session",
      sessionId: "test-session"
    });
  });

  it("does not create turn lifecycle pulses without an authoritative epoch", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence({ epoch: null }));
    harness.controller.updatePresence(presence({ epoch: null, activity: "thinking" }));
    harness.controller.updatePresence(
      presence({ epoch: null, activity: "idle", speech: "active" })
    );
    harness.controller.updatePresence(
      presence({
        epoch: null,
        activity: "idle",
        speech: "inactive",
        lifecycle: "active",
        transition: "interrupted"
      })
    );
    expect(harness.controller.getState().active.kind).toBe("none");
  });

  it("fails closed when session scope has no valid session identity", () => {
    const harness = createHarness(" ");
    harness.controller.updatePresence(presence({ epoch: "turn-a" }));
    harness.controller.updatePresence(presence({ epoch: "turn-a", activity: "listening" }));
    expect(harness.controller.getState().active.kind).toBe("none");
  });

  it.each([null, undefined, 123, true, {}, [], "", "   "])(
    "fails closed without throwing for invalid runtime session identity %j",
    (sessionId) => {
      const harness = createHarness(sessionId);
      expect(() => {
        harness.controller.updatePresence(presence({ epoch: "turn-a" }));
        harness.controller.updatePresence(presence({ epoch: "turn-a", activity: "listening" }));
      }).not.toThrow();
      expect(harness.controller.getState().active.kind).toBe("none");
      expect(harness.timers).toHaveLength(0);
      expect(harness.writes).toEqual([]);
    }
  );

  it("fails closed for undefined session identity with a null epoch", () => {
    const harness = createHarness(undefined);
    expect(() => {
      harness.controller.updatePresence(presence({ epoch: null }));
      harness.controller.updatePresence(presence({ epoch: null, activity: "listening" }));
    }).not.toThrow();
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.timers).toHaveLength(0);
    expect(harness.writes).toEqual([]);
  });

  it("keeps turn-scoped lifecycle pulses available when session identity is invalid", () => {
    const harness = createHarness(null);
    harness.controller.updatePresence(presence({ epoch: "turn-a" }));
    harness.controller.updatePresence(presence({ epoch: "turn-a", activity: "thinking" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      scope: "turn",
      reason: "thinking"
    });
  });

  it("does not let invalid listening clear a valid turn-scoped winner", () => {
    const harness = createHarness(null);
    harness.controller.updatePresence(presence({ epoch: "turn-a" }));
    harness.controller.updatePresence(presence({ epoch: "turn-a", activity: "thinking" }));
    const timerCount = harness.timers.length;

    harness.controller.updatePresence(presence({ epoch: "turn-a", activity: "listening" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      scope: "turn",
      reason: "thinking"
    });
    expect(harness.timers).toHaveLength(timerCount);
  });

  it("normalizes a valid trimmed session identity once", () => {
    const harness = createHarness("  session-a  ");
    harness.controller.updatePresence(presence({ epoch: "turn-a" }));
    harness.controller.updatePresence(presence({ epoch: "turn-a", activity: "listening" }));
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      scope: "session",
      sessionId: "session-a"
    });
  });

  it("does not read a mutated options session identity after construction", () => {
    const harness = createHarness("session-a");
    harness.controller.updatePresence(presence({ epoch: "turn-a" }));
    const mutableOptions = harness.options as unknown as { sessionId: string };
    mutableOptions.sessionId = null as unknown as string;

    expect(() =>
      harness.controller.updatePresence(presence({ epoch: "turn-a", activity: "listening" }))
    ).not.toThrow();
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      scope: "session",
      sessionId: "session-a"
    });
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

  it("fences duplicate early callbacks and permits one legitimate reschedule", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    const firstTimer = harness.latestTimer();

    harness.fire(firstTimer, 100);
    expect(harness.timers).toHaveLength(2);

    harness.fire(firstTimer, 100);
    expect(harness.timers).toHaveLength(2);
    expect(harness.controller.getState().active.kind).toBe("gaze");

    const secondTimer = harness.latestTimer();
    harness.fire(secondTimer, 200);
    expect(harness.timers).toHaveLength(3);
    expect(harness.controller.getState().active.kind).toBe("gaze");
  });

  it("does not reschedule a timer after Live2D capability downgrade", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    const timer = harness.latestTimer();
    harness.controller.updatePresence(
      presence({
        activity: "thinking",
        capabilities: { tts: "unknown", audio: "unknown", live2d: "unavailable" }
      })
    );
    const timerCount = harness.timers.length;
    harness.fire(timer, 100);
    expect(harness.timers).toHaveLength(timerCount);
    expect(harness.controller.getState().active.kind).toBe("none");
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
