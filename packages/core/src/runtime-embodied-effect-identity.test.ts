import { describe, expect, it, vi } from "vitest";
import {
  EMBODIED_BEHAVIOR_7A_VERSION,
  EMBODIED_BEHAVIOR_7B_VERSION
} from "@companion/protocol";
import {
  RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION,
  allocateRuntimeEmbodiedEffectIdentity
} from "./runtime-embodied-effect-identity.js";

function characterExpression() {
  return {
    version: EMBODIED_BEHAVIOR_7B_VERSION,
    behavior: {
      version: EMBODIED_BEHAVIOR_7A_VERSION,
      kind: "EXPRESSION" as const,
      cause: {
        kind: "character" as const,
        reference: "character-decision:42"
      },
      intent: "soft-smile"
    },
    sourceInstance: {
      reference: "character-proposal:42",
      createdAtMs: 1250
    },
    correlation: {
      kind: "turn" as const,
      reference: "request-42"
    }
  };
}

describe("Phase 7G Runtime embodied effect identity", () => {
  it("allocates one distinct Runtime-owned identity after revalidating 7B semantics", () => {
    const allocate = vi.fn(() => "runtime-effect:7g:1");

    const identity = allocateRuntimeEmbodiedEffectIdentity(characterExpression(), allocate);

    expect(allocate).toHaveBeenCalledTimes(1);
    expect(identity).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION,
      effectId: "runtime-effect:7g:1",
      behavior: characterExpression()
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.behavior)).toBe(true);
    expect(Object.isFrozen(identity.behavior.behavior)).toBe(true);
    expect(Object.isFrozen(identity.behavior.behavior.cause)).toBe(true);
  });

  it("rejects a caller-supplied effect identity before invoking the Runtime allocator", () => {
    const allocate = vi.fn(() => "runtime-effect:7g:2");

    expect(() =>
      allocateRuntimeEmbodiedEffectIdentity(
        { ...characterExpression(), effectId: "character-owned-effect" },
        allocate
      )
    ).toThrow();
    expect(allocate).not.toHaveBeenCalled();
  });

  it("revalidates nested 7A meaning before allocation", () => {
    const allocate = vi.fn(() => "runtime-effect:7g:3");

    expect(() =>
      allocateRuntimeEmbodiedEffectIdentity(
        {
          ...characterExpression(),
          behavior: {
            ...characterExpression().behavior,
            device: "live2d"
          }
        },
        allocate
      )
    ).toThrow();
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each([
    "",
    " leading-space",
    "runtime/effect/1",
    "x".repeat(201)
  ])("fails closed on invalid Runtime effect ID %j", (effectId) => {
    const allocate = vi.fn(() => effectId);

    expect(() => allocateRuntimeEmbodiedEffectIdentity(characterExpression(), allocate)).toThrow(
      /opaque reference/
    );
    expect(allocate).toHaveBeenCalledTimes(1);
  });

  it.each([
    "character-decision:42",
    "character-proposal:42",
    "request-42"
  ])("rejects aliasing effect identity with semantic reference %s", (effectId) => {
    expect(() =>
      allocateRuntimeEmbodiedEffectIdentity(characterExpression(), () => effectId)
    ).toThrow(/must be distinct/);
  });

  it("snapshots caller-owned semantics before invoking the allocator", () => {
    const input = characterExpression();

    const identity = allocateRuntimeEmbodiedEffectIdentity(input, () => {
      input.behavior.cause.reference = "character-decision:mutated";
      input.sourceInstance.reference = "character-proposal:mutated";
      input.correlation.reference = "request-mutated";
      return "runtime-effect:7g:4";
    });

    expect(identity.behavior.behavior.cause.reference).toBe("character-decision:42");
    expect(identity.behavior.sourceInstance.reference).toBe("character-proposal:42");
    expect(identity.behavior.correlation.reference).toBe("request-42");
  });

  it("propagates allocator failure without retry or fabricated identity", () => {
    const allocate = vi.fn(() => {
      throw new Error("runtime allocator unavailable");
    });

    expect(() => allocateRuntimeEmbodiedEffectIdentity(characterExpression(), allocate)).toThrow(
      /runtime allocator unavailable/
    );
    expect(allocate).toHaveBeenCalledTimes(1);
  });

  it("does not accept admission, publication, provider, or device authority fields", () => {
    const allocate = vi.fn(() => "runtime-effect:7g:5");

    for (const extra of [
      { admitted: true },
      { status: "STARTED" },
      { eventId: "event-1" },
      { provider: "temporary-model" },
      { device: "live2d" }
    ]) {
      expect(() =>
        allocateRuntimeEmbodiedEffectIdentity({ ...characterExpression(), ...extra }, allocate)
      ).toThrow();
    }
    expect(allocate).not.toHaveBeenCalled();
  });
});
