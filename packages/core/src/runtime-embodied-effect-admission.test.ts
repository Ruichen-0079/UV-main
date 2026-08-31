import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
  admitRuntimeEmbodiedEffect
} from "./runtime-embodied-effect-admission.js";

function admissionInput(policyAllowsEmbodiedEffect: boolean) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
    effectId: "runtime-effect:7g:1",
    policyAllowsEmbodiedEffect
  };
}

describe("Phase 7I Runtime embodied effect admission", () => {
  it("admits one Runtime-owned effect when current policy allows it", () => {
    const decision = admitRuntimeEmbodiedEffect(admissionInput(true));

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
      effectId: "runtime-effect:7g:1",
      status: "ADMITTED"
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("rejects the same effect identity when Runtime policy vetoes it", () => {
    expect(admitRuntimeEmbodiedEffect(admissionInput(false))).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
      effectId: "runtime-effect:7g:1",
      status: "REJECTED",
      reason: "POLICY_DENIED"
    });
  });

  it("keeps admission bound to the supplied effect identity", () => {
    const first = admitRuntimeEmbodiedEffect(admissionInput(true));
    const second = admitRuntimeEmbodiedEffect({
      ...admissionInput(true),
      effectId: "runtime-effect:7g:2"
    });

    expect(first.effectId).toBe("runtime-effect:7g:1");
    expect(second.effectId).toBe("runtime-effect:7g:2");
    expect(first).not.toEqual(second);
  });

  it.each(["", " leading-space", "runtime/effect/1", "x".repeat(201)])(
    "rejects invalid effect ID %j",
    (effectId) => {
      expect(() =>
        admitRuntimeEmbodiedEffect({ ...admissionInput(true), effectId })
      ).toThrow(/effectId/);
    }
  );

  it("requires an explicit boolean Runtime policy verdict", () => {
    expect(() =>
      admitRuntimeEmbodiedEffect({
        version: RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
        effectId: "runtime-effect:7g:1"
      })
    ).toThrow(/policyAllowsEmbodiedEffect/);

    expect(() =>
      admitRuntimeEmbodiedEffect({
        ...admissionInput(true),
        policyAllowsEmbodiedEffect: "yes"
      })
    ).toThrow(/policyAllowsEmbodiedEffect/);
  });

  it("fails closed on missing or future version", () => {
    expect(() =>
      admitRuntimeEmbodiedEffect({
        effectId: "runtime-effect:7g:1",
        policyAllowsEmbodiedEffect: true
      })
    ).toThrow(/version/);

    expect(() =>
      admitRuntimeEmbodiedEffect({
        ...admissionInput(true),
        version: "runtime-embodied-effect-admission-future.v9"
      })
    ).toThrow(/version/);
  });

  it("does not accept semantic behavior, Character, provider, device, or lifecycle authority fields", () => {
    for (const extra of [
      { behavior: { kind: "EXPRESSION", intent: "soft-smile" } },
      { characterProposal: { presentation: { intent: "soft-smile" } } },
      { provider: "temporary-model" },
      { device: "live2d" },
      { lifecycle: "STARTED" },
      { eventId: "event-1" }
    ]) {
      expect(() =>
        admitRuntimeEmbodiedEffect({ ...admissionInput(true), ...extra })
      ).toThrow(/unknown field/);
    }
  });
});
