import { describe, expect, it } from "vitest";
import { EMBODIED_BEHAVIOR_7A_VERSION } from "./embodied-behavior.js";
import {
  EMBODIED_BEHAVIOR_7B_VERSION,
  CorrelatedEmbodiedBehaviorSchema,
  createCorrelatedEmbodiedBehavior
} from "./embodied-behavior-correlation.js";

function gazeBehavior() {
  return {
    version: EMBODIED_BEHAVIOR_7A_VERSION,
    kind: "GAZE" as const,
    cause: { kind: "lifecycle" as const, reference: "turn:request-42" },
    target: "down-thoughtful" as const,
    strength: 2 as const
  };
}

describe("Phase 7B embodied behavior correlation", () => {
  it("keeps causal meaning, semantic-instance identity, and turn correlation separate", () => {
    const correlated = createCorrelatedEmbodiedBehavior({
      version: EMBODIED_BEHAVIOR_7B_VERSION,
      behavior: gazeBehavior(),
      sourceInstance: {
        reference: "behavior-intent:companion-page:3:9:thinking",
        createdAtMs: 1250.5
      },
      correlation: { kind: "turn", reference: "request-42" }
    });

    expect(correlated).toEqual({
      version: EMBODIED_BEHAVIOR_7B_VERSION,
      behavior: gazeBehavior(),
      sourceInstance: {
        reference: "behavior-intent:companion-page:3:9:thinking",
        createdAtMs: 1250.5
      },
      correlation: { kind: "turn", reference: "request-42" }
    });
    expect(Object.isFrozen(correlated)).toBe(true);
    expect(Object.isFrozen(correlated.behavior)).toBe(true);
    expect(Object.isFrozen(correlated.behavior.cause)).toBe(true);
    expect(Object.isFrozen(correlated.sourceInstance)).toBe(true);
    expect(Object.isFrozen(correlated.correlation)).toBe(true);
  });

  it.each([
    { kind: "session", reference: "companion-page-session" },
    { kind: "decision", reference: "proactive-decision-42" }
  ] as const)("accepts current $kind correlation without claiming execution", (correlation) => {
    expect(
      createCorrelatedEmbodiedBehavior({
        version: EMBODIED_BEHAVIOR_7B_VERSION,
        behavior: gazeBehavior(),
        sourceInstance: { reference: "behavior-intent:42", createdAtMs: 10 },
        correlation
      }).correlation
    ).toEqual(correlation);
  });

  it("fails closed on resource correlation before authoritative resource generations exist", () => {
    expect(
      CorrelatedEmbodiedBehaviorSchema.safeParse({
        version: EMBODIED_BEHAVIOR_7B_VERSION,
        behavior: gazeBehavior(),
        sourceInstance: { reference: "behavior-intent:42", createdAtMs: 10 },
        correlation: { kind: "resource", reference: "model:1" }
      }).success
    ).toBe(false);
  });

  it("does not admit Runtime execution, idempotency, provider, or device fields", () => {
    for (const extra of [
      { effectId: "effect-1" },
      { requestId: "request-1" },
      { idempotencyKey: "runtime-1" },
      { provider: "temporary-model" },
      { device: "live2d" }
    ]) {
      expect(
        CorrelatedEmbodiedBehaviorSchema.safeParse({
          version: EMBODIED_BEHAVIOR_7B_VERSION,
          behavior: gazeBehavior(),
          sourceInstance: { reference: "behavior-intent:42", createdAtMs: 10 },
          correlation: { kind: "turn", reference: "request-42" },
          ...extra
        }).success
      ).toBe(false);
    }
  });

  it("revalidates the complete 7A behavior instead of trusting a typed caller", () => {
    expect(() =>
      createCorrelatedEmbodiedBehavior({
        version: EMBODIED_BEHAVIOR_7B_VERSION,
        behavior: { ...gazeBehavior(), effectId: "smuggled" },
        sourceInstance: { reference: "behavior-intent:42", createdAtMs: 10 },
        correlation: { kind: "turn", reference: "request-42" }
      })
    ).toThrow();
  });

  it("snapshots caller-owned nested values", () => {
    const input = {
      version: EMBODIED_BEHAVIOR_7B_VERSION,
      behavior: {
        ...gazeBehavior(),
        cause: { kind: "lifecycle" as const, reference: "turn:request-42" }
      },
      sourceInstance: { reference: "behavior-intent:42", createdAtMs: 10 },
      correlation: { kind: "turn" as const, reference: "request-42" }
    };
    const correlated = createCorrelatedEmbodiedBehavior(input);

    input.behavior.cause.reference = "turn:mutated";
    input.sourceInstance.reference = "behavior-intent:mutated";
    input.correlation.reference = "mutated-request";

    expect(correlated.behavior.cause.reference).toBe("turn:request-42");
    expect(correlated.sourceInstance.reference).toBe("behavior-intent:42");
    expect(correlated.correlation.reference).toBe("request-42");
  });
});
