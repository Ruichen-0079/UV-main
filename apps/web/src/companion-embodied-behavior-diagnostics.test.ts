import { createCorrelatedEmbodiedBehavior } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import {
  appendCompanionEmbodiedBehaviorDiagnostic,
  COMPANION_EMBODIED_BEHAVIOR_DIAGNOSTIC_LIMIT,
  type CompanionEmbodiedBehaviorDiagnosticEntry
} from "./companion-embodied-behavior-diagnostics.js";

function projection(index: number) {
  return createCorrelatedEmbodiedBehavior({
    version: "embodied-behavior-7b.v1",
    behavior: {
      version: "embodied-behavior-7a.v1",
      kind: "GAZE",
      cause: {
        kind: "lifecycle",
        reference: `request-7ac-${index}`
      },
      target: "down-thoughtful",
      strength: 1
    },
    sourceInstance: {
      reference: `intent-7ac-${index}`,
      createdAtMs: index
    },
    correlation: {
      kind: "turn",
      reference: `request-7ac-${index}`
    }
  });
}

describe("Phase 7AC embodied behavior diagnostics", () => {
  it("records canonical semantic observations in a bounded oldest-first ledger", () => {
    const ledger: CompanionEmbodiedBehaviorDiagnosticEntry[] = [];

    for (let index = 0; index < COMPANION_EMBODIED_BEHAVIOR_DIAGNOSTIC_LIMIT + 5; index += 1) {
      appendCompanionEmbodiedBehaviorDiagnostic(ledger, projection(index), index);
    }

    expect(ledger).toHaveLength(COMPANION_EMBODIED_BEHAVIOR_DIAGNOSTIC_LIMIT);
    expect(ledger[0]).toMatchObject({
      atMs: 5,
      classification: "semantic",
      projection: {
        sourceInstance: { reference: "intent-7ac-5" },
        correlation: { kind: "turn", reference: "request-7ac-5" }
      }
    });
    expect(ledger.at(-1)).toMatchObject({
      atMs: COMPANION_EMBODIED_BEHAVIOR_DIAGNOSTIC_LIMIT + 4,
      classification: "semantic",
      projection: {
        sourceInstance: {
          reference: `intent-7ac-${COMPANION_EMBODIED_BEHAVIOR_DIAGNOSTIC_LIMIT + 4}`
        }
      }
    });
    expect(ledger.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(JSON.stringify(ledger)).not.toContain("effectId");
    expect(JSON.stringify(ledger)).not.toContain("traceId");
    expect(JSON.stringify(ledger)).not.toContain("provider");
    expect(JSON.stringify(ledger)).not.toContain("device");
  });
});
