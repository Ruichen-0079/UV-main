import { EMBODIED_PRESENTATION_OUTCOME_7K_VERSION } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION,
  decideRuntimeEmbodiedPresentationOutcomeAcceptance
} from "./runtime-embodied-presentation-outcome-acceptance.js";

function report(outcome: "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED") {
  return {
    version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
    effectId: "runtime-effect:7g:1",
    outcome
  };
}

function acceptanceInput(overrides: Record<string, unknown> = {}) {
  return {
    version: RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION,
    report: report("STARTED"),
    currentEffectId: "runtime-effect:7g:1",
    admittedEffectId: "runtime-effect:7g:1",
    ...overrides
  };
}

describe("Phase 7L Runtime Presentation outcome acceptance", () => {
  it("accepts a canonical report only for the admitted current Runtime effect", () => {
    const decision = decideRuntimeEmbodiedPresentationOutcomeAcceptance(acceptanceInput());

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION,
      status: "OBSERVATION_ACCEPTED",
      report: report("STARTED")
    });
    expect(Object.isFrozen(decision)).toBe(true);
    if (decision.status === "OBSERVATION_ACCEPTED") {
      expect(Object.isFrozen(decision.report)).toBe(true);
    }
  });

  it("keeps an accepted COMPLETED report non-authoritative", () => {
    const decision = decideRuntimeEmbodiedPresentationOutcomeAcceptance(
      acceptanceInput({ report: report("COMPLETED") })
    );

    expect(decision.status).toBe("OBSERVATION_ACCEPTED");
    expect(decision).not.toHaveProperty("lifecycle");
    expect(decision).not.toHaveProperty("eventId");
    expect(decision).not.toHaveProperty("authoritative");
  });

  it("ignores a report from a replaced Runtime effect and drops its outcome", () => {
    const decision = decideRuntimeEmbodiedPresentationOutcomeAcceptance(
      acceptanceInput({
        report: report("COMPLETED"),
        currentEffectId: "runtime-effect:7g:2"
      })
    );

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION,
      status: "OBSERVATION_IGNORED",
      effectId: "runtime-effect:7g:1"
    });
    expect(decision).not.toHaveProperty("report");
    expect(decision).not.toHaveProperty("outcome");
  });

  it("ignores every report when Runtime has no current effect", () => {
    expect(
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(
        acceptanceInput({ currentEffectId: null })
      ).status
    ).toBe("OBSERVATION_IGNORED");
  });

  it("ignores a report when there is no matching admitted effect fact", () => {
    expect(
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(
        acceptanceInput({ admittedEffectId: null })
      ).status
    ).toBe("OBSERVATION_IGNORED");

    expect(
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(
        acceptanceInput({ admittedEffectId: "runtime-effect:7g:2" })
      ).status
    ).toBe("OBSERVATION_IGNORED");
  });

  it("fails closed on malformed Presentation reports before acceptance", () => {
    expect(() =>
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(
        acceptanceInput({
          report: {
            ...report("FAILED"),
            device: "live2d"
          }
        })
      )
    ).toThrow();

    expect(() =>
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(
        acceptanceInput({
          report: {
            ...report("FAILED"),
            outcome: "SUCCEEDED"
          }
        })
      )
    ).toThrow();
  });

  it("fails closed on malformed current or admitted Runtime identities", () => {
    expect(() =>
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(
        acceptanceInput({ currentEffectId: "runtime/effect/1" })
      )
    ).toThrow(/currentEffectId/);

    expect(() =>
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(
        acceptanceInput({ admittedEffectId: "runtime/effect/1" })
      )
    ).toThrow(/admittedEffectId/);

    const { admittedEffectId: _admittedEffectId, ...withoutAdmissionFact } = acceptanceInput();
    expect(() =>
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(withoutAdmissionFact)
    ).toThrow(/admittedEffectId/);
  });

  it("fails closed on missing or future 7L version", () => {
    const { version: _version, ...withoutVersion } = acceptanceInput();
    expect(() =>
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(withoutVersion)
    ).toThrow(/version/);

    expect(() =>
      decideRuntimeEmbodiedPresentationOutcomeAcceptance(
        acceptanceInput({
          version: "runtime-embodied-presentation-outcome-acceptance-future.v9"
        })
      )
    ).toThrow(/version/);
  });

  it("does not accept policy, lifecycle, publication, device, provider, or persistence authority fields", () => {
    for (const extra of [
      { policyAllowsEmbodiedEffect: true },
      { lifecycle: "COMPLETED" },
      { publish: true },
      { eventId: "event-1" },
      { device: "live2d" },
      { provider: "temporary-renderer" },
      { memoryTruth: true }
    ]) {
      expect(() =>
        decideRuntimeEmbodiedPresentationOutcomeAcceptance(acceptanceInput(extra))
      ).toThrow(/unknown field/);
    }
  });
});
