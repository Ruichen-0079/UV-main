import {
  currentEligibleMemoryEvents,
  type MemoryClaimProvenanceClass,
  type MemoryEvent,
  type MemoryEventVerification
} from "@companion/memory";
import type { P8EvidenceAuthorityClass, P8EvidenceScopeReference, P8EvidenceSupport } from "./evidence.js";
import {
  memorySourceClass,
  memorySupport,
  recentEvidenceReference,
  type P8RecentConversationMessageInput
} from "./adapter.js";

/**
 * Evidence view for identity mention resolution (Atom 13A).
 *
 * Memory stays the evidence authority; this module only re-shapes already
 * retrieved MemoryEvents into the bounded, provenance-preserving records P8's
 * identity interpretation consumes. It never decides what a mention means and
 * never persists anything.
 *
 * Eligibility (superseded / retracted / forgotten exclusion) is re-applied
 * here through Memory's own filter so the boundary cannot be bypassed by a
 * caller that skipped the Memory read seam.
 *
 * Acoustic provenance (`speakerId`, `voiceProfileId`, speaker clusters) is
 * never read. It belongs to 13B and cannot resolve a person here.
 */

export const P8_IDENTITY_EVIDENCE_VERSION = "p8-identity-evidence.v1" as const;

export const P8_IDENTITY_EVIDENCE_CHANNELS = ["LONG_TERM_EVIDENCE", "RECENT_CONVERSATION"] as const;

export type P8IdentityEvidenceChannel = (typeof P8_IDENTITY_EVIDENCE_CHANNELS)[number];

/** Read-side validity-window annotation keys owned by this identity seam. */
export const P8_IDENTITY_VALIDITY_METADATA_KEYS = {
  validFrom: "yuviIdentityValidFrom",
  validUntil: "yuviIdentityValidUntil"
} as const;

export type P8IdentityClaimSubjectReference = Readonly<{
  entityId: string;
  surfaceMention?: string;
}>;

export type P8IdentityEvidenceRecord = Readonly<{
  recordVersion: typeof P8_IDENTITY_EVIDENCE_VERSION;
  /** Stable evidence identity: the MemoryEvent id or a recent-message reference. */
  evidenceReference: string;
  channel: P8IdentityEvidenceChannel;
  /** Source text exactly as stored. Never rewritten to a resolved name. */
  content: string;
  authority: P8EvidenceAuthorityClass;
  support: P8EvidenceSupport;
  scopeReference: string;
  suppliedAt?: string;
  /** Atom 12 provenance class when the event is claim-bearing. */
  provenanceClass?: MemoryClaimProvenanceClass;
  verification?: MemoryEventVerification;
  /** Resolved claim subject anchor. Unresolved claims never carry one. */
  subject?: P8IdentityClaimSubjectReference;
  /** Resolved claim assertor anchor (usually the primary user). */
  assertor?: P8IdentityClaimSubjectReference;
  /** Explicit validity window when annotated; absent means not time-bounded. */
  validFrom?: string;
  validUntil?: string;
}>;

/**
 * Converts a bounded recent-conversation message into contextual identity
 * evidence. Recent messages never carry claim anchors; they can only support
 * ephemeral contextual resolution.
 */
export function recentMessageToIdentityEvidence(
  message: P8RecentConversationMessageInput,
  expectedScopeReference: P8EvidenceScopeReference
): P8IdentityEvidenceRecord {
  validateScope(expectedScopeReference);
  if (message.scopeReference.reference !== expectedScopeReference.reference) {
    throw new Error(
      `P8 identity evidence scope is not authorized: ${message.messageReference}.`
    );
  }
  if (message.role !== "user" && message.role !== "assistant") {
    throw new Error(
      `P8 identity evidence role is not recognized: ${message.messageReference}.`
    );
  }
  validateBoundedText(message.content, "recent message content", 8000);

  return Object.freeze({
    recordVersion: P8_IDENTITY_EVIDENCE_VERSION,
    evidenceReference: recentEvidenceReference(message.messageReference),
    channel: "RECENT_CONVERSATION" as const,
    content: message.content,
    authority: message.role === "assistant" ? "ASSISTANT_MODEL_GENERATED" : "EXPLICIT_USER_ORIGINATED",
    support: message.role === "assistant" ? "NON_AUTHORITATIVE" : "LIMITED",
    scopeReference: expectedScopeReference.reference,
    ...(message.suppliedAt === undefined ? {} : { suppliedAt: message.suppliedAt })
  });
}

/**
 * Converts one MemoryEvent into identity evidence. Events outside the
 * expected scope are rejected, matching the P8 evidence adapter contract.
 */
export function memoryEventToIdentityEvidence(
  event: MemoryEvent,
  expectedScopeReference: P8EvidenceScopeReference
): P8IdentityEvidenceRecord {
  validateScope(expectedScopeReference);
  if (event.scope !== expectedScopeReference.reference) {
    throw new Error(`P8 identity evidence scope is not authorized: ${event.id}.`);
  }
  const content = typeof event.content === "string" ? event.content.trim() : "";
  if (!content) {
    throw new Error(`P8 identity evidence content is empty: ${event.id}.`);
  }

  const authority = memorySourceClass(event);
  const claim = event.claim;
  const subject = identityAnchor(claim?.subject);
  const assertor = identityAnchor(claim?.assertor);
  const validity = readValidityWindow(event);

  return Object.freeze({
    recordVersion: P8_IDENTITY_EVIDENCE_VERSION,
    evidenceReference: event.id,
    channel: "LONG_TERM_EVIDENCE" as const,
    content,
    authority,
    support: memorySupport(event, authority),
    scopeReference: expectedScopeReference.reference,
    ...optionalSuppliedAt(event),
    ...(claim?.provenanceClass === undefined ? {} : { provenanceClass: claim.provenanceClass }),
    ...(event.assertion?.verification === undefined
      ? {}
      : { verification: event.assertion.verification }),
    ...(subject === undefined ? {} : { subject }),
    ...(assertor === undefined ? {} : { assertor }),
    ...(validity.validFrom === undefined ? {} : { validFrom: validity.validFrom }),
    ...(validity.validUntil === undefined ? {} : { validUntil: validity.validUntil })
  });
}

/**
 * Filters to eligible events first (Memory-owned filter), then maps. Events
 * removed by the eligibility filter are reported separately and never reach
 * interpretation.
 */
export function eligibleIdentityEvidence(
  events: readonly MemoryEvent[],
  expectedScopeReference: P8EvidenceScopeReference
): { records: readonly P8IdentityEvidenceRecord[]; excludedIneligibleCount: number } {
  const eligible = currentEligibleMemoryEvents(events);
  const excludedIneligibleCount = events.length - eligible.length;
  const records = eligible.map((event) => memoryEventToIdentityEvidence(event, expectedScopeReference));
  return Object.freeze({ records: Object.freeze(records), excludedIneligibleCount });
}

function identityAnchor(
  identity: { entityId: string | null; surfaceMention?: string | null | undefined; resolution: string } | undefined
): P8IdentityClaimSubjectReference | undefined {
  if (!identity || identity.resolution !== "resolved") return undefined;
  const entityId = typeof identity.entityId === "string" ? identity.entityId.trim() : "";
  if (!entityId) return undefined;
  const surfaceMention =
    typeof identity.surfaceMention === "string" && identity.surfaceMention.trim()
      ? identity.surfaceMention.trim()
      : undefined;
  return Object.freeze({
    entityId,
    ...(surfaceMention === undefined ? {} : { surfaceMention })
  });
}

function readValidityWindow(event: MemoryEvent): { validFrom?: string; validUntil?: string } {
  const metadata = event.metadata;
  const validFrom = readIsoMetadata(metadata, P8_IDENTITY_VALIDITY_METADATA_KEYS.validFrom);
  const validUntil = readIsoMetadata(metadata, P8_IDENTITY_VALIDITY_METADATA_KEYS.validUntil);
  return {
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil })
  };
}

function readIsoMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && Number.isFinite(Date.parse(trimmed)) ? trimmed : undefined;
}

function optionalSuppliedAt(event: MemoryEvent): { suppliedAt?: string } {
  const suppliedAt = [event.occurredAt, event.observedAt, event.recordedAt].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
  );
  return suppliedAt === undefined ? {} : { suppliedAt };
}

function validateScope(expectedScopeReference: P8EvidenceScopeReference): void {
  validateBoundedText(expectedScopeReference.reference, "evidence scope reference", 160);
}

function validateBoundedText(value: string, field: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`P8 identity ${field} must be a non-empty string of at most ${maximum} characters.`);
  }
}
