import { describe, expect, it } from "vitest";
import {
  createInitialProactiveConsentState,
  reduceProactiveConsent,
  type ProactiveConsentState
} from "./proactive-consent.js";
import { evaluateProactiveTurnAdmission } from "./proactive-turn-admission.js";

function read(
  state: ProactiveConsentState,
  revision: number,
  enabled: boolean
): ProactiveConsentState {
  return reduceProactiveConsent(state, { type: "settings-view", revision, enabled });
}

function invalidate(state: ProactiveConsentState, revision: number): ProactiveConsentState {
  return reduceProactiveConsent(state, {
    type: "settings-changed",
    revision,
    changedSections: ["proactive"]
  });
}

describe("proactive text turn admission", () => {
  it("accepts only an authoritative current enabled projection", () => {
    expect(
      evaluateProactiveTurnAdmission(read(createInitialProactiveConsentState(), 1, true))
    ).toEqual({ decision: "accepted", reason: "consent-enabled" });
  });

  it("denies an authoritative persisted false projection", () => {
    expect(
      evaluateProactiveTurnAdmission(read(createInitialProactiveConsentState(), 1, false))
    ).toEqual({ decision: "denied", reason: "consent-disabled" });
  });

  it("denies the initial unknown projection and a failed read", () => {
    const initial = createInitialProactiveConsentState();
    expect(evaluateProactiveTurnAdmission(initial)).toEqual({
      decision: "denied",
      reason: "consent-unavailable"
    });

    const failed = reduceProactiveConsent(initial, {
      type: "settings-read-failed",
      requestRevision: 2
    });
    expect(evaluateProactiveTurnAdmission(failed)).toEqual({
      decision: "denied",
      reason: "consent-unavailable"
    });
  });

  it("denies a newer proactive settings invalidation until a current view returns", () => {
    const ready = read(createInitialProactiveConsentState(), 3, true);
    const invalidated = invalidate(ready, 4);

    expect(evaluateProactiveTurnAdmission(invalidated)).toEqual({
      decision: "denied",
      reason: "consent-unavailable"
    });
    expect(evaluateProactiveTurnAdmission(read(invalidated, 4, true))).toEqual({
      decision: "accepted",
      reason: "consent-enabled"
    });
  });

  it("fails closed for an inconsistent revision projection", () => {
    expect(
      evaluateProactiveTurnAdmission({
        enabled: true,
        status: "ready",
        revisionFloor: 5,
        projectedRevision: 4
      })
    ).toEqual({ decision: "denied", reason: "consent-unavailable" });
  });
});
