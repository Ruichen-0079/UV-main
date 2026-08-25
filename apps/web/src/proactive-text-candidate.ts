import type { CompanionProactiveTextRequest } from "./companion-bus.js";

let fallbackDecisionSequence = 0;

/**
 * Create one process-local candidate identity when the companion policy admits
 * a proactive opportunity. Runtime idempotency remains a later MainPage commit
 * concern and must never reuse this decision identity.
 */
export function createProactiveTextCandidate(): CompanionProactiveTextRequest {
  const uuid = globalThis.crypto?.randomUUID?.();
  const decisionId = uuid
    ? `proactive-decision-${uuid}`
    : `proactive-decision-${++fallbackDecisionSequence}`;

  return {
    kind: "proactive-text-request",
    decisionId,
    modality: "text"
  };
}
