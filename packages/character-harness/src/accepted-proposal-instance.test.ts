import { describe, expect, it } from "vitest";
import {
  CHARACTER_HARNESS_ACCEPTED_PROPOSAL_INSTANCE_7X_VERSION,
  allocateCharacterHarnessAcceptedProposalInstance
} from "./accepted-proposal-instance.js";

function accepted(proposal: unknown = respondProposal()) {
  return {
    version: "character-harness-5d.v1",
    status: "ACCEPTED",
    proposal
  };
}

function respondProposal() {
  return {
    disposition: "RESPOND",
    text: "hello",
    presentation: { intent: "soft-smile" }
  };
}

describe("Phase 7X Character Harness accepted proposal instance identity", () => {
  it("allocates one Harness-owned identity for a canonical accepted presentation proposal", () => {
    const allocation = {
      reference: "character-proposal:7x:1",
      createdAtMs: 1250.5
    };
    let calls = 0;

    const result = allocateCharacterHarnessAcceptedProposalInstance(
      accepted(),
      () => {
        calls += 1;
        return allocation;
      }
    );

    expect(calls).toBe(1);
    expect(result).toEqual({
      version: CHARACTER_HARNESS_ACCEPTED_PROPOSAL_INSTANCE_7X_VERSION,
      proposalInstance: {
        reference: "character-proposal:7x:1",
        createdAtMs: 1250.5
      },
      proposal: respondProposal()
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.proposalInstance)).toBe(true);
    expect(Object.isFrozen(result.proposal)).toBe(true);
    if (result.proposal.disposition !== "RESPOND" || result.proposal.presentation === undefined) {
      throw new Error("expected canonical RESPOND proposal with presentation intent");
    }
    expect(Object.isFrozen(result.proposal.presentation)).toBe(true);

    allocation.reference = "mutated";
    allocation.createdAtMs = 9999;
    expect(result.proposalInstance).toEqual({
      reference: "character-proposal:7x:1",
      createdAtMs: 1250.5
    });
  });

  it("identifies accepted non-presentation proposals without inventing embodied authority", () => {
    const result = allocateCharacterHarnessAcceptedProposalInstance(
      accepted({ disposition: "SILENCE" }),
      () => ({ reference: "character-proposal:7x:silence", createdAtMs: 0 })
    );

    expect(result.proposal).toEqual({ disposition: "SILENCE" });
    expect(result.proposalInstance.reference).toBe("character-proposal:7x:silence");
  });

  it("rejects non-final or malformed Harness input before allocator invocation", () => {
    const invalidInputs = [
      {
        version: "character-harness-5c.v1",
        status: "ACCEPTED",
        proposal: respondProposal()
      },
      {
        version: "character-harness-5d.v1",
        status: "REPETITION_DETECTED",
        proposal: respondProposal()
      },
      accepted({ disposition: "RESPOND", text: "" }),
      { ...accepted(), effectId: "runtime-effect:7g:1" },
      { ...accepted(), requestId: "provider-request-1" },
      { ...accepted(), provider: "provider-a" },
      { ...accepted(), device: "live2d" },
      { ...accepted(), admitted: true }
    ];

    for (const input of invalidInputs) {
      let calls = 0;
      expect(() =>
        allocateCharacterHarnessAcceptedProposalInstance(input, () => {
          calls += 1;
          return { reference: "should-not-run", createdAtMs: 1 };
        })
      ).toThrow();
      expect(calls).toBe(0);
    }
  });

  it("fails closed on invalid allocator output", () => {
    const invalidAllocations = [
      { reference: "", createdAtMs: 1 },
      { reference: "bad reference", createdAtMs: 1 },
      { reference: "x".repeat(201), createdAtMs: 1 },
      { reference: "valid-ref", createdAtMs: -1 },
      { reference: "valid-ref", createdAtMs: Number.NaN },
      { reference: "valid-ref", createdAtMs: Number.POSITIVE_INFINITY },
      { reference: "valid-ref", createdAtMs: 1, effectId: "smuggled" },
      null,
      "invalid"
    ];

    for (const allocation of invalidAllocations) {
      expect(() =>
        allocateCharacterHarnessAcceptedProposalInstance(accepted(), () => allocation)
      ).toThrow();
    }
  });

  it("propagates allocator failure without retry", () => {
    const failure = new Error("allocator unavailable");
    let calls = 0;

    expect(() =>
      allocateCharacterHarnessAcceptedProposalInstance(accepted(), () => {
        calls += 1;
        throw failure;
      })
    ).toThrow(failure);
    expect(calls).toBe(1);
  });

  it("does not accept Runtime, provider, device, or execution metadata in allocation output", () => {
    for (const extra of [
      { effectId: "runtime-effect:7g:1" },
      { requestId: "request-1" },
      { provider: "provider-a" },
      { device: "live2d" },
      { admission: "ADMITTED" },
      { executed: true }
    ]) {
      expect(() =>
        allocateCharacterHarnessAcceptedProposalInstance(accepted(), () => ({
          reference: "character-proposal:7x:strict",
          createdAtMs: 10,
          ...extra
        }))
      ).toThrow();
    }
  });
});
