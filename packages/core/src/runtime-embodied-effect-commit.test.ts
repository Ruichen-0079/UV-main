import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_COMMIT_7J_VERSION,
  decideRuntimeEmbodiedEffectCommitAuthorization
} from "./runtime-embodied-effect-commit.js";

function commitInput(overrides: Record<string, unknown> = {}) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_COMMIT_7J_VERSION,
    effectId: "runtime-effect:7g:1",
    policyAllowsEmbodiedEffect: true,
    currentEffectId: "runtime-effect:7g:1",
    callbackEffectId: "runtime-effect:7g:1",
    ...overrides
  };
}

describe("Phase 7J Runtime embodied effect commit authorization", () => {
  it("authorizes only an admitted callback for the exact current Runtime effect", () => {
    const decision = decideRuntimeEmbodiedEffectCommitAuthorization(commitInput());

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_COMMIT_7J_VERSION,
      effectId: "runtime-effect:7g:1",
      status: "COMMIT_AUTHORIZED"
    });
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("rejects commit when Runtime policy vetoes the effect", () => {
    expect(
      decideRuntimeEmbodiedEffectCommitAuthorization(
        commitInput({ policyAllowsEmbodiedEffect: false })
      ).status
    ).toBe("COMMIT_REJECTED");
  });

  it("rejects a callback from a replaced effect", () => {
    expect(
      decideRuntimeEmbodiedEffectCommitAuthorization(
        commitInput({ currentEffectId: "runtime-effect:7g:2" })
      ).status
    ).toBe("COMMIT_REJECTED");
  });

  it("rejects every callback when Runtime has no current effect", () => {
    expect(
      decideRuntimeEmbodiedEffectCommitAuthorization(commitInput({ currentEffectId: null })).status
    ).toBe("COMMIT_REJECTED");
  });

  it("rejects cross-effect reuse even when the callback itself is current", () => {
    const decision = decideRuntimeEmbodiedEffectCommitAuthorization(
      commitInput({
        effectId: "runtime-effect:7g:1",
        currentEffectId: "runtime-effect:7g:2",
        callbackEffectId: "runtime-effect:7g:2"
      })
    );

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_COMMIT_7J_VERSION,
      effectId: "runtime-effect:7g:1",
      status: "COMMIT_REJECTED"
    });
  });

  it("fails closed on malformed subordinate Runtime facts", () => {
    expect(() =>
      decideRuntimeEmbodiedEffectCommitAuthorization(commitInput({ effectId: "bad effect id" }))
    ).toThrow(/effectId/);
    expect(() =>
      decideRuntimeEmbodiedEffectCommitAuthorization(
        commitInput({ callbackEffectId: "runtime/effect/1" })
      )
    ).toThrow(/callbackEffectId/);
    expect(() =>
      decideRuntimeEmbodiedEffectCommitAuthorization(
        commitInput({ policyAllowsEmbodiedEffect: "yes" })
      )
    ).toThrow(/policyAllowsEmbodiedEffect/);
  });

  it("fails closed on missing or future 7J version", () => {
    const { version: _version, ...withoutVersion } = commitInput();
    expect(() => decideRuntimeEmbodiedEffectCommitAuthorization(withoutVersion)).toThrow(/version/);
    expect(() =>
      decideRuntimeEmbodiedEffectCommitAuthorization(
        commitInput({ version: "runtime-embodied-effect-commit-future.v9" })
      )
    ).toThrow(/version/);
  });

  it("does not accept callback payload, Character, device, lifecycle, or publication authority fields", () => {
    for (const extra of [
      { payload: { expression: "soft-smile" } },
      { characterProposal: { presentation: { intent: "soft-smile" } } },
      { device: "live2d" },
      { lifecycle: "COMPLETED" },
      { eventId: "event-1" },
      { publish: true }
    ]) {
      expect(() =>
        decideRuntimeEmbodiedEffectCommitAuthorization(commitInput(extra))
      ).toThrow(/unknown field/);
    }
  });
});
