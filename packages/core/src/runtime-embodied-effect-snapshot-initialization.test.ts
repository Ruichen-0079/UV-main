import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION,
  initializeRuntimeEmbodiedEffectSnapshot
} from "./runtime-embodied-effect-snapshot-initialization.js";
import { RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION } from "./runtime-embodied-effect-state-commit.js";

function input(overrides: Record<string, unknown> = {}) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION,
    effectId: "runtime-effect:7g:1",
    policyAllowsEmbodiedEffect: true,
    ...overrides
  };
}

describe("Phase 7S Runtime embodied-effect snapshot initialization", () => {
  it("initializes exactly one frozen ADMITTED snapshot from an admitted 7I effect", () => {
    const decision = initializeRuntimeEmbodiedEffectSnapshot(input());

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION,
      status: "SNAPSHOT_INITIALIZED",
      admission: {
        version: "runtime-embodied-effect-admission-7i.v1",
        effectId: "runtime-effect:7g:1",
        status: "ADMITTED"
      },
      snapshot: {
        version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
        effectId: "runtime-effect:7g:1",
        state: "ADMITTED"
      }
    });
    expect(Object.isFrozen(decision)).toBe(true);
    if (decision.status === "SNAPSHOT_INITIALIZED") {
      expect(Object.isFrozen(decision.snapshot)).toBe(true);
      expect(Object.isFrozen(decision.admission)).toBe(true);
    }
  });

  it("creates no snapshot when 7I policy admission is rejected", () => {
    const decision = initializeRuntimeEmbodiedEffectSnapshot(
      input({ policyAllowsEmbodiedEffect: false })
    );

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION,
      status: "SNAPSHOT_NOT_CREATED",
      admission: {
        version: "runtime-embodied-effect-admission-7i.v1",
        effectId: "runtime-effect:7g:1",
        status: "REJECTED",
        reason: "POLICY_DENIED"
      }
    });
    expect(decision).not.toHaveProperty("snapshot");
  });

  it("never allows the caller to choose an initial lifecycle state", () => {
    for (const extra of [
      { state: "STARTED" },
      { state: "COMPLETED" },
      { admittedEffectId: "runtime-effect:7g:1" },
      { currentEffectId: "runtime-effect:7g:1" }
    ]) {
      expect(() => initializeRuntimeEmbodiedEffectSnapshot(input(extra))).toThrow(/unknown field/);
    }
  });

  it("fails closed on malformed effect identity, policy verdict, or future version", () => {
    expect(() =>
      initializeRuntimeEmbodiedEffectSnapshot(input({ effectId: "runtime/effect/1" }))
    ).toThrow(/effectId/);
    expect(() =>
      initializeRuntimeEmbodiedEffectSnapshot(input({ policyAllowsEmbodiedEffect: "yes" }))
    ).toThrow(/boolean/);
    expect(() =>
      initializeRuntimeEmbodiedEffectSnapshot(
        input({ version: "runtime-embodied-effect-snapshot-initialization-future.v9" })
      )
    ).toThrow(/version/);
  });

  it("does not create holder, publication, Presentation, persistence, or Character authority", () => {
    for (const extra of [
      { store: true },
      { manager: true },
      { eventBus: "runtime" },
      { publish: true },
      { device: "live2d" },
      { provider: "renderer" },
      { memoryTruth: true },
      { characterProposal: { presentation: { intent: "soft-smile" } } }
    ]) {
      expect(() => initializeRuntimeEmbodiedEffectSnapshot(input(extra))).toThrow(/unknown field/);
    }
  });
});
