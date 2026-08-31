import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
  decideRuntimeEmbodiedEffectCallbackFence
} from "./runtime-embodied-effect-fence.js";

function fenceInput(currentEffectId: string | null, callbackEffectId: string) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
    currentEffectId,
    callbackEffectId
  };
}

describe("Phase 7H Runtime embodied effect callback fence", () => {
  it("accepts only a callback bound to the exact current Runtime effect identity", () => {
    const decision = decideRuntimeEmbodiedEffectCallbackFence(
      fenceInput("runtime-effect:7g:1", "runtime-effect:7g:1")
    );

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
      status: "CURRENT"
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("marks a callback from a replaced effect as stale", () => {
    expect(
      decideRuntimeEmbodiedEffectCallbackFence(
        fenceInput("runtime-effect:7g:2", "runtime-effect:7g:1")
      )
    ).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
      status: "STALE"
    });
  });

  it("marks every callback stale when Runtime has no current effect", () => {
    expect(
      decideRuntimeEmbodiedEffectCallbackFence(fenceInput(null, "runtime-effect:7g:1"))
    ).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
      status: "STALE"
    });
  });

  it("uses exact case-sensitive identity equality", () => {
    expect(
      decideRuntimeEmbodiedEffectCallbackFence(
        fenceInput("runtime-effect:ABC", "runtime-effect:abc")
      ).status
    ).toBe("STALE");
  });

  it.each([
    "",
    " leading-space",
    "runtime/effect/1",
    "x".repeat(201)
  ])("rejects invalid callback effect ID %j", (callbackEffectId) => {
    expect(() =>
      decideRuntimeEmbodiedEffectCallbackFence(
        fenceInput("runtime-effect:7g:1", callbackEffectId)
      )
    ).toThrow(/callbackEffectId/);
  });

  it("rejects an invalid current Runtime identity instead of treating it as stale", () => {
    expect(() =>
      decideRuntimeEmbodiedEffectCallbackFence(
        fenceInput("not a valid effect id", "runtime-effect:7g:1")
      )
    ).toThrow(/currentEffectId/);
  });

  it("fails closed on missing or wrong protocol version", () => {
    expect(() =>
      decideRuntimeEmbodiedEffectCallbackFence({
        currentEffectId: "runtime-effect:7g:1",
        callbackEffectId: "runtime-effect:7g:1"
      })
    ).toThrow(/version/);

    expect(() =>
      decideRuntimeEmbodiedEffectCallbackFence({
        ...fenceInput("runtime-effect:7g:1", "runtime-effect:7g:1"),
        version: "runtime-embodied-effect-fence-future.v9"
      })
    ).toThrow(/version/);
  });

  it("does not accept callback payload, admission, publication, or device authority fields", () => {
    for (const extra of [
      { payload: { expression: "soft-smile" } },
      { admitted: true },
      { lifecycle: "COMPLETED" },
      { eventId: "event-1" },
      { device: "live2d" }
    ]) {
      expect(() =>
        decideRuntimeEmbodiedEffectCallbackFence({
          ...fenceInput("runtime-effect:7g:1", "runtime-effect:7g:1"),
          ...extra
        })
      ).toThrow(/unknown field/);
    }
  });
});
