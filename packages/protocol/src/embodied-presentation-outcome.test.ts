import { describe, expect, it } from "vitest";
import {
  EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
  EmbodiedPresentationOutcomeReportSchema,
  createEmbodiedPresentationOutcomeReport
} from "./embodied-presentation-outcome.js";

function report(outcome: "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED") {
  return {
    version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
    effectId: "runtime-effect:7g:1",
    outcome
  };
}

describe("Phase 7K embodied Presentation outcome report", () => {
  it.each(["STARTED", "COMPLETED", "REJECTED", "FAILED", "INTERRUPTED"] as const)(
    "canonicalizes non-authoritative %s observation",
    (outcome) => {
      const value = createEmbodiedPresentationOutcomeReport(report(outcome));

      expect(value).toEqual(report(outcome));
      expect(Object.isFrozen(value)).toBe(true);
    }
  );

  it.each(["", " leading-space", "runtime/effect/1", "x".repeat(201)])(
    "rejects invalid Runtime effect correlation %j",
    (effectId) => {
      expect(
        EmbodiedPresentationOutcomeReportSchema.safeParse({
          ...report("COMPLETED"),
          effectId
        }).success
      ).toBe(false);
    }
  );

  it("fails closed on missing, unknown, or future outcome vocabulary", () => {
    expect(
      EmbodiedPresentationOutcomeReportSchema.safeParse({
        version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
        effectId: "runtime-effect:7g:1"
      }).success
    ).toBe(false);
    expect(
      EmbodiedPresentationOutcomeReportSchema.safeParse({
        ...report("COMPLETED"),
        outcome: "SUCCEEDED"
      }).success
    ).toBe(false);
    expect(
      EmbodiedPresentationOutcomeReportSchema.safeParse({
        ...report("COMPLETED"),
        version: "embodied-presentation-outcome-future.v9"
      }).success
    ).toBe(false);
  });

  it("does not let a COMPLETED observation claim Runtime lifecycle or publication authority", () => {
    for (const extra of [
      { authoritative: true },
      { lifecycle: "COMPLETED" },
      { admitted: true },
      { eventId: "event-1" },
      { publish: true },
      { memoryTruth: true }
    ]) {
      expect(
        EmbodiedPresentationOutcomeReportSchema.safeParse({
          ...report("COMPLETED"),
          ...extra
        }).success
      ).toBe(false);
    }
  });

  it("does not expose device, provider, timing, or raw render payload fields", () => {
    for (const extra of [
      { device: "live2d" },
      { provider: "temporary-renderer" },
      { observedAtMs: 1250 },
      { payload: { motion: "smile.motion3.json" } },
      { error: "renderer stack trace" }
    ]) {
      expect(
        EmbodiedPresentationOutcomeReportSchema.safeParse({
          ...report("FAILED"),
          ...extra
        }).success
      ).toBe(false);
    }
  });
});
