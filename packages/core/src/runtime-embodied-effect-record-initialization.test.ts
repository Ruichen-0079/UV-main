import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
  initializeRuntimeEmbodiedEffectRecord
} from "./runtime-embodied-effect-record-initialization.js";

function behavior() {
  return {
    version: "embodied-behavior-7b.v1",
    behavior: {
      version: "embodied-behavior-7a.v1",
      kind: "EXPRESSION",
      cause: { kind: "user-interaction", reference: "turn-1" },
      intent: "acknowledge-interrupt"
    },
    sourceInstance: { reference: "intent-1", createdAtMs: 100 },
    correlation: { kind: "turn", reference: "turn-1" }
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    version: "runtime-embodied-effect-identity-7g.v1",
    effectId: "runtime-effect:7g:1",
    behavior: behavior(),
    ...overrides
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
    identity: identity(),
    policyAllowsEmbodiedEffect: true,
    ...overrides
  };
}

describe("Phase 7T Runtime embodied-effect record initialization", () => {
  it("binds one canonical 7G identity to one matching ADMITTED snapshot", () => {
    const decision = initializeRuntimeEmbodiedEffectRecord(input());

    expect(decision.status).toBe("RECORD_INITIALIZED");
    if (decision.status !== "RECORD_INITIALIZED") return;

    expect(decision.record).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
      identity: identity(),
      snapshot: {
        version: "runtime-embodied-effect-state-commit-7o.v1",
        effectId: "runtime-effect:7g:1",
        state: "ADMITTED"
      }
    });
    expect(decision.initialization.status).toBe("SNAPSHOT_INITIALIZED");
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.record)).toBe(true);
    expect(Object.isFrozen(decision.record.identity)).toBe(true);
    expect(Object.isFrozen(decision.record.snapshot)).toBe(true);
  });

  it("creates no record when 7S/7I policy admission rejects the effect", () => {
    const decision = initializeRuntimeEmbodiedEffectRecord(
      input({ policyAllowsEmbodiedEffect: false })
    );

    expect(decision).toMatchObject({
      version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
      status: "RECORD_NOT_CREATED",
      effectId: "runtime-effect:7g:1",
      initialization: {
        status: "SNAPSHOT_NOT_CREATED",
        admission: { status: "REJECTED", reason: "POLICY_DENIED" }
      }
    });
    expect(decision).not.toHaveProperty("record");
  });

  it("reuses 7G validation for behavior canonicalization and effect-ID distinctness", () => {
    expect(() =>
      initializeRuntimeEmbodiedEffectRecord(
        input({ identity: identity({ effectId: "turn-1" }) })
      )
    ).toThrow(/distinct/);

    expect(() =>
      initializeRuntimeEmbodiedEffectRecord(
        input({
          identity: identity({ behavior: { ...behavior(), device: "live2d" } })
        })
      )
    ).toThrow();
  });

  it("fails closed on malformed identity/version/policy before record creation", () => {
    expect(() =>
      initializeRuntimeEmbodiedEffectRecord(
        input({ identity: { ...identity(), version: "runtime-embodied-effect-identity-future.v9" } })
      )
    ).toThrow(/7G/);
    expect(() =>
      initializeRuntimeEmbodiedEffectRecord(
        input({ identity: { ...identity(), effectId: "runtime/effect/1" } })
      )
    ).toThrow();
    expect(() =>
      initializeRuntimeEmbodiedEffectRecord(input({ policyAllowsEmbodiedEffect: "yes" }))
    ).toThrow(/boolean/);
    expect(() =>
      initializeRuntimeEmbodiedEffectRecord(
        input({ version: "runtime-embodied-effect-record-initialization-future.v9" })
      )
    ).toThrow(/version/);
  });

  it("does not accept lifecycle, holder, publication, Presentation, or persistence authority", () => {
    for (const extra of [
      { snapshot: { state: "STARTED" } },
      { currentEffectId: "runtime-effect:7g:1" },
      { store: true },
      { manager: true },
      { eventBus: "runtime" },
      { publish: true },
      { device: "live2d" },
      { persist: true },
      { memoryTruth: true }
    ]) {
      expect(() => initializeRuntimeEmbodiedEffectRecord(input(extra))).toThrow(/unknown field/);
    }
  });
});
