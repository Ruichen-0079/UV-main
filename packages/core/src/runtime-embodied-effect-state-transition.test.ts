import { EMBODIED_PRESENTATION_OUTCOME_7K_VERSION } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
  decideRuntimeEmbodiedEffectStateTransition
} from "./runtime-embodied-effect-state-transition.js";

function report(outcome: "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED") {
  return {
    version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
    effectId: "runtime-effect:7g:1",
    outcome
  };
}

function transitionInput(
  currentState: "ADMITTED" | "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED",
  outcome: "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED",
  overrides: Record<string, unknown> = {}
) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
    report: report(outcome),
    currentEffectId: "runtime-effect:7g:1",
    admittedEffectId: "runtime-effect:7g:1",
    currentState,
    ...overrides
  };
}

describe("Phase 7M Runtime embodied effect state transition", () => {
  it("applies ADMITTED -> STARTED from an accepted Presentation STARTED observation", () => {
    const decision = decideRuntimeEmbodiedEffectStateTransition(
      transitionInput("ADMITTED", "STARTED")
    );

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
      effectId: "runtime-effect:7g:1",
      status: "TRANSITION_APPLIED",
      previousState: "ADMITTED",
      nextState: "STARTED"
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("applies STARTED -> COMPLETED only after STARTED is authoritative", () => {
    expect(
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("STARTED", "COMPLETED")
      )
    ).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
      effectId: "runtime-effect:7g:1",
      status: "TRANSITION_APPLIED",
      previousState: "STARTED",
      nextState: "COMPLETED"
    });
  });

  it.each([
    ["REJECTED", "REJECTED"],
    ["FAILED", "FAILED"],
    ["INTERRUPTED", "INTERRUPTED"]
  ] as const)("allows ADMITTED -> %s for the matching terminal observation", (outcome, nextState) => {
    expect(
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("ADMITTED", outcome)
      )
    ).toMatchObject({
      status: "TRANSITION_APPLIED",
      previousState: "ADMITTED",
      nextState
    });
  });

  it.each([
    ["FAILED", "FAILED"],
    ["INTERRUPTED", "INTERRUPTED"]
  ] as const)("allows STARTED -> %s for the matching terminal observation", (outcome, nextState) => {
    expect(
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("STARTED", outcome)
      )
    ).toMatchObject({
      status: "TRANSITION_APPLIED",
      previousState: "STARTED",
      nextState
    });
  });

  it.each([
    ["STARTED", "STARTED"],
    ["COMPLETED", "COMPLETED"],
    ["REJECTED", "REJECTED"],
    ["FAILED", "FAILED"],
    ["INTERRUPTED", "INTERRUPTED"]
  ] as const)("treats duplicate authoritative %s observation as idempotent NO_CHANGE", (state, outcome) => {
    expect(
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput(state, outcome)
      )
    ).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
      effectId: "runtime-effect:7g:1",
      status: "TRANSITION_NO_CHANGE",
      state
    });
  });

  it("rejects COMPLETED before STARTED instead of fabricating a skipped lifecycle transition", () => {
    expect(
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("ADMITTED", "COMPLETED")
      )
    ).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
      effectId: "runtime-effect:7g:1",
      status: "TRANSITION_REJECTED",
      state: "ADMITTED",
      reason: "INVALID_SEQUENCE"
    });
  });

  it("rejects REJECTED after STARTED and all contradictory terminal rewrites", () => {
    expect(
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("STARTED", "REJECTED")
      ).status
    ).toBe("TRANSITION_REJECTED");

    expect(
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("COMPLETED", "FAILED")
      ).status
    ).toBe("TRANSITION_REJECTED");
  });

  it("rejects stale or unadmitted observations before lifecycle semantics are considered", () => {
    expect(
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("ADMITTED", "STARTED", {
          currentEffectId: "runtime-effect:7g:2"
        })
      )
    ).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
      effectId: "runtime-effect:7g:1",
      status: "TRANSITION_REJECTED",
      state: "ADMITTED",
      reason: "OBSERVATION_NOT_ACCEPTED"
    });

    expect(
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("ADMITTED", "STARTED", {
          admittedEffectId: null
        })
      )
    ).toMatchObject({
      status: "TRANSITION_REJECTED",
      reason: "OBSERVATION_NOT_ACCEPTED"
    });
  });

  it("fails closed on invalid current state, malformed report, or malformed Runtime facts", () => {
    expect(() =>
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("ADMITTED", "STARTED", { currentState: "RUNNING" })
      )
    ).toThrow(/currentState/);

    expect(() =>
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("ADMITTED", "STARTED", {
          report: { ...report("STARTED"), device: "live2d" }
        })
      )
    ).toThrow();

    expect(() =>
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("ADMITTED", "STARTED", {
          currentEffectId: "runtime/effect/1"
        })
      )
    ).toThrow(/currentEffectId/);
  });

  it("fails closed on missing or future 7M version", () => {
    const { version: _version, ...withoutVersion } = transitionInput("ADMITTED", "STARTED");
    expect(() => decideRuntimeEmbodiedEffectStateTransition(withoutVersion)).toThrow(/version/);

    expect(() =>
      decideRuntimeEmbodiedEffectStateTransition(
        transitionInput("ADMITTED", "STARTED", {
          version: "runtime-embodied-effect-state-transition-future.v9"
        })
      )
    ).toThrow(/version/);
  });

  it("does not accept publication, device, provider, callback payload, persistence, or Character authority fields", () => {
    for (const extra of [
      { publish: true },
      { eventId: "event-1" },
      { device: "live2d" },
      { provider: "temporary-renderer" },
      { payload: { motion: "smile.motion3.json" } },
      { memoryTruth: true },
      { characterProposal: { presentation: { intent: "soft-smile" } } }
    ]) {
      expect(() =>
        decideRuntimeEmbodiedEffectStateTransition(
          transitionInput("ADMITTED", "STARTED", extra)
        )
      ).toThrow(/unknown field/);
    }
  });
});
