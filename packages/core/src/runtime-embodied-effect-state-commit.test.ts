import { EMBODIED_PRESENTATION_OUTCOME_7K_VERSION } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
  commitRuntimeEmbodiedEffectState
} from "./runtime-embodied-effect-state-commit.js";

function snapshot(
  state: "ADMITTED" | "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED"
) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
    effectId: "runtime-effect:7g:1",
    state
  };
}

function report(
  outcome: "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED",
  effectId = "runtime-effect:7g:1"
) {
  return {
    version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
    effectId,
    outcome
  };
}

describe("Phase 7O immutable Runtime embodied effect state commit", () => {
  it("commits an applied ADMITTED -> STARTED transition into a new frozen snapshot", () => {
    const current = snapshot("ADMITTED");
    const decision = commitRuntimeEmbodiedEffectState({
      version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
      snapshot: current,
      report: report("STARTED")
    });

    expect(decision.status).toBe("SNAPSHOT_UPDATED");
    expect(decision.snapshot).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
      effectId: "runtime-effect:7g:1",
      state: "STARTED"
    });
    expect(decision.transition).toMatchObject({
      status: "TRANSITION_APPLIED",
      previousState: "ADMITTED",
      nextState: "STARTED"
    });
    expect(decision.snapshot).not.toBe(current);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.snapshot)).toBe(true);
  });

  it("commits STARTED -> COMPLETED only through the existing 7M legality rules", () => {
    expect(
      commitRuntimeEmbodiedEffectState({
        version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
        snapshot: snapshot("STARTED"),
        report: report("COMPLETED")
      })
    ).toMatchObject({
      status: "SNAPSHOT_UPDATED",
      snapshot: { state: "COMPLETED" },
      transition: { status: "TRANSITION_APPLIED", nextState: "COMPLETED" }
    });
  });

  it("keeps the snapshot unchanged for a stale report from another effect", () => {
    const decision = commitRuntimeEmbodiedEffectState({
      version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
      snapshot: snapshot("STARTED"),
      report: report("COMPLETED", "runtime-effect:7g:2")
    });

    expect(decision).toMatchObject({
      status: "SNAPSHOT_UNCHANGED",
      snapshot: { effectId: "runtime-effect:7g:1", state: "STARTED" },
      transition: {
        status: "TRANSITION_REJECTED",
        reason: "OBSERVATION_NOT_ACCEPTED"
      }
    });
  });

  it("keeps the snapshot unchanged for duplicate observations", () => {
    expect(
      commitRuntimeEmbodiedEffectState({
        version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
        snapshot: snapshot("STARTED"),
        report: report("STARTED")
      })
    ).toMatchObject({
      status: "SNAPSHOT_UNCHANGED",
      snapshot: { state: "STARTED" },
      transition: { status: "TRANSITION_NO_CHANGE", state: "STARTED" }
    });
  });

  it("keeps the snapshot unchanged for invalid sequence instead of fabricating state", () => {
    expect(
      commitRuntimeEmbodiedEffectState({
        version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
        snapshot: snapshot("ADMITTED"),
        report: report("COMPLETED")
      })
    ).toMatchObject({
      status: "SNAPSHOT_UNCHANGED",
      snapshot: { state: "ADMITTED" },
      transition: { status: "TRANSITION_REJECTED", reason: "INVALID_SEQUENCE" }
    });
  });

  it("does not allow the caller to supply separate current/admitted effect authority", () => {
    for (const extra of [
      { currentEffectId: "runtime-effect:other" },
      { admittedEffectId: "runtime-effect:other" },
      { policyAllowsEmbodiedEffect: true }
    ]) {
      expect(() =>
        commitRuntimeEmbodiedEffectState({
          version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
          snapshot: snapshot("ADMITTED"),
          report: report("STARTED"),
          ...extra
        })
      ).toThrow(/unknown field/);
    }
  });

  it("fails closed on malformed snapshot, report, and future version", () => {
    expect(() =>
      commitRuntimeEmbodiedEffectState({
        version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
        snapshot: { ...snapshot("ADMITTED"), state: "RUNNING" },
        report: report("STARTED")
      })
    ).toThrow(/state/);

    expect(() =>
      commitRuntimeEmbodiedEffectState({
        version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
        snapshot: snapshot("ADMITTED"),
        report: { ...report("STARTED"), device: "live2d" }
      })
    ).toThrow();

    expect(() =>
      commitRuntimeEmbodiedEffectState({
        version: "runtime-embodied-effect-state-commit-future.v9",
        snapshot: snapshot("ADMITTED"),
        report: report("STARTED")
      })
    ).toThrow(/version/);
  });

  it("does not create a store, publication, rendering, persistence, or Character authority", () => {
    for (const extra of [
      { eventBus: "runtime" },
      { publish: true },
      { eventId: "event-1" },
      { device: "live2d" },
      { provider: "temporary-renderer" },
      { persist: true },
      { memoryTruth: true },
      { characterProposal: { presentation: { intent: "soft-smile" } } }
    ]) {
      expect(() =>
        commitRuntimeEmbodiedEffectState({
          version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
          snapshot: snapshot("ADMITTED"),
          report: report("STARTED"),
          ...extra
        })
      ).toThrow(/unknown field/);
    }
  });
});
