import type { ProactiveConsentState } from "./proactive-consent.js";

export type ProactiveTurnAdmissionDecision = "accepted" | "denied";

export type ProactiveTurnAdmissionReason =
  | "consent-enabled"
  | "consent-disabled"
  | "consent-unavailable";

export type ProactiveTurnAdmission =
  | { decision: "accepted"; reason: "consent-enabled" }
  | {
      decision: "denied";
      reason: "consent-disabled" | "consent-unavailable";
    };

/**
 * Decide only whether the current persisted-consent projection permits a
 * future proactive text turn. This is a permission result, not execution.
 */
export function evaluateProactiveTurnAdmission(
  consent: ProactiveConsentState
): ProactiveTurnAdmission {
  if (!isCurrentConsentProjection(consent)) {
    return { decision: "denied", reason: "consent-unavailable" };
  }
  if (consent.enabled !== true) {
    return { decision: "denied", reason: "consent-disabled" };
  }
  return { decision: "accepted", reason: "consent-enabled" };
}

function isCurrentConsentProjection(consent: ProactiveConsentState): boolean {
  return (
    consent.status === "ready" &&
    isRevision(consent.revisionFloor) &&
    typeof consent.projectedRevision === "number" &&
    isRevision(consent.projectedRevision) &&
    consent.projectedRevision >= consent.revisionFloor
  );
}

function isRevision(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
