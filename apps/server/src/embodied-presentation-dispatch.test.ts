import { describe, expect, it, vi } from "vitest";
import { composeServerCharacterSoftSmileEmbodiedEffect } from "./character-embodied-soft-smile-composition.js";
import { dispatchServerEmbodiedPresentationRequest } from "./embodied-presentation-dispatch.js";

function admitted() {
  return composeServerCharacterSoftSmileEmbodiedEffect(
    {
      version: "character-harness-5d.v1",
      status: "ACCEPTED",
      proposal: { disposition: "RESPOND", text: "Hello", presentation: { intent: "soft-smile" } }
    },
    { kind: "turn", reference: "turn:7ag:1" },
    {
      allocateProposalInstance: () => ({ reference: "proposal:7ag:1", createdAtMs: 1 }),
      allocateEffectId: () => "runtime-effect:7ag:1",
      policyAllowsEmbodiedEffect: () => true
    }
  );
}

describe("server embodied Presentation dispatch", () => {
  it("dispatches only the canonical request from an admitted record", () => {
    const dispatch = vi.fn();
    const result = dispatchServerEmbodiedPresentationRequest(admitted()!, dispatch);
    expect(result.status).toBe("REQUEST_DISPATCHED");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ effectId: "runtime-effect:7ag:1" });
    expect(dispatch.mock.calls[0]?.[0]).not.toHaveProperty("device");
  });

  it("does not dispatch a rejected admission", () => {
    const rejected = composeServerCharacterSoftSmileEmbodiedEffect(
      {
        version: "character-harness-5d.v1",
        status: "ACCEPTED",
        proposal: { disposition: "RESPOND", text: "Hello", presentation: { intent: "soft-smile" } }
      },
      { kind: "turn", reference: "turn:7ag:2" },
      {
        allocateProposalInstance: () => ({ reference: "proposal:7ag:2", createdAtMs: 1 }),
        allocateEffectId: () => "runtime-effect:7ag:2",
        policyAllowsEmbodiedEffect: () => false
      }
    );
    const dispatch = vi.fn();
    const result = dispatchServerEmbodiedPresentationRequest(rejected!, dispatch);
    expect(result).toMatchObject({
      status: "REQUEST_NOT_DISPATCHED",
      reason: "EFFECT_NOT_ADMITTED"
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("propagates dispatcher failure without inventing a lifecycle result", () => {
    expect(() =>
      dispatchServerEmbodiedPresentationRequest(admitted()!, () => {
        throw new Error("transport down");
      })
    ).toThrow("transport down");
  });
});
