import { describe, expect, it, vi } from "vitest";
import {
  CHARACTER_HARNESS_5D_VERSION,
  type CharacterHarnessRepetitionSupervision
} from "@companion/character-harness";
import { composeServerCharacterSoftSmileEmbodiedEffect } from "./character-embodied-soft-smile-composition.js";

function acceptedGeneration(
  presentationIntent: string | undefined = "soft-smile"
): CharacterHarnessRepetitionSupervision {
  return {
    version: CHARACTER_HARNESS_5D_VERSION,
    status: "ACCEPTED",
    proposal: {
      disposition: "RESPOND",
      text: "hello",
      ...(presentationIntent === undefined
        ? {}
        : { presentation: { intent: presentationIntent } })
    }
  };
}

describe("server Character soft-smile embodied composition", () => {
  it("composes one accepted soft-smile proposal into Runtime-owned identity and admission", () => {
    const allocateProposalInstance = vi.fn(() => ({
      reference: "character-proposal-1",
      createdAtMs: 100
    }));
    const allocateEffectId = vi.fn(() => "runtime-effect-1");
    const policyAllowsEmbodiedEffect = vi.fn(() => true);

    const result = composeServerCharacterSoftSmileEmbodiedEffect(
      acceptedGeneration(),
      { kind: "turn", reference: "turn-1" },
      {
        allocateProposalInstance,
        allocateEffectId,
        policyAllowsEmbodiedEffect
      }
    );

    expect(result?.status).toBe("RECORD_INITIALIZED");
    if (result?.status !== "RECORD_INITIALIZED") {
      throw new Error("Expected an initialized Runtime embodied-effect record.");
    }

    expect(result.record).toEqual({
      version: "runtime-embodied-effect-record-initialization-7t.v1",
      identity: {
        version: "runtime-embodied-effect-identity-7g.v1",
        effectId: "runtime-effect-1",
        behavior: {
          version: "embodied-behavior-7b.v1",
          behavior: {
            version: "embodied-behavior-7a.v1",
            kind: "EXPRESSION",
            cause: {
              kind: "character",
              reference: "character-proposal-1"
            },
            intent: "soft-smile"
          },
          sourceInstance: {
            reference: "character-proposal-1",
            createdAtMs: 100
          },
          correlation: {
            kind: "turn",
            reference: "turn-1"
          }
        }
      },
      snapshot: {
        version: "runtime-embodied-effect-state-commit-7o.v1",
        effectId: "runtime-effect-1",
        state: "ADMITTED"
      }
    });
    expect(allocateProposalInstance).toHaveBeenCalledTimes(1);
    expect(policyAllowsEmbodiedEffect).toHaveBeenCalledTimes(1);
    expect(policyAllowsEmbodiedEffect).toHaveBeenCalledWith(result.record.identity.behavior);
    expect(allocateEffectId).toHaveBeenCalledTimes(1);
  });

  it("preserves Runtime policy rejection without creating an admitted record", () => {
    const allocateProposalInstance = vi.fn(() => ({
      reference: "character-proposal-2",
      createdAtMs: 200
    }));
    const allocateEffectId = vi.fn(() => "runtime-effect-2");
    const policyAllowsEmbodiedEffect = vi.fn(() => false);

    const result = composeServerCharacterSoftSmileEmbodiedEffect(
      acceptedGeneration(),
      { kind: "turn", reference: "turn-2" },
      {
        allocateProposalInstance,
        allocateEffectId,
        policyAllowsEmbodiedEffect
      }
    );

    expect(result).toMatchObject({
      status: "RECORD_NOT_CREATED",
      effectId: "runtime-effect-2",
      initialization: {
        status: "SNAPSHOT_NOT_CREATED",
        admission: {
          status: "REJECTED",
          effectId: "runtime-effect-2"
        }
      }
    });
    expect(policyAllowsEmbodiedEffect).toHaveBeenCalledTimes(1);
    expect(allocateEffectId).toHaveBeenCalledTimes(1);
  });

  it("does not allocate Runtime identity or consult Runtime policy for other presentation intents", () => {
    const allocateProposalInstance = vi.fn(() => ({
      reference: "character-proposal-3",
      createdAtMs: 300
    }));
    const allocateEffectId = vi.fn(() => "runtime-effect-3");
    const policyAllowsEmbodiedEffect = vi.fn(() => true);

    const result = composeServerCharacterSoftSmileEmbodiedEffect(
      acceptedGeneration("neutral"),
      { kind: "turn", reference: "turn-3" },
      {
        allocateProposalInstance,
        allocateEffectId,
        policyAllowsEmbodiedEffect
      }
    );

    expect(result).toBeNull();
    expect(allocateProposalInstance).toHaveBeenCalledTimes(1);
    expect(policyAllowsEmbodiedEffect).not.toHaveBeenCalled();
    expect(allocateEffectId).not.toHaveBeenCalled();
  });

  it("fails before allocation when the Harness result is not an accepted 5D proposal", () => {
    const allocateProposalInstance = vi.fn(() => ({
      reference: "character-proposal-4",
      createdAtMs: 400
    }));
    const allocateEffectId = vi.fn(() => "runtime-effect-4");
    const policyAllowsEmbodiedEffect = vi.fn(() => true);

    expect(() =>
      composeServerCharacterSoftSmileEmbodiedEffect(
        {
          version: CHARACTER_HARNESS_5D_VERSION,
          status: "REPETITION_DETECTED",
          reason: "EXACT_CHARACTER_NGRAM_REPETITION",
          ngramCharacters: 4,
          observedOccurrences: 3
        },
        { kind: "turn", reference: "turn-4" },
        {
          allocateProposalInstance,
          allocateEffectId,
          policyAllowsEmbodiedEffect
        }
      )
    ).toThrow(/Character Harness accepted proposal input/);
    expect(allocateProposalInstance).not.toHaveBeenCalled();
    expect(policyAllowsEmbodiedEffect).not.toHaveBeenCalled();
    expect(allocateEffectId).not.toHaveBeenCalled();
  });

  it("keeps Runtime effect identity distinct from Character causal/source identity", () => {
    const allocateProposalInstance = vi.fn(() => ({
      reference: "shared-reference",
      createdAtMs: 500
    }));
    const allocateEffectId = vi.fn(() => "shared-reference");
    const policyAllowsEmbodiedEffect = vi.fn(() => true);

    expect(() =>
      composeServerCharacterSoftSmileEmbodiedEffect(
        acceptedGeneration(),
        { kind: "turn", reference: "turn-5" },
        {
          allocateProposalInstance,
          allocateEffectId,
          policyAllowsEmbodiedEffect
        }
      )
    ).toThrow(/must be distinct/);
    expect(policyAllowsEmbodiedEffect).toHaveBeenCalledTimes(1);
    expect(allocateEffectId).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the injected Runtime policy does not return a boolean", () => {
    const allocateProposalInstance = vi.fn(() => ({
      reference: "character-proposal-6",
      createdAtMs: 600
    }));
    const allocateEffectId = vi.fn(() => "runtime-effect-6");
    const policyAllowsEmbodiedEffect = vi.fn(() => "yes") as unknown as () => boolean;

    expect(() =>
      composeServerCharacterSoftSmileEmbodiedEffect(
        acceptedGeneration(),
        { kind: "turn", reference: "turn-6" },
        {
          allocateProposalInstance,
          allocateEffectId,
          policyAllowsEmbodiedEffect
        }
      )
    ).toThrow(/must return a boolean/);
    expect(allocateEffectId).not.toHaveBeenCalled();
  });
});
