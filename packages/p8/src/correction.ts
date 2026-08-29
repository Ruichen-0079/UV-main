import type {
  P8EpistemicState,
  P8IdentityAddress,
  P8IdentityProjection,
  P8PersonaProjection,
  P8ProjectedInvariant,
  P8SemanticProvenanceReference
} from "./index.js";
import type { P8EvidenceInterpretation, P8EvidenceScopeReference } from "./evidence.js";
import type { P8EvidenceChannelProjection, P8ReadOnlyEvidenceProjection } from "./adapter.js";

/** The pure correction semantic contract introduced by P8-1D. */
export const P8_1D_VERSION = "p8-1d.v1" as const;

export const P8_CORRECTION_ACTIONS = ["REVISE", "RETRACT"] as const;
export type P8CorrectionAction = (typeof P8_CORRECTION_ACTIONS)[number];

export const P8_CORRECTION_AUTHORITY_SOURCES = [
  "EXPLICIT_USER_CORRECTION",
  "ASSISTANT_MODEL_GENERATED",
  "SYSTEM_INFERRED",
  "WEAK_INFERRED",
  "MEMORY_CORRECTION_EVENT"
] as const;
export type P8CorrectionAuthoritySource = (typeof P8_CORRECTION_AUTHORITY_SOURCES)[number];

export type P8CorrectionTarget = Readonly<
  | {
      kind: "INTERPRETATION";
      interpretationReference: string;
    }
  | {
      kind: "AUTHORED_INVARIANT";
      invariantTarget: "identity" | "persona";
      invariantKey: string;
    }
>;

export type P8CorrectionProvenanceInput = Readonly<{
  source: P8CorrectionAuthoritySource;
  reference: string;
  suppliedAt?: string;
}>;

export type P8CorrectionProvenanceReference = Readonly<{
  source: "explicit-user-correction";
  reference: string;
  correctionReference: string;
  address: P8IdentityAddress;
  scopeReference: P8EvidenceScopeReference;
  suppliedAt?: string;
}>;

export type P8ExplicitCorrection = Readonly<{
  /** Stable semantic identity; never derived from rendered text or position. */
  correctionReference: string;
  address: P8IdentityAddress;
  scopeReference: P8EvidenceScopeReference;
  target: P8CorrectionTarget;
  action: P8CorrectionAction;
  replacementMeaning?: string;
  provenance: P8CorrectionProvenanceInput;
  /** Opaque evidence references the caller explicitly identifies as superseded. */
  supersededEvidenceReferences?: readonly string[];
  /** Explicit semantic lineage; timestamps never establish this relation. */
  supersedesCorrectionReference?: string;
}>;

export type P8CorrectionApplicationInput = Readonly<{
  baseProjection: P8ReadOnlyEvidenceProjection;
  /** The caller-supplied scope authorized for the projection being corrected. */
  scopeReference: P8EvidenceScopeReference;
  corrections: readonly P8ExplicitCorrection[];
}>;

export type P8CorrectionSupersededReference = Readonly<{
  kind: "INTERPRETATION" | "AUTHORED_INVARIANT" | "EVIDENCE" | "CORRECTION";
  reference: string;
  supersededByCorrectionReference: string;
}>;

export type P8CorrectionAudit = Readonly<{
  correctionReference: string;
  action: P8CorrectionAction;
  target: P8CorrectionTarget;
  provenance: P8CorrectionProvenanceReference;
  supersedesCorrectionReference?: string;
  supersededByCorrectionReference?: string;
  previousStatus: P8EpistemicState;
  previousMeaning?: string;
  previousEvidenceReferences: readonly string[];
  replacementMeaning?: string;
  currentStatus: P8EpistemicState;
}>;

export type P8CorrectionApplicationResult = Readonly<{
  correctionVersion: typeof P8_1D_VERSION;
  baseProjectionVersion: string;
  address: P8IdentityAddress;
  scopeReference: P8EvidenceScopeReference;
  identity: P8IdentityProjection;
  persona: P8PersonaProjection;
  longTermEvidence: P8EvidenceChannelProjection;
  recentConversation?: P8EvidenceChannelProjection;
  /** Only current corrected meaning is exposed here; prior meaning remains in audits. */
  interpretations: readonly P8EvidenceInterpretation[];
  provenance: readonly P8SemanticProvenanceReference[];
  correctionProvenance: readonly P8CorrectionProvenanceReference[];
  correctionAudits: readonly P8CorrectionAudit[];
  supersededReferences: readonly P8CorrectionSupersededReference[];
}>;

type NormalizedCorrection = Readonly<{
  correctionReference: string;
  address: P8IdentityAddress;
  scopeReference: P8EvidenceScopeReference;
  target: P8CorrectionTarget;
  action: P8CorrectionAction;
  replacementMeaning?: string;
  provenance: P8CorrectionProvenanceReference;
  supersededEvidenceReferences: readonly string[];
  supersedesCorrectionReference?: string;
}>;

type CorrectionDecision = Readonly<{
  targetKey: string;
  corrections: readonly NormalizedCorrection[];
  winner?: NormalizedCorrection;
  conflict: boolean;
}>;

/**
 * Applies already-classified explicit user corrections to a supplied compact
 * P8 projection. This function performs no language detection, retrieval,
 * persistence, or Memory mutation.
 */
export function applyP8Corrections(
  input: P8CorrectionApplicationInput
): P8CorrectionApplicationResult {
  const address = normalizeAddress(input.baseProjection.address, "base projection address");
  const scopeReference = normalizeScopeReference(input.scopeReference, "correction scope");
  const corrections = input.corrections.map((correction) =>
    normalizeCorrection(correction, address, scopeReference)
  );
  assertUniqueCorrections(corrections);

  const interpretations = [...input.baseProjection.interpretations];
  assertUniqueInterpretations(interpretations);
  const authoredInvariants = [
    ...input.baseProjection.identity.invariants,
    ...input.baseProjection.persona.invariants
  ];
  assertUniqueAuthoredInvariants(authoredInvariants);
  validateCorrectionTargets(corrections, interpretations, authoredInvariants);
  validateCorrectionLineage(corrections);

  const decisions = decideCorrections(corrections);
  const correctedInterpretations = applyInterpretationDecisions(interpretations, decisions);
  const correctedInvariants = applyInvariantDecisions(authoredInvariants, decisions);
  const identity = createProjection("identity", correctedInvariants);
  const persona = createProjection("persona", correctedInvariants);
  const correctionAudits = createCorrectionAudits(
    corrections,
    decisions,
    interpretations,
    authoredInvariants
  );
  const supersededReferences = createSupersededReferences(corrections, decisions);

  return Object.freeze({
    correctionVersion: P8_1D_VERSION,
    baseProjectionVersion: input.baseProjection.projectionVersion,
    address,
    scopeReference,
    identity,
    persona,
    longTermEvidence: cloneChannelProjection(input.baseProjection.longTermEvidence),
    ...(input.baseProjection.recentConversation === undefined
      ? {}
      : { recentConversation: cloneChannelProjection(input.baseProjection.recentConversation) }),
    interpretations: Object.freeze(correctedInterpretations),
    provenance: Object.freeze([...input.baseProjection.provenance]),
    correctionProvenance: Object.freeze(
      corrections.map((correction) => correction.provenance).sort(compareCorrectionProvenance)
    ),
    correctionAudits: Object.freeze(correctionAudits),
    supersededReferences: Object.freeze(supersededReferences)
  });
}

function normalizeCorrection(
  correction: P8ExplicitCorrection,
  expectedAddress: P8IdentityAddress,
  expectedScopeReference: P8EvidenceScopeReference
): NormalizedCorrection {
  validateBoundedText(correction.correctionReference, "correction.correctionReference", 160);
  const address = normalizeAddress(correction.address, "correction.address");
  if (!sameAddress(address, expectedAddress)) {
    throw new Error("P8 correction address is not authorized for this projection.");
  }
  const scopeReference = normalizeScopeReference(
    correction.scopeReference,
    "correction.scopeReference"
  );
  if (scopeReference.reference !== expectedScopeReference.reference) {
    throw new Error("P8 correction scope is not authorized for this projection.");
  }
  validateEnum(correction.action, P8_CORRECTION_ACTIONS, "correction.action");
  validateTarget(correction.target);

  if (correction.action === "REVISE") {
    validateBoundedText(correction.replacementMeaning, "correction.replacementMeaning", 500);
  } else if (correction.replacementMeaning !== undefined) {
    throw new Error("P8 RETRACT correction cannot supply a replacement meaning.");
  }

  const provenance = correction.provenance;
  if (provenance.source !== "EXPLICIT_USER_CORRECTION") {
    throw new Error("P8 correction requires explicit user correction authority.");
  }
  validateBoundedText(provenance.reference, "correction.provenance.reference", 160);
  const suppliedAt = normalizeOptionalText(
    provenance.suppliedAt,
    "correction.provenance.suppliedAt",
    100
  );
  const supersedesCorrectionReference = normalizeOptionalReference(
    correction.supersedesCorrectionReference,
    "correction.supersedesCorrectionReference"
  );
  const supersededEvidenceReferences = normalizeReferences(
    correction.supersededEvidenceReferences ?? [],
    "correction.supersededEvidenceReferences"
  );

  return Object.freeze({
    correctionReference: correction.correctionReference,
    address,
    scopeReference,
    target: freezeTarget(correction.target),
    action: correction.action,
    ...(correction.replacementMeaning === undefined
      ? {}
      : { replacementMeaning: correction.replacementMeaning }),
    provenance: Object.freeze({
      source: "explicit-user-correction" as const,
      reference: provenance.reference,
      correctionReference: correction.correctionReference,
      address,
      scopeReference,
      ...(suppliedAt === undefined ? {} : { suppliedAt })
    }),
    supersededEvidenceReferences,
    ...(supersedesCorrectionReference === undefined ? {} : { supersedesCorrectionReference })
  });
}

function validateCorrectionTargets(
  corrections: readonly NormalizedCorrection[],
  interpretations: readonly P8EvidenceInterpretation[],
  authoredInvariants: readonly P8ProjectedInvariant[]
): void {
  const interpretationReferences = new Set(
    interpretations.map((interpretation) => interpretation.interpretationReference)
  );
  const invariantKeys = new Set(
    authoredInvariants.map((invariant) => authoredInvariantKey(invariant.target, invariant.key))
  );

  for (const correction of corrections) {
    if (correction.target.kind === "INTERPRETATION") {
      if (!interpretationReferences.has(correction.target.interpretationReference)) {
        throw new Error(
          `P8 correction target interpretation is not present: ${correction.target.interpretationReference}.`
        );
      }
      continue;
    }

    const targetKey = authoredInvariantKey(
      correction.target.invariantTarget,
      correction.target.invariantKey
    );
    if (!invariantKeys.has(targetKey)) {
      throw new Error(`P8 correction target authored invariant is not present: ${targetKey}.`);
    }
    if (
      !authoredInvariants.some(
        (invariant) =>
          authoredInvariantKey(invariant.target, invariant.key) === targetKey &&
          invariant.revisability === "USER_REVISABLE"
      )
    ) {
      throw new Error(`P8 authored invariant is not user-revisable: ${targetKey}.`);
    }
  }
}

function validateCorrectionLineage(corrections: readonly NormalizedCorrection[]): void {
  const byReference = new Map(
    corrections.map((correction) => [correction.correctionReference, correction])
  );
  for (const correction of corrections) {
    const supersededReference = correction.supersedesCorrectionReference;
    if (supersededReference === undefined) {
      continue;
    }
    const superseded = byReference.get(supersededReference);
    if (superseded === undefined) {
      throw new Error(
        `P8 correction lineage references unavailable correction: ${supersededReference}.`
      );
    }
    if (correctionTargetKey(correction.target) !== correctionTargetKey(superseded.target)) {
      throw new Error("P8 correction lineage must target the same semantic target.");
    }
  }

  for (const correction of corrections) {
    const visited = new Set<string>();
    let current: NormalizedCorrection | undefined = correction;
    while (current?.supersedesCorrectionReference !== undefined) {
      if (visited.has(current.correctionReference)) {
        throw new Error("P8 correction lineage cannot contain a cycle.");
      }
      visited.add(current.correctionReference);
      current = byReference.get(current.supersedesCorrectionReference);
    }
  }
}

function decideCorrections(
  corrections: readonly NormalizedCorrection[]
): readonly CorrectionDecision[] {
  const grouped = new Map<string, NormalizedCorrection[]>();
  for (const correction of corrections) {
    const targetKey = correctionTargetKey(correction.target);
    const group = grouped.get(targetKey) ?? [];
    group.push(correction);
    grouped.set(targetKey, group);
  }

  const supersededReferences = new Set(
    corrections.flatMap((correction) =>
      correction.supersedesCorrectionReference === undefined
        ? []
        : [correction.supersedesCorrectionReference]
    )
  );

  return [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([targetKey, group]) => {
      const active = group
        .filter((correction) => !supersededReferences.has(correction.correctionReference))
        .sort(compareCorrections);
      if (active.length === 0) {
        throw new Error(`P8 correction target has no active correction: ${targetKey}.`);
      }
      const equivalent = active.every((correction) =>
        sameCorrectionOutcome(active[0]!, correction)
      );
      return Object.freeze({
        targetKey,
        corrections: Object.freeze([...group].sort(compareCorrections)),
        ...(equivalent ? { winner: active[0] } : {}),
        conflict: !equivalent
      });
    });
}

function applyInterpretationDecisions(
  interpretations: readonly P8EvidenceInterpretation[],
  decisions: readonly CorrectionDecision[]
): P8EvidenceInterpretation[] {
  const byTarget = new Map(
    decisions
      .filter((decision) => decision.targetKey.startsWith("INTERPRETATION\u0000"))
      .map((decision) => [decision.targetKey, decision])
  );
  return interpretations
    .map((interpretation) => {
      const decision = byTarget.get(
        correctionTargetKey({
          kind: "INTERPRETATION",
          interpretationReference: interpretation.interpretationReference
        })
      );
      if (decision === undefined) {
        return cloneInterpretation(interpretation);
      }
      const status = decision.conflict
        ? "CONFLICTING"
        : decision.winner?.action === "REVISE"
          ? "KNOWN"
          : "UNKNOWN";
      const meaning = decision.conflict ? undefined : decision.winner?.replacementMeaning;
      return correctedInterpretation(interpretation, status, meaning);
    })
    .sort((left, right) =>
      compareText(left.interpretationReference, right.interpretationReference)
    );
}

function applyInvariantDecisions(
  invariants: readonly P8ProjectedInvariant[],
  decisions: readonly CorrectionDecision[]
): P8ProjectedInvariant[] {
  const byTarget = new Map(
    decisions
      .filter((decision) => decision.targetKey.startsWith("AUTHORED_INVARIANT\u0000"))
      .map((decision) => [decision.targetKey, decision])
  );
  return invariants
    .flatMap((invariant) => {
      const decision = byTarget.get(authoredInvariantKey(invariant.target, invariant.key));
      if (decision === undefined) {
        return [cloneInvariant(invariant)];
      }
      if (decision.conflict || decision.winner?.action === "RETRACT") {
        return [];
      }
      return [cloneInvariant(invariant, decision.winner?.replacementMeaning)];
    })
    .sort(compareInvariants);
}

function createProjection(
  target: "identity" | "persona",
  invariants: readonly P8ProjectedInvariant[]
): P8IdentityProjection | P8PersonaProjection {
  const targetInvariants = Object.freeze(
    invariants.filter((invariant) => invariant.target === target)
  );
  return Object.freeze({
    status: targetInvariants.length > 0 ? "KNOWN" : "UNKNOWN",
    invariants: targetInvariants
  });
}

function createCorrectionAudits(
  corrections: readonly NormalizedCorrection[],
  decisions: readonly CorrectionDecision[],
  interpretations: readonly P8EvidenceInterpretation[],
  authoredInvariants: readonly P8ProjectedInvariant[]
): P8CorrectionAudit[] {
  const decisionByTarget = new Map(decisions.map((decision) => [decision.targetKey, decision]));
  return [...corrections].sort(compareCorrections).map((correction) => {
    const targetKey = correctionTargetKey(correction.target);
    const decision = decisionByTarget.get(targetKey)!;
    const previous = previousTargetState(correction.target, interpretations, authoredInvariants);
    const supersededByCorrectionReference =
      decision.winner?.correctionReference === correction.correctionReference
        ? undefined
        : decision.winner?.correctionReference;
    const currentStatus = decision.conflict
      ? "CONFLICTING"
      : decision.winner?.action === "REVISE"
        ? "KNOWN"
        : "UNKNOWN";
    return Object.freeze({
      correctionReference: correction.correctionReference,
      action: correction.action,
      target: correction.target,
      provenance: correction.provenance,
      ...(correction.supersedesCorrectionReference === undefined
        ? {}
        : { supersedesCorrectionReference: correction.supersedesCorrectionReference }),
      ...(supersededByCorrectionReference === undefined ? {} : { supersededByCorrectionReference }),
      previousStatus: previous.status,
      ...(previous.meaning === undefined ? {} : { previousMeaning: previous.meaning }),
      previousEvidenceReferences: Object.freeze(
        [
          ...new Set([...previous.evidenceReferences, ...correction.supersededEvidenceReferences])
        ].sort(compareText)
      ),
      ...(correction.replacementMeaning === undefined
        ? {}
        : { replacementMeaning: correction.replacementMeaning }),
      currentStatus
    });
  });
}

function createSupersededReferences(
  corrections: readonly NormalizedCorrection[],
  decisions: readonly CorrectionDecision[]
): P8CorrectionSupersededReference[] {
  const references: P8CorrectionSupersededReference[] = [];
  for (const correction of corrections) {
    const decision = decisions.find(
      (candidate) => candidate.targetKey === correctionTargetKey(correction.target)
    )!;
    if (decision.winner?.correctionReference !== correction.correctionReference) {
      references.push({
        kind: "CORRECTION",
        reference: correction.correctionReference,
        supersededByCorrectionReference:
          decision.winner?.correctionReference ?? correction.correctionReference
      });
    }
    references.push({
      kind: correction.target.kind,
      reference:
        correction.target.kind === "INTERPRETATION"
          ? correction.target.interpretationReference
          : authoredInvariantKey(correction.target.invariantTarget, correction.target.invariantKey),
      supersededByCorrectionReference:
        decision.winner?.correctionReference ?? correction.correctionReference
    });
    for (const evidenceReference of correction.supersededEvidenceReferences) {
      references.push({
        kind: "EVIDENCE",
        reference: evidenceReference,
        supersededByCorrectionReference: correction.correctionReference
      });
    }
  }

  const unique = new Map(
    references.map((reference) => [
      [reference.kind, reference.reference, reference.supersededByCorrectionReference].join(
        "\u0000"
      ),
      reference
    ])
  );
  return [...unique.values()].sort((left, right) =>
    compareText(
      [left.kind, left.reference, left.supersededByCorrectionReference].join("\u0000"),
      [right.kind, right.reference, right.supersededByCorrectionReference].join("\u0000")
    )
  );
}

function previousTargetState(
  target: P8CorrectionTarget,
  interpretations: readonly P8EvidenceInterpretation[],
  authoredInvariants: readonly P8ProjectedInvariant[]
): { status: P8EpistemicState; meaning?: string; evidenceReferences: readonly string[] } {
  if (target.kind === "INTERPRETATION") {
    const interpretation = interpretations.find(
      (candidate) => candidate.interpretationReference === target.interpretationReference
    )!;
    return {
      status: interpretation.status,
      ...(interpretation.meaning === undefined ? {} : { meaning: interpretation.meaning }),
      evidenceReferences: interpretation.evidenceLinks.map((link) => link.evidenceReference)
    };
  }
  const invariant = authoredInvariants.find(
    (candidate) =>
      authoredInvariantKey(candidate.target, candidate.key) ===
      authoredInvariantKey(target.invariantTarget, target.invariantKey)
  )!;
  return {
    status: "KNOWN",
    meaning: invariant.statement,
    evidenceReferences: []
  };
}

function correctedInterpretation(
  interpretation: P8EvidenceInterpretation,
  status: P8EpistemicState,
  meaning: string | undefined
): P8EvidenceInterpretation {
  return Object.freeze({
    interpretationVersion: interpretation.interpretationVersion,
    interpretationReference: interpretation.interpretationReference,
    domain: interpretation.domain,
    accessStatus: interpretation.accessStatus,
    status,
    support: status === "KNOWN" ? "DIRECT" : status === "PARTIAL" ? "LIMITED" : "NON_AUTHORITATIVE",
    ...(meaning === undefined ? {} : { meaning }),
    evidenceLinks: Object.freeze([]),
    provenance: Object.freeze([]),
    conflictReferences: Object.freeze([])
  });
}

function cloneInterpretation(interpretation: P8EvidenceInterpretation): P8EvidenceInterpretation {
  return Object.freeze({
    ...interpretation,
    evidenceLinks: Object.freeze([...interpretation.evidenceLinks]),
    provenance: Object.freeze([...interpretation.provenance]),
    conflictReferences: Object.freeze([...interpretation.conflictReferences])
  });
}

function cloneInvariant(
  invariant: P8ProjectedInvariant,
  replacementMeaning?: string
): P8ProjectedInvariant {
  return Object.freeze({
    key: invariant.key,
    target: invariant.target,
    statement: replacementMeaning ?? invariant.statement,
    revisability: invariant.revisability ?? "FIXED",
    provenance: Object.freeze({
      source: invariant.provenance.source,
      reference: invariant.provenance.reference,
      ...(invariant.provenance.revision === undefined
        ? {}
        : { revision: invariant.provenance.revision })
    })
  });
}

function cloneChannelProjection(input: P8EvidenceChannelProjection): P8EvidenceChannelProjection {
  return Object.freeze({
    accessStatus: input.accessStatus,
    status: input.status,
    evidenceCount: input.evidenceCount,
    provenance: Object.freeze([...input.provenance])
  });
}

function validateTarget(target: P8CorrectionTarget): void {
  if (target.kind === "INTERPRETATION") {
    validateBoundedText(
      target.interpretationReference,
      "correction.target.interpretationReference",
      160
    );
    return;
  }
  if (target.kind !== "AUTHORED_INVARIANT") {
    throw new Error("P8 correction target kind is not recognized.");
  }
  if (target.invariantTarget !== "identity" && target.invariantTarget !== "persona") {
    throw new Error("P8 correction authored invariant target is not recognized.");
  }
  validateBoundedText(target.invariantKey, "correction.target.invariantKey", 160);
}

function freezeTarget(target: P8CorrectionTarget): P8CorrectionTarget {
  return target.kind === "INTERPRETATION"
    ? Object.freeze({ kind: target.kind, interpretationReference: target.interpretationReference })
    : Object.freeze({
        kind: target.kind,
        invariantTarget: target.invariantTarget,
        invariantKey: target.invariantKey
      });
}

function correctionTargetKey(target: P8CorrectionTarget): string {
  return target.kind === "INTERPRETATION"
    ? [target.kind, target.interpretationReference].join("\u0000")
    : [target.kind, target.invariantTarget, target.invariantKey].join("\u0000");
}

function authoredInvariantKey(target: "identity" | "persona", key: string): string {
  return ["AUTHORED_INVARIANT", target, key].join("\u0000");
}

function sameCorrectionOutcome(left: NormalizedCorrection, right: NormalizedCorrection): boolean {
  return left.action === right.action && left.replacementMeaning === right.replacementMeaning;
}

function assertUniqueCorrections(corrections: readonly NormalizedCorrection[]): void {
  const references = new Set<string>();
  for (const correction of corrections) {
    if (references.has(correction.correctionReference)) {
      throw new Error(`P8 correction reference must be unique: ${correction.correctionReference}.`);
    }
    references.add(correction.correctionReference);
  }
}

function assertUniqueInterpretations(interpretations: readonly P8EvidenceInterpretation[]): void {
  const references = new Set<string>();
  for (const interpretation of interpretations) {
    validateBoundedText(
      interpretation.interpretationReference,
      "interpretation.interpretationReference",
      160
    );
    if (references.has(interpretation.interpretationReference)) {
      throw new Error(
        `P8 interpretation reference must be unique: ${interpretation.interpretationReference}.`
      );
    }
    references.add(interpretation.interpretationReference);
  }
}

function assertUniqueAuthoredInvariants(invariants: readonly P8ProjectedInvariant[]): void {
  const references = new Set<string>();
  for (const invariant of invariants) {
    const reference = authoredInvariantKey(invariant.target, invariant.key);
    if (references.has(reference)) {
      throw new Error(`P8 authored invariant identity must be unique: ${reference}.`);
    }
    references.add(reference);
  }
}

function normalizeAddress(input: P8IdentityAddress, field: string): P8IdentityAddress {
  validateBoundedText(input.characterInstanceId, `${field}.characterInstanceId`, 160);
  validateBoundedText(input.personaProfileId, `${field}.personaProfileId`, 160);
  if (input.subjectScopeId !== undefined) {
    validateBoundedText(input.subjectScopeId, `${field}.subjectScopeId`, 160);
  }
  return Object.freeze({
    characterInstanceId: input.characterInstanceId,
    personaProfileId: input.personaProfileId,
    ...(input.subjectScopeId === undefined ? {} : { subjectScopeId: input.subjectScopeId })
  });
}

function sameAddress(left: P8IdentityAddress, right: P8IdentityAddress): boolean {
  return (
    left.characterInstanceId === right.characterInstanceId &&
    left.personaProfileId === right.personaProfileId &&
    left.subjectScopeId === right.subjectScopeId
  );
}

function normalizeScopeReference(
  input: P8EvidenceScopeReference,
  field: string
): P8EvidenceScopeReference {
  validateBoundedText(input.reference, `${field}.reference`, 160);
  return Object.freeze({ reference: input.reference });
}

function normalizeReferences(references: readonly string[], field: string): readonly string[] {
  const normalized = references.map((reference) => {
    validateBoundedText(reference, field, 160);
    return reference;
  });
  return Object.freeze([...new Set(normalized)].sort(compareText));
}

function normalizeOptionalReference(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  validateBoundedText(value, field, 160);
  return value;
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

function compareCorrections(left: NormalizedCorrection, right: NormalizedCorrection): number {
  return compareText(left.correctionReference, right.correctionReference);
}

function compareCorrectionProvenance(
  left: P8CorrectionProvenanceReference,
  right: P8CorrectionProvenanceReference
): number {
  return compareText(left.correctionReference, right.correctionReference);
}

function compareInvariants(left: P8ProjectedInvariant, right: P8ProjectedInvariant): number {
  return compareText(
    authoredInvariantKey(left.target, left.key),
    authoredInvariantKey(right.target, right.key)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateEnum<T extends string>(value: string, allowed: readonly T[], field: string): void {
  if (!allowed.includes(value as T)) {
    throw new Error(`P8 ${field} is not recognized: ${value}.`);
  }
}

function validateBoundedText(value: string | undefined, field: string, maximum: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`P8 ${field} must be a non-empty string of at most ${maximum} characters.`);
  }
}
