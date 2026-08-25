import { describe, expect, it, vi } from "vitest";
import {
  createBehaviorPolicyController,
  type BehaviorPolicyControllerOptions
} from "./behavior-policy-controller.js";
import {
  SILENT_ATTENTION_IDLE_DELAY_MS,
  SILENT_ATTENTION_TTL_MS
} from "./proactive-eligibility.js";
import {
  createInitialCompanionPresence,
  type CompanionPresenceProjection
} from "./companion-presence.js";
import { createProactiveTextCandidate } from "./proactive-text-candidate.js";

type FakeTimer = {
  callback: () => void;
  dueAt: number;
  cancelled: boolean;
};

function presence(
  overrides: Partial<CompanionPresenceProjection> = {}
): CompanionPresenceProjection {
  return {
    ...createInitialCompanionPresence(),
    epoch: "turn-a",
    connectivity: "online",
    capabilities: { tts: "unknown", audio: "unknown", live2d: "available" },
    ...overrides
  };
}

function createHarness(onSilentAttentionAdmitted: () => void) {
  let now = 0;
  const timers: FakeTimer[] = [];
  const options: BehaviorPolicyControllerOptions = {
    sessionId: "candidate-test-session",
    controllerId: "candidate-test-controller",
    now: () => now,
    setTimer(callback, delayMs) {
      const timer = { callback, dueAt: now + delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(handle) {
      (handle as FakeTimer).cancelled = true;
    },
    setGazeTarget() {},
    onSilentAttentionAdmitted
  };
  const controller = createBehaviorPolicyController(options);

  return {
    controller,
    timers,
    setNow(value: number) {
      now = value;
    },
    fire(timer: FakeTimer, at = timer.dueAt) {
      now = at;
      timer.callback();
    },
    latestTimer(): FakeTimer {
      const timer = timers.at(-1);
      if (!timer) throw new Error("expected a timer");
      return timer;
    }
  };
}

describe("automatic proactive text candidate generation", () => {
  it("creates fresh candidate identities without reusing Runtime identity", () => {
    const first = createProactiveTextCandidate();
    const second = createProactiveTextCandidate();

    expect(first).toMatchObject({ kind: "proactive-text-request", modality: "text" });
    expect(second).toMatchObject({ kind: "proactive-text-request", modality: "text" });
    expect(first.decisionId).not.toBe(second.decisionId);
    expect(first.decisionId).toMatch(/^proactive-decision-/);
  });

  it("notifies exactly once after the existing silent-attention policy admits", () => {
    const admitted = vi.fn();
    const harness = createHarness(admitted);
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence());

    const eligibilityTimer = harness.latestTimer();
    expect(eligibilityTimer.dueAt).toBe(SILENT_ATTENTION_IDLE_DELAY_MS);
    expect(admitted).not.toHaveBeenCalled();

    harness.fire(eligibilityTimer);
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(harness.controller.getState().active).toMatchObject({
      kind: "proactive",
      reason: "silent-attention",
      payload: { action: "silent-attention", modality: "silent" }
    });

    // An already-queued duplicate callback is stale by the existing timer token.
    harness.fire(eligibilityTimer);
    expect(admitted).toHaveBeenCalledTimes(1);
  });

  it("does not notify when user activity invalidates the pending opportunity", () => {
    const admitted = vi.fn();
    const harness = createHarness(admitted);
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence());
    const staleEligibilityTimer = harness.latestTimer();

    harness.setNow(SILENT_ATTENTION_IDLE_DELAY_MS - 1);
    harness.controller.updatePresence(presence({ activity: "listening" }));
    harness.fire(staleEligibilityTimer, SILENT_ATTENTION_IDLE_DELAY_MS);

    expect(admitted).not.toHaveBeenCalled();
    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      reason: "listening-entry",
      priority: "P0"
    });
  });

  it("consumes the one-shot opportunity before a delivery callback can fail", () => {
    const admitted = vi.fn(() => {
      throw new Error("candidate transport unavailable");
    });
    const harness = createHarness(admitted);
    harness.controller.updateVisibility(true);
    harness.controller.updatePresence(presence());
    const eligibilityTimer = harness.latestTimer();

    expect(() => harness.fire(eligibilityTimer)).not.toThrow();
    expect(admitted).toHaveBeenCalledTimes(1);

    const activeTimer = harness.latestTimer();
    expect(activeTimer.dueAt).toBe(SILENT_ATTENTION_IDLE_DELAY_MS + SILENT_ATTENTION_TTL_MS);
    harness.fire(activeTimer);
    expect(harness.controller.getState().active.kind).toBe("none");

    harness.setNow(100_000);
    harness.controller.updatePresence(presence());
    expect(admitted).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(2);
  });
});
