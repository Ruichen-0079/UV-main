import type { P8EpistemicState, P8ProvenanceReference } from "./index.js";

export const P8_1B_CONTRACT_VERSION = "p8-1b.v1" as const;

export const P8_EVIDENCE_CHANNELS = ["LONG_TERM_EVIDENCE", "RECENT_CONVERSATION"] as const;

export type P8EvidenceChannel = (typeof P8_EVIDENCE_CHANNELS)[number];

export const P8_EVIDENCE_AUTHORITY_CLASSES = [
  "EXPLICIT_USER_ORIGINATED",
  "VERIFIED_SUPPORTED",
  "OBSERVED_INTERACTION",
  "WEAK_INFERRED",
  "ASSISTANT_MODEL_GENERATED"
] as const;

export type P8EvidenceAuthorityClass = (typeof P8_EVIDENCE_AUTHORITY_CLASSES)[number];

export const P8_EVIDENCE_SUPPORT_LEVELS = ["DIRECT", "LIMITED", "NON_AUTHORITATIVE"] as const;

export type P8EvidenceSupport = (typeof P8_EVIDENCE_SUPPORT_LEVELS)[number];

export const P8_EVIDENCE_ACCESS_STATES = [
  "SUCCESS_WITH_EVIDENCE",
  "SUCCESS_WITH_NO_RELEVANT_EVIDENCE",
  "PARTIAL",
  "UNAVAILABLE",
  "ERROR"
] as const;

export type P8EvidenceAccessStatus = (typeof P8_EVIDENCE_ACCESS_STATES)[number];

export const P8_INTERPRETATION_DOMAINS = [
  "BACKGROUND",
  "COMMUNICATION_PREFERENCE",
  "SHARED_HISTORY",
  "RELATIONSHIP_CONTEXT"
] as const;

export type P8InterpretationDomain = (typeof P8_INTERPRETATION_DOMAINS)[number];

export type P8EvidenceScopeReference = Readonly<{
  reference: string;
}>;

export type P8EvidenceProvenanceReference = Readonly<{
  source: "evidence";
  reference: string;
  scopeReference: P8EvidenceScopeReference;
  channel: P8EvidenceChannel;
  sourceClass: P8EvidenceAuthorityClass;
  suppliedAt?: string;
  contradictionReferences: readonly string[];
}>;

export type P8SemanticProvenanceReference = P8ProvenanceReference | P8EvidenceProvenanceReference;

export type P8AuthorizedEvidenceInput = Readonly<{
  evidenceReference: string;
  statement: string;
  sourceClass: P8EvidenceAuthorityClass;
  channel: P8EvidenceChannel;
  support: P8EvidenceSupport;
  scopeReference: P8EvidenceScopeReference;
  suppliedAt?: string;
  contradictionReferences?: readonly string[];
}>;

export type P8AuthorizedEvidence = Readonly<{
  evidenceReference: string;
  statement: string;
  sourceClass: P8EvidenceAuthorityClass;
  channel: P8EvidenceChannel;
  support: P8EvidenceSupport;
  scopeReference: P8EvidenceScopeReference;
  suppliedAt?: string;
  contradictionReferences: readonly string[];
  provenance: P8EvidenceProvenanceReference;
}>;

export type P8EvidenceAccessOutcomeInput = Readonly<{
  status: P8EvidenceAccessStatus;
  evidence: readonly (P8AuthorizedEvidence | P8AuthorizedEvidenceInput)[];
}>;

export type P8EvidenceAccessOutcome = Readonly<{
  status: P8EvidenceAccessStatus;
  evidence: readonly P8AuthorizedEvidence[];
}>;

export type P8EvidenceInterpretationInput = Readonly<{
  domain: P8InterpretationDomain;
  meaning?: string;
  access: P8EvidenceAccessOutcomeInput;
}>;

export type P8EvidenceInterpretation = Readonly<{
  interpretationVersion: typeof P8_1B_CONTRACT_VERSION;
  domain: P8InterpretationDomain;
  accessStatus: P8EvidenceAccessStatus;
  status: P8EpistemicState;
  support: P8EvidenceSupport;
  meaning?: string;
  provenance: readonly P8EvidenceProvenanceReference[];
  conflictReferences: readonly string[];
}>;

export function createP8AuthorizedEvidence(input: P8AuthorizedEvidenceInput): P8AuthorizedEvidence {
  validateEnum(input.channel, P8_EVIDENCE_CHANNELS, "evidence.channel");
  validateEnum(input.sourceClass, P8_EVIDENCE_AUTHORITY_CLASSES, "evidence.sourceClass");
  validateEnum(input.support, P8_EVIDENCE_SUPPORT_LEVELS, "evidence.support");
  validateBoundedText(input.evidenceReference, "evidence.evidenceReference", 160);
  validateBoundedText(input.statement, "evidence.statement", 500);
  const scopeReference = freezeScopeReference(input.scopeReference);
  const suppliedAt = normalizeOptionalText(input.suppliedAt, "evidence.suppliedAt", 100);
  const contradictionReferences = normalizeReferences(
    input.contradictionReferences ?? [],
    "evidence.contradictionReferences"
  );
  const provenance = Object.freeze({
    source: "evidence" as const,
    reference: input.evidenceReference,
    scopeReference,
    channel: input.channel,
    sourceClass: input.sourceClass,
    ...(suppliedAt === undefined ? {} : { suppliedAt }),
    contradictionReferences
  });

  return Object.freeze({
    evidenceReference: input.evidenceReference,
    statement: input.statement,
    sourceClass: input.sourceClass,
    channel: input.channel,
    support: input.support,
    scopeReference,
    ...(suppliedAt === undefined ? {} : { suppliedAt }),
    contradictionReferences,
    provenance
  });
}

export function createP8EvidenceAccessOutcome(
  input: P8EvidenceAccessOutcomeInput
): P8EvidenceAccessOutcome {
  validateEnum(input.status, P8_EVIDENCE_ACCESS_STATES, "evidence access status");
  const evidence = input.evidence.map(normalizeEvidence).sort(compareEvidence);
  const references = new Set<string>();
  for (const atom of evidence) {
    if (references.has(atom.evidenceReference)) {
      throw new Error(`P8 evidence reference must be unique: ${atom.evidenceReference}.`);
    }
    references.add(atom.evidenceReference);
  }

  if (input.status === "SUCCESS_WITH_EVIDENCE" && evidence.length === 0) {
    throw new Error("P8 successful evidence access must contain evidence.");
  }
  if (input.status === "SUCCESS_WITH_NO_RELEVANT_EVIDENCE" && evidence.length > 0) {
    throw new Error("P8 empty evidence access cannot contain evidence.");
  }

  return Object.freeze({
    status: input.status,
    evidence: Object.freeze(evidence)
  });
}

export function createP8EvidenceInterpretation(
  input: P8EvidenceInterpretationInput
): P8EvidenceInterpretation {
  validateEnum(input.domain, P8_INTERPRETATION_DOMAINS, "interpretation.domain");
  const meaning = normalizeOptionalText(input.meaning, "interpretation.meaning", 500);
  const access = createP8EvidenceAccessOutcome(input.access);
  const conflictReferences = findConflictReferences(access.evidence);
  const status = deriveStatus(access.status, access.evidence, meaning, conflictReferences);
  const provenance = Object.freeze(access.evidence.map((atom) => atom.provenance));
  const projectedMeaning = shouldProjectMeaning(status, access.evidence) ? meaning : undefined;

  return Object.freeze({
    interpretationVersion: P8_1B_CONTRACT_VERSION,
    domain: input.domain,
    accessStatus: access.status,
    status,
    support: supportFor(status),
    ...(projectedMeaning === undefined ? {} : { meaning: projectedMeaning }),
    provenance,
    conflictReferences: Object.freeze(conflictReferences)
  });
}

function normalizeEvidence(
  input: P8AuthorizedEvidence | P8AuthorizedEvidenceInput
): P8AuthorizedEvidence {
  if ("provenance" in input) {
    const sourceInput: P8AuthorizedEvidenceInput = {
      evidenceReference: input.evidenceReference,
      statement: input.statement,
      sourceClass: input.sourceClass,
      channel: input.channel,
      support: input.support,
      scopeReference: input.scopeReference,
      ...(input.suppliedAt === undefined ? {} : { suppliedAt: input.suppliedAt }),
      contradictionReferences: input.contradictionReferences
    };
    const normalized = createP8AuthorizedEvidence(sourceInput);
    if (!sameProvenance(normalized.provenance, input.provenance)) {
      throw new Error(`P8 evidence provenance does not match ${input.evidenceReference}.`);
    }
    return normalized;
  }

  return createP8AuthorizedEvidence(input);
}

function sameProvenance(
  left: P8EvidenceProvenanceReference,
  right: P8EvidenceProvenanceReference
): boolean {
  return (
    left.source === right.source &&
    left.reference === right.reference &&
    left.scopeReference.reference === right.scopeReference.reference &&
    left.channel === right.channel &&
    left.sourceClass === right.sourceClass &&
    left.suppliedAt === right.suppliedAt &&
    left.contradictionReferences.length === right.contradictionReferences.length &&
    left.contradictionReferences.every(
      (reference, index) => reference === right.contradictionReferences[index]
    )
  );
}

function deriveStatus(
  accessStatus: P8EvidenceAccessStatus,
  evidence: readonly P8AuthorizedEvidence[],
  meaning: string | undefined,
  conflictReferences: readonly string[]
): P8EpistemicState {
  switch (accessStatus) {
    case "SUCCESS_WITH_NO_RELEVANT_EVIDENCE":
      return "EMPTY";
    case "UNAVAILABLE":
      return "UNAVAILABLE";
    case "ERROR":
      return "ERROR";
    case "PARTIAL":
      return "PARTIAL";
    case "SUCCESS_WITH_EVIDENCE":
      if (conflictReferences.length > 0) {
        return "CONFLICTING";
      }
      if (meaning === undefined) {
        return "UNKNOWN";
      }
      if (evidence.some(canSupportKnown)) {
        return "KNOWN";
      }
      return evidence.some(canSupportPartial) ? "PARTIAL" : "UNKNOWN";
  }
}

function canSupportKnown(atom: P8AuthorizedEvidence): boolean {
  return (
    atom.support === "DIRECT" &&
    atom.sourceClass !== "WEAK_INFERRED" &&
    atom.sourceClass !== "ASSISTANT_MODEL_GENERATED"
  );
}

function canSupportPartial(atom: P8AuthorizedEvidence): boolean {
  return atom.sourceClass !== "ASSISTANT_MODEL_GENERATED";
}

function shouldProjectMeaning(
  status: P8EpistemicState,
  evidence: readonly P8AuthorizedEvidence[]
): boolean {
  return (
    status === "KNOWN" ||
    (status === "PARTIAL" &&
      evidence.some((atom) => atom.sourceClass !== "ASSISTANT_MODEL_GENERATED"))
  );
}

function supportFor(status: P8EpistemicState): P8EvidenceSupport {
  if (status === "KNOWN") {
    return "DIRECT";
  }
  if (status === "PARTIAL") {
    return "LIMITED";
  }
  return "NON_AUTHORITATIVE";
}

function findConflictReferences(evidence: readonly P8AuthorizedEvidence[]): string[] {
  const byReference = new Map(evidence.map((atom) => [atom.evidenceReference, atom]));
  const conflicts = new Set<string>();

  for (const atom of evidence) {
    if (atom.sourceClass === "ASSISTANT_MODEL_GENERATED") {
      continue;
    }
    for (const contradictionReference of atom.contradictionReferences) {
      const counterpart = byReference.get(contradictionReference);
      if (
        counterpart !== undefined &&
        counterpart.evidenceReference !== atom.evidenceReference &&
        counterpart.sourceClass !== "ASSISTANT_MODEL_GENERATED"
      ) {
        conflicts.add(atom.evidenceReference);
        conflicts.add(counterpart.evidenceReference);
      }
    }
  }

  return [...conflicts].sort(compareText);
}

function freezeScopeReference(input: P8EvidenceScopeReference): P8EvidenceScopeReference {
  validateBoundedText(input.reference, "evidence.scopeReference.reference", 160);
  return Object.freeze({ reference: input.reference });
}

function normalizeReferences(references: readonly string[], field: string): readonly string[] {
  const normalized = references.map((reference) => {
    validateBoundedText(reference, field, 160);
    return reference;
  });
  return Object.freeze([...new Set(normalized)].sort(compareText));
}

function normalizeOptionalText(
  value: string | undefined,
  field: string,
  maximum: number
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  validateBoundedText(value, field, maximum);
  return value;
}

function compareEvidence(left: P8AuthorizedEvidence, right: P8AuthorizedEvidence): number {
  return compareText(left.evidenceReference, right.evidenceReference);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateEnum<T extends string>(value: string, allowed: readonly T[], field: string): void {
  if (!allowed.includes(value as T)) {
    throw new Error(`P8 ${field} is not recognized: ${value}.`);
  }
}

function validateBoundedText(value: string, field: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`P8 ${field} must be a non-empty string of at most ${maximum} characters.`);
  }
}
