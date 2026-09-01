import { describe, expect, it, vi } from "vitest";
import {
  allocateCharacterHarnessAcceptedProposalInstance
} from "./accepted-proposal-instance.js";
import {
  CHARACTER_HARNESS_SOFT_SMILE_PROJECTION_7Y_VERSION,
  projectCharacterHarnessSoftSmileToEmbodiedBehavior
} from "./embodied-soft-smile-projection.js";

function acceptedProposal(
  proposal: unknown = {
    disposition: "RESPOND",
    text: "hello",
    presentation: { intent: "soft-smile" }
  }
) {
  return allocateCharacterHarnessAcceptedProposalInstance(
    {
      version: "character-harness-5d.v1",
      status: "ACCEPTED",
      proposal
    },
    () => ({
      reference: "character-proposal:7x:1",
      createdAtMs: 1250.5
    })
  );
}

function input(accepted: unknown = acceptedProposal(), correlation: unknown = turnCorrelation()) {
  return {
    version: CHARACTER_HARNESS_SOFT_SMILE_PROJECTION_7Y_VERSION,
    acceptedProposal: accepted,
    correlation
  };
}

function turnCorrelation(reference = "turn-42") {
  return { kind: "turn", reference };
}

describe("Phase 7Y Character soft-smile embodied projection", () => {
  it("projects one accepted soft-smile proposal into an exact 7B expression candidate", () => {
    const canonicalize = vi.fn((candidate: unknown) => Object.freeze({ canonical: candidate }));

    const result = projectCharacterHarnessSoftSmileToEmbodiedBehavior(
      input(),
      canonicalize
    );

    expect(canonicalize).toHaveBeenCalledTimes(1);
    expect(canonicalize).toHaveBeenCalledWith({
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "EXPRESSION",
        cause: {
          kind: "character",
          reference: "character-proposal:7x:1"
        },
        intent: "soft-smile"
      },
      sourceInstance: {
        reference: "character-proposal:7x:1",
        createdAtMs: 1250.5
      },
      correlation: {
        kind: "turn",
        reference: "turn-42"
      }
    });
    expect(result).toEqual({
      canonical: {
        version: "embodied-behavior-7b.v1",
        behavior: {
          version: "embodied-behavior-7a.v1",
          kind: "EXPRESSION",
          cause: {
            kind: "character",
            reference: "character-proposal:7x:1"
          },
          intent: "soft-smile"
        },
        sourceInstance: {
          reference: "character-proposal:7x:1",
          createdAtMs: 1250.5
        },
        correlation: {
          kind: "turn",
          reference: "turn-42"
        }
      }
    });
  });

  it("does not project other Character dispositions or presentation intents", () => {
    const canonicalize = vi.fn((candidate: unknown) => candidate);
    const ineligible = [
      acceptedProposal({ disposition: "RESPOND", text: "hello" }),
      acceptedProposal({
        disposition: "RESPOND",
        text: "hello",
        presentation: { intent: "wave" }
      }),
      acceptedProposal({ disposition: "SILENCE" }),
      acceptedProposal({ disposition: "TERMINATE" }),
      acceptedProposal({ disposition: "NEED_COGNITION", focus: "clarify" })
    ];

    for (const accepted of ineligible) {
      expect(projectCharacterHarnessSoftSmileToEmbodiedBehavior(input(accepted), canonicalize)).toBeNull();
    }
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("keeps Runtime trace identity out and accepts only bounded turn correlation", () => {
    const canonicalize = vi.fn((candidate: unknown) => candidate);
    const invalidCorrelations = [
      { kind: "session", reference: "session-1" },
      { kind: "decision", reference: "decision-1" },
      { kind: "turn", reference: "" },
      { kind: "turn", reference: "bad reference" },
      { kind: "turn", reference: "turn-1", traceId: "runtime-trace-1" }
    ];

    for (const correlation of invalidCorrelations) {
      expect(
        projectCharacterHarnessSoftSmileToEmbodiedBehavior(
          input(acceptedProposal(), correlation),
          canonicalize
        )
      ).toBeNull();
    }
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("fails closed before canonicalization for malformed or authority-smuggling input", () => {
    const canonicalize = vi.fn((candidate: unknown) => candidate);
    const accepted = acceptedProposal();
    const invalid = [
      { ...input(), effectId: "runtime-effect:7g:1" },
      { ...input(), provider: "provider-a" },
      { ...input(), device: "live2d" },
      { ...input(), admitted: true },
      { ...input(), traceId: "runtime-trace-1" },
      {
        ...input(),
        acceptedProposal: { ...accepted, effectId: "runtime-effect:7g:1" }
      },
      {
        ...input(),
        acceptedProposal: {
          ...accepted,
          proposalInstance: {
            ...accepted.proposalInstance,
            effectId: "runtime-effect:7g:1"
          }
        }
      },
      { ...input(), version: "character-harness-soft-smile-projection-7z.v1" },
      null,
      "invalid"
    ];

    for (const value of invalid) {
      expect(projectCharacterHarnessSoftSmileToEmbodiedBehavior(value, canonicalize)).toBeNull();
    }
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("fails closed when canonical protocol validation rejects the candidate", () => {
    const canonicalize = vi.fn(() => {
      throw new Error("protocol rejection");
    });

    expect(
      projectCharacterHarnessSoftSmileToEmbodiedBehavior(input(), canonicalize)
    ).toBeNull();
    expect(canonicalize).toHaveBeenCalledTimes(1);
  });

  it("does not call a missing canonicalizer", () => {
    expect(
      projectCharacterHarnessSoftSmileToEmbodiedBehavior(input(), null as never)
    ).toBeNull();
  });
});
