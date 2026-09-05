import type { P8CorrectionApplicationResult } from "./correction.js";
import type { P8EvidenceInterpretation } from "./evidence.js";
import {
  reconstructP8Projection,
  type P8ReconstructionInput,
  type P8ReconstructionOutcome
} from "./reconstruction.js";

/**
 * Bounded main-profile landing over the existing P8-1A..1E seam.
 *
 * Memory remains the durable-evidence / provenance / validity authority and P8
 * remains the identity / persona / relationship interpretation authority. This
 * module adds no retrieval, ranking, LLM inference, affinity/intimacy/mood
 * scalar, or second TTL. It only lands the main user/persona/relationship
 * profile through the existing adapter + correction + reconstruction + existing
 * consumer seam with one additional bounded guarantee:
 *
 * Active P8 supersession (winning explicit corrections' superseded evidence
 * references) cannot continue to support KNOWN in any interpretation in the
 * same profile projection, including uncorrected interpretations that happen
 * to link the same evidence. Without this, superseded/stale evidence re-enters
 * as confirmed truth via a different interpretationReference.
 *
 * Fail-safe: a relationship KNOWN with no LONG_TERM_EVIDENCE provenance
 * (recent-only evidence-linked meaning) can never land as KNOWN. Such outcomes
 * are downgraded to PARTIAL without inventing meaning and without dropping
 * provenance. Empty-link KNOWN is P8-1D explicit-correction authority and is
 * preserved.
 */
export const P8_PROFILE_VERSION = "p8-profile.v1" as const;

export type P8MainProfileInput = P8ReconstructionInput;

export type P8MainProfileOutcome = P8ReconstructionOutcome;

export function reconstructP8MainProfile(input: P8MainProfileInput): P8MainProfileOutcome {
  const outcome = reconstructP8Projection(input);
  if (outcome.status !== "RECONSTRUCTED") {
    return outcome;
  }

  const projection = outcome.projection;
  const activeSuperseded = activeSupersededEvidenceReferences(projection);
  if (activeSuperseded.size === 0 && !hasRecentOnlyKnown(projection)) {
    return outcome;
  }

  const interpretations = Object.freeze(
    projection.interpretations.map((interpretation) =>
      boundProfileInterpretation(interpretation, activeSuperseded)
    )
  );
  const targetableInterpretations =
    projection.targetableInterpretations === undefined
      ? undefined
      : Object.freeze(
          projection.targetableInterpretations.map((binding) =>
            Object.freeze({
              interpretationReference: binding.interpretationReference,
              interpretation: boundProfileInterpretation(
                binding.interpretation,
                activeSuperseded
              )
            })
          )
        );

  const bounded: P8CorrectionApplicationResult = Object.freeze({
    ...projection,
    interpretations,
    ...(targetableInterpretations === undefined ? {} : { targetableInterpretations })
  });

  return Object.freeze({
    status: "RECONSTRUCTED" as const,
    versions: outcome.versions,
    projection: bounded
  });
}

function activeSupersededEvidenceReferences(
  projection: P8CorrectionApplicationResult
): ReadonlySet<string> {
  const winners = new Set(
    projection.correctionAudits
      .filter(
        (audit) =>
          audit.supersededByCorrectionReference === undefined &&
          audit.currentStatus !== "CONFLICTING"
      )
      .map((audit) => audit.correctionReference)
  );
  const active = new Set<string>();
  for (const reference of projection.supersededReferences) {
    if (reference.kind === "EVIDENCE" && winners.has(reference.supersededByCorrectionReference)) {
      active.add(reference.reference);
    }
  }
  return active;
}

function hasRecentOnlyKnown(projection: P8CorrectionApplicationResult): boolean {
  return (
    projection.interpretations.some((interpretation) =>
      isRecentOnlyKnown(interpretation)
    ) ||
    (projection.targetableInterpretations ?? []).some((binding) =>
      isRecentOnlyKnown(binding.interpretation)
    )
  );
}

function isRecentOnlyKnown(interpretation: P8EvidenceInterpretation): boolean {
  if (interpretation.status !== "KNOWN") {
    return false;
  }
  if (interpretation.evidenceLinks.length === 0) {
    // Empty-link KNOWN is explicit-correction authority (P8-1D clears links on
    // REVISE); it is not recent-conversation evidence and must not be capped.
    return false;
  }
  if (interpretation.provenance.length === 0) {
    return false;
  }
  return !interpretation.provenance.some(
    (provenance) => provenance.channel === "LONG_TERM_EVIDENCE"
  );
}

function boundProfileInterpretation(
  interpretation: P8EvidenceInterpretation,
  activeSuperseded: ReadonlySet<string>
): P8EvidenceInterpretation {
  if (interpretation.status !== "KNOWN") {
    return interpretation;
  }

  if (interpretation.evidenceLinks.length === 0) {
    // P8-1D corrected meaning: links/provenance are intentionally cleared and
    // authority comes from the winning explicit correction, not evidence.
    return interpretation;
  }

  const touchesSuperseded = interpretation.evidenceLinks.some((link) =>
    activeSuperseded.has(link.evidenceReference)
  );
  if (touchesSuperseded) {
    return Object.freeze({
      ...cloneInterpretationShape(interpretation),
      status: "PARTIAL" as const,
      support: "LIMITED" as const
    });
  }

  if (isRecentOnlyKnown(interpretation)) {
    return Object.freeze({
      ...cloneInterpretationShape(interpretation),
      status: "PARTIAL" as const,
      support: "LIMITED" as const
    });
  }

  return interpretation;
}

function cloneInterpretationShape(
  interpretation: P8EvidenceInterpretation
): P8EvidenceInterpretation {
  return Object.freeze({
    interpretationVersion: interpretation.interpretationVersion,
    domain: interpretation.domain,
    accessStatus: interpretation.accessStatus,
    status: interpretation.status,
    support: interpretation.support,
    ...(interpretation.meaning === undefined ? {} : { meaning: interpretation.meaning }),
    evidenceLinks: interpretation.evidenceLinks,
    provenance: interpretation.provenance,
    conflictReferences: interpretation.conflictReferences
  });
}
