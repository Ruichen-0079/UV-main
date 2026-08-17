import { describe, expect, it } from "vitest";
import {
  ACTIVE_TIMER_CLOCK_RETRY_DELAY_MS,
  createBehaviorPolicyController,
  LIFECYCLE_PULSE_TTL_MS,
  type BehaviorPolicyControllerOptions
} from "./behavior-policy-controller.js";
import {
  SILENT_ATTENTION_COOLDOWN_MS,
  SILENT_ATTENTION_IDLE_DELAY_MS,
  SILENT_ATTENTION_TTL_MS
} from "./proactive-eligibility.js";
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
  let clockThrows = false;
  const timers: FakeTimer[] = [];
  const writes: Array<SuppliedGazeTarget | null> = [];
  const resolvedSessionId = arguments.length === 0 ? "test-session" : sessionId;
  const options: BehaviorPolicyControllerOptions = {
    sessionId: resolvedSessionId as string,
    controllerId: "test-controller",
    now: () => {
      if (clockThrows) throw new Error("clock unavailable");
      return now;
    },
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
    clockThrows = false;
  }

  function failClock(): void {
    clockThrows = true;
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

  return { controller, options, timers, writes, setNow, failClock, fire, latestTimer };
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

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "preserves a P1 winner when updatePresence receives invalid clock %s",
    (invalidNow) => {
      const harness = createHarness();
      harness.controller.updatePresence(presence());
      harness.controller.updatePresence(presence({ activity: "thinking" }));
      const activeTimer = harness.latestTimer();
      const writesBefore = harness.writes.length;

      harness.setNow(invalidNow);
      expect(() =>
        harness.controller.updatePresence(presence({ activity: "thinking" }))
      ).not.toThrow();

      expect(harness.controller.getState().active).toMatchObject({
        kind: "gaze",
        reason: "thinking"
      });
      expect(harness.writes).toHaveLength(writesBefore);
      expect(activeTimer.cancelled).toBe(false);
    }
  );

  it("preserves a P2 winner when updatePresence throws while reading the clock", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ transition: "interrupted" }));
    const writesBefore = harness.writes.length;

    harness.failClock();
    expect(() =>
      harness.controller.updatePresence(presence({ transition: "interrupted" }))
    ).not.toThrow();

    expect(harness.controller.getState().active).toMatchObject({
      kind: "reaction",
      reason: "interrupt-acknowledgement"
    });
    expect(harness.writes).toHaveLength(writesBefore);
  });

  it.each([
    ["P0", { activity: "listening" }, "attention"],
    ["P1", { activity: "thinking" }, "gaze"],
    ["P2", { transition: "interrupted" }, "reaction"]
  ] as const)(
    "preserves an active %s winner during invalid-clock visibility reevaluation",
    (_label, next, kind) => {
      const harness = createHarness();
      harness.controller.updatePresence(presence());
      harness.controller.updatePresence(presence(next));
      const writesBefore = harness.writes.length;

      harness.failClock();
      expect(() => harness.controller.updateVisibility(true)).not.toThrow();

      expect(harness.controller.getState().active.kind).toBe(kind);
      expect(harness.writes).toHaveLength(writesBefore);
    }
  );

  it("retries an active timer after an invalid clock sample and expires after recovery", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    const firstTimer = harness.latestTimer();

    harness.failClock();
    firstTimer.callback();
    expect(harness.controller.getState().active).toMatchObject({ reason: "thinking" });
    const retryTimer = harness.latestTimer();
    expect(retryTimer).not.toBe(firstTimer);
    expect(retryTimer.dueAt).toBe(ACTIVE_TIMER_CLOCK_RETRY_DELAY_MS);

    harness.setNow(LIFECYCLE_PULSE_TTL_MS.thinking);
    retryTimer.callback();
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes.at(-1)).toBeNull();
  });

  it("keeps one bounded active-timer retry across repeated invalid clock samples", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));
    const firstTimer = harness.latestTimer();

    harness.failClock();
    firstTimer.callback();
    const secondTimer = harness.latestTimer();
    secondTimer.callback();
    const thirdTimer = harness.latestTimer();
    firstTimer.callback();

    expect(harness.timers).toHaveLength(3);
    expect(thirdTimer).not.toBe(secondTimer);
    expect(harness.controller.getState().active).toMatchObject({ reason: "thinking" });
  });

  it("does not create proactive behavior when its due callback reads an invalid clock", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    const proactiveTimer = harness.latestTimer();

    harness.failClock();
    proactiveTimer.callback();

    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes).toEqual([]);
    expect(harness.timers).toHaveLength(1);
  });

  it("preserves silent attention through a bad-clock hide and cancels it after recovery", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    harness.fire(harness.latestTimer(), 12_000);
    expect(harness.controller.getState().active.kind).toBe("proactive");

    harness.failClock();
    harness.controller.updateVisibility(false);
    expect(harness.controller.getState().active.kind).toBe("proactive");

    const retryTimer = harness.latestTimer();
    harness.setNow(12_010);
    retryTimer.callback();
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes.at(-1)).toBeNull();
  });

  it("delays capability reconciliation until a valid clock sample returns", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence());
    harness.controller.updatePresence(presence({ activity: "thinking" }));

    harness.failClock();
    harness.controller.updatePresence(
      presence({
        activity: "thinking",
        capabilities: { tts: "unknown", audio: "unknown", live2d: "unavailable" }
      })
    );
    expect(harness.controller.getState().active.kind).toBe("gaze");

    harness.setNow(1);
    harness.controller.updatePresence(
      presence({
        activity: "thinking",
        capabilities: { tts: "unknown", audio: "unknown", live2d: "unavailable" }
      })
    );
    expect(harness.controller.getState().active.kind).toBe("none");
  });

  it("schedules one silent-attention pulse and returns to natural gaze", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    expect(harness.timers).toHaveLength(1);
    expect(harness.latestTimer().dueAt).toBe(SILENT_ATTENTION_IDLE_DELAY_MS);

    const proactiveTimer = harness.latestTimer();
    harness.fire(proactiveTimer, SILENT_ATTENTION_IDLE_DELAY_MS);
    expect(harness.controller.getState().active).toMatchObject({
      kind: "proactive",
      source: "idle-policy",
      reason: "silent-attention",
      priority: "P3",
      scope: "session",
      sessionId: "test-session",
      payload: { action: "silent-attention", modality: "silent" }
    });
    expect(targetWrites(harness)).toHaveLength(1);
    expect(targetWrites(harness)[0]).toMatchObject({ x: 0, y: 0.08, strength: 0.5 });

    const activeTimer = harness.latestTimer();
    expect(activeTimer.dueAt).toBe(SILENT_ATTENTION_IDLE_DELAY_MS + SILENT_ATTENTION_TTL_MS);
    harness.fire(activeTimer, activeTimer.dueAt);
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes.at(-1)).toBeNull();

    harness.setNow(100_000);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    expect(harness.timers).toHaveLength(2);
  });

  it("fails closed until visibility is explicitly supplied", () => {
    const harness = createHarness();
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    expect(harness.timers).toHaveLength(0);

    harness.controller.updateVisibility(true);
    expect(harness.timers).toHaveLength(1);
    expect(harness.latestTimer().dueAt).toBe(SILENT_ATTENTION_IDLE_DELAY_MS);
  });

  it("allows one legitimate early proactive reschedule and fences duplicates", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    const firstTimer = harness.latestTimer();

    harness.fire(firstTimer, SILENT_ATTENTION_IDLE_DELAY_MS - 1);
    expect(harness.timers).toHaveLength(2);
    const secondTimer = harness.latestTimer();
    expect(secondTimer).not.toBe(firstTimer);

    harness.fire(firstTimer, SILENT_ATTENTION_IDLE_DELAY_MS - 1);
    expect(harness.timers).toHaveLength(2);
    expect(harness.controller.getState().active.kind).toBe("none");

    harness.fire(secondTimer, SILENT_ATTENTION_IDLE_DELAY_MS);
    expect(harness.timers).toHaveLength(3);
    expect(harness.controller.getState().active).toMatchObject({
      kind: "proactive",
      reason: "silent-attention"
    });
  });

  it("cancels a pending proactive timer for last-second interaction", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    const proactiveTimer = harness.latestTimer();

    harness.setNow(SILENT_ATTENTION_IDLE_DELAY_MS - 1);
    harness.controller.updatePresence(presence({ connectivity: "online", activity: "listening" }));
    harness.fire(proactiveTimer, SILENT_ATTENTION_IDLE_DELAY_MS);

    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      reason: "listening-entry"
    });
    expect(harness.timers).toHaveLength(2);
  });

  it("cancels active silent attention when the window becomes hidden", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    harness.fire(harness.latestTimer(), SILENT_ATTENTION_IDLE_DELAY_MS);
    const activeTimer = harness.latestTimer();
    expect(harness.controller.getState().active.kind).toBe("proactive");

    harness.controller.updateVisibility(false);
    harness.fire(activeTimer, SILENT_ATTENTION_IDLE_DELAY_MS + SILENT_ATTENTION_TTL_MS);
    expect(harness.controller.getState().active.kind).toBe("none");
    expect(harness.writes.at(-1)).toBeNull();
  });

  it("cancels active silent attention when lifecycle or speech becomes busy", () => {
    const lifecycleHarness = createHarness();
    lifecycleHarness.controller.updateVisibility(true);
    lifecycleHarness.controller.updatePresence(presence({ connectivity: "online" }));
    lifecycleHarness.fire(lifecycleHarness.latestTimer(), SILENT_ATTENTION_IDLE_DELAY_MS);
    lifecycleHarness.controller.updatePresence(
      presence({ connectivity: "online", lifecycle: "active" })
    );
    expect(lifecycleHarness.controller.getState().active.kind).toBe("none");

    const speechHarness = createHarness();
    speechHarness.controller.updateVisibility(true);
    speechHarness.controller.updatePresence(presence({ connectivity: "online" }));
    speechHarness.fire(speechHarness.latestTimer(), SILENT_ATTENTION_IDLE_DELAY_MS);
    speechHarness.controller.updatePresence(presence({ connectivity: "online", speech: "queued" }));
    expect(speechHarness.controller.getState().active.kind).toBe("none");
  });

  it("cancels a stale proactive callback after Live2D or connectivity loss", () => {
    for (const capabilityChange of [
      { tts: "unknown", audio: "unknown", live2d: "unavailable" },
      { tts: "unknown", audio: "unknown", live2d: "available" }
    ] as const) {
      const harness = createHarness();
      harness.controller.updateVisibility(true);
      harness.controller.updatePresence(presence({ connectivity: "online" }));
      const proactiveTimer = harness.latestTimer();
      harness.controller.updatePresence(
        presence({
          connectivity: capabilityChange.live2d === "available" ? "reconnecting" : "online",
          capabilities: capabilityChange
        })
      );
      harness.fire(proactiveTimer, SILENT_ATTENTION_IDLE_DELAY_MS);
      expect(harness.controller.getState().active.kind).toBe("none");
    }
  });

  it("does not reset silent-attention timing for TTS or audio changes", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    const proactiveTimer = harness.latestTimer();

    harness.setNow(100);
    harness.controller.updatePresence(
      presence({
        connectivity: "online",
        capabilities: { tts: "unavailable", audio: "unavailable", live2d: "available" }
      })
    );
    expect(proactiveTimer.cancelled).toBe(false);
    expect(harness.latestTimer()).toBe(proactiveTimer);
  });

  it("starts the idle delay before a temporary lifecycle pulse finishes", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));

    harness.setNow(100);
    harness.controller.updatePresence(presence({ connectivity: "online", activity: "thinking" }));
    harness.setNow(100);
    harness.controller.updatePresence(presence({ connectivity: "online", activity: "idle" }));
    expect(harness.controller.getState().active).toMatchObject({ reason: "thinking" });

    const thinkingTimer = harness.latestTimer();
    harness.fire(thinkingTimer, 100 + LIFECYCLE_PULSE_TTL_MS.thinking);
    expect(harness.latestTimer().dueAt).toBe(100 + SILENT_ATTENTION_IDLE_DELAY_MS);
  });

  it("enforces cooldown across a new idle episode", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    harness.fire(harness.latestTimer(), SILENT_ATTENTION_IDLE_DELAY_MS);
    harness.fire(harness.latestTimer(), SILENT_ATTENTION_IDLE_DELAY_MS + SILENT_ATTENTION_TTL_MS);

    harness.setNow(14_000);
    harness.controller.updatePresence(presence({ connectivity: "online", activity: "listening" }));
    harness.setNow(15_000);
    harness.controller.updatePresence(presence({ connectivity: "online" }));

    expect(harness.latestTimer().dueAt).toBe(
      SILENT_ATTENTION_IDLE_DELAY_MS + SILENT_ATTENTION_COOLDOWN_MS
    );
    harness.fire(harness.latestTimer(), 42_000);
    expect(harness.controller.getState().active).toMatchObject({
      kind: "proactive",
      reason: "silent-attention"
    });
  });

  it("does not reschedule a stale proactive callback after disposal", () => {
    const first = createHarness();
    first.controller.updateVisibility(true);
    first.controller.updatePresence(presence({ connectivity: "online" }));
    const staleTimer = first.latestTimer();
    first.controller.dispose();
    const writesAfterDispose = first.writes.length;

    first.fire(staleTimer, SILENT_ATTENTION_IDLE_DELAY_MS);
    expect(first.writes).toHaveLength(writesAfterDispose);
    expect(first.controller.getState().active.kind).toBe("none");
  });

  it("suppresses ambient attention while speech is queued without changing lifecycle policy", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    const proactiveTimer = harness.latestTimer();

    harness.setNow(100);
    harness.controller.updatePresence(presence({ connectivity: "online", speech: "queued" }));
    harness.fire(proactiveTimer, SILENT_ATTENTION_IDLE_DELAY_MS);
    expect(harness.controller.getState().active.kind).toBe("none");
  });

  it("does not let silent attention bypass P0, P1, or P2 priority", () => {
    const harness = createHarness();
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence({ connectivity: "online" }));
    harness.fire(harness.latestTimer(), SILENT_ATTENTION_IDLE_DELAY_MS);

    harness.controller.updatePresence(presence({ connectivity: "online", activity: "listening" }));
    harness.controller.updatePresence(
      presence({
        connectivity: "online",
        activity: "thinking",
        speech: "active",
        transition: "interrupted"
      })
    );
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      reason: "listening-entry",
      priority: "P0"
    });
  });
});
