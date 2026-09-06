import { currentEligibleMemoryEvents } from "./claim.js";
import type { MemoryEvent, MemoryRetrievalOutcome, MemoryRetrievalStatus } from "./provider.js";

/**
 * Read-side identity evidence seam (Atom 13A).
 *
 * Identity mention resolution consumes Memory only as evidence. This seam is
 * the single narrow read-side entry for that consumption: it applies the
 * Atom 12 eligible filter (superseded / retracted / forgotten exclusion),
 * dedupes by canonical event id, and bounds the result size. It performs no
 * interpretation: deciding what a mention means stays in P8.
 *
 * READ-SIDE ONLY. There is no schema, write-path, or provider-contract change
 * here, and no second evidence store.
 */

export const IDENTITY_EVIDENCE_SEAM_VERSION = "memory-identity-evidence.v1" as const;

export type IdentityEvidenceSelection = Readonly<{
  seamVersion: typeof IDENTITY_EVIDENCE_SEAM_VERSION;
  /** The retrieval's own epistemic status, passed through unchanged. */
  status: MemoryRetrievalStatus;
  /** Eligible events in retrieval rank order, deduped, capped at the limit. */
  events: readonly MemoryEvent[];
  /** Events removed only because a supersession/status filter excluded them. */
  excludedIneligibleCount: number;
  /** True when eligible events were dropped solely because of the limit cap. */
  limited: boolean;
  /** Preserved diagnostic code from failed retrievals. */
  errorCode?: string | null;
}>;

export type IdentityEvidenceSelectionInput = Readonly<{
  limit: number;
}>;

/**
 * Selects the eligible, deduped, bounded evidence set for identity resolution.
 *
 * The retrieval status is never rewritten: "unavailable" and "error" stay
 * distinguishable from "empty" so a caller cannot treat a failed retrieval as
 * a no-hit retrieval.
 */
export function selectIdentityEvidence(
  outcome: MemoryRetrievalOutcome,
  input: IdentityEvidenceSelectionInput
): IdentityEvidenceSelection {
  const limit = input.limit;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Identity evidence selection limit must be a positive integer.");
  }

  if (outcome.status === "unavailable" || outcome.status === "error") {
    if (outcome.events.length > 0) {
      throw new Error(
        `Identity evidence selection received ${outcome.status} retrieval with events.`
      );
    }
    return Object.freeze({
      seamVersion: IDENTITY_EVIDENCE_SEAM_VERSION,
      status: outcome.status,
      events: Object.freeze([]),
      excludedIneligibleCount: 0,
      limited: false,
      ...(outcome.errorCode === undefined || outcome.errorCode === null
        ? {}
        : { errorCode: outcome.errorCode })
    });
  }

  const seen = new Set<string>();
  const deduped: MemoryEvent[] = [];
  for (const event of outcome.events) {
    if (!event?.id || seen.has(event.id)) continue;
    seen.add(event.id);
    deduped.push(event);
  }

  const eligible = currentEligibleMemoryEvents(deduped);
  const excludedIneligibleCount = deduped.length - eligible.length;
  const capped = eligible.slice(0, limit);

  return Object.freeze({
    seamVersion: IDENTITY_EVIDENCE_SEAM_VERSION,
    status: outcome.status,
    events: Object.freeze(capped),
    excludedIneligibleCount,
    limited: eligible.length > capped.length
  });
}
