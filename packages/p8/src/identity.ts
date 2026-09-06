import type { MemoryClaimProvenanceClass, MemoryEvent } from "@companion/memory";
import type { P8IdentityAddress } from "./index.js";
import type { P8EvidenceAuthorityClass } from "./evidence.js";
import type { P8RecentConversationMessageInput } from "./adapter.js";
import {
  eligibleIdentityEvidence,
  recentMessageToIdentityEvidence,
  type P8IdentityEvidenceRecord
} from "./identity-evidence.js";

/**
 * Current identity projection and identity mention resolution (Atom 13A).
 *
 * P8 is the interpretation authority for what a surface mention means right
 * now. Memory stays the evidence authority: this module consumes only
 * eligible evidence records and derives a small, disposable, rebuildable
 * projection. It never writes Memory, never mutates a raw transcript, and
 * never treats acoustic provenance (speakerId / voiceProfileId / speaker
 * clusters) as identity — Atom 13B owns voice-profile → person resolution.
 *
 * Resolution is deterministic-first. Candidate strength is a tier, not a
 * scalar:
 *
 *   trusted explicit (SELF_REPORT / user-asserted facts / EXTERNAL_CLAIM
 *     whose assertor is a caller-declared trusted assertor, i.e. the primary
 *     user's own explicit assignments and corrections)
 *   > strong active durable (DIRECT_OBSERVATION / system-verified)
 *   > consistent observations (>= 2 independent non-claim interactions)
 *   > explicit validity-expired durable evidence (historical reference)
 *   > contextual inference (current-conversation containment, ephemeral)
 *
 * EXTERNAL_CLAIM from a non-trusted assertor / UNKNOWN_AMBIENT and single
 * weak observations are candidate-only: they appear as reasoning but never
 * decide a resolution. ASSISTANT_INFERENCE / assistant-authored evidence is
 * excluded from candidacy entirely: model output can never become identity
 * truth, and assistant-only evidence resolves to UNRESOLVED.
 *
 * Speech (STT) variant handling: a latin-script surface (for example "UV",
 * "U V") is a transcription hypothesis. It binds a person only when the
 * caller supplies an addressing context, and only against an attested
 * surface form. Topical use ("UV 会导致晒伤") therefore stays unresolved, and
 * no surface is ever rewritten or persisted.
 *
 * Temporal role filtering uses only explicit validity-window annotations
 * (yuviIdentityValidFrom / yuviIdentityValidUntil metadata, read-side only).
 * Without a window a record is not time-bounded; without a caller-supplied
 * current time a window cannot be evaluated and the record counts as active.
 */

export const P8_IDENTITY_VERSION = "p8-identity.v1" as const;

export const P8_IDENTITY_MENTION_STATUSES = ["RESOLVED", "AMBIGUOUS", "UNRESOLVED"] as const;

export type P8IdentityMentionStatus = (typeof P8_IDENTITY_MENTION_STATUSES)[number];

export const P8_IDENTITY_CANDIDATE_TIERS = [
  "TRUSTED_EXPLICIT",
  "STRONG_ACTIVE",
  "CONSISTENT_OBSERVATION",
  "CONTEXTUAL",
  "CANDIDATE_ONLY"
] as const;

export type P8IdentityCandidateTier = (typeof P8_IDENTITY_CANDIDATE_TIERS)[number];

export const P8_IDENTITY_CANDIDATE_BASES = ["name", "role", "contextual"] as const;

export type P8IdentityCandidateBasis = (typeof P8_IDENTITY_CANDIDATE_BASES)[number];

export type P8IdentityMentionChannel = "speech" | "typed";

export type P8IdentityMentionContext = Readonly<{
  scopeReference: string;
  /** Source-supplied current time (ISO). Used only for explicit validity windows. */
  currentTime?: string;
  channel?: P8IdentityMentionChannel;
  /**
   * Caller-supplied bounded signal that the mention is used in an addressing
   * / vocative position. Required for latin-script (STT hypothesis) matches.
   */
  addressing?: boolean;
}>;

export type P8IdentityMentionResolutionInput = Readonly<{
  /** Surface mention exactly as it occurs in the current discourse. */
  mention: string;
  address: P8IdentityAddress;
  context: P8IdentityMentionContext;
  /** Already-retrieved long-term MemoryEvents; eligibility is re-applied here. */
  longTermEvents?: readonly MemoryEvent[];
  /** Bounded current-conversation window for ephemeral contextual resolution. */
  recentConversation?: readonly P8RecentConversationMessageInput[];
  /**
   * Caller-declared trusted assertor entity ids (the primary user). An
   * EXTERNAL_CLAIM asserted by one of them is the primary user's own explicit
   * assignment/correction and ranks trusted-explicit; any other assertor
   * stays candidate-only hearsay.
   */
  trustedAssertorEntityIds?: readonly string[];
}>;

export type P8IdentitySurfaceForm = Readonly<{
  /** Attested surface exactly as evidence stored it. Never rewritten. */
  surface: string;
  identityKey: string;
  latinKey?: string;
  authority: P8EvidenceAuthorityClass;
  evidenceReferences: readonly string[];
  suppliedAt?: string;
}>;

export type P8IdentityPersonProjection = Readonly<{
  entityId: string;
  surfaceForms: readonly P8IdentitySurfaceForm[];
}>;

export type P8CurrentIdentityProjection = Readonly<{
  projectionVersion: typeof P8_IDENTITY_VERSION;
  address: P8IdentityAddress;
  scopeReference: string;
  persons: readonly P8IdentityPersonProjection[];
  evidenceReferences: readonly string[];
  excludedIneligibleCount: number;
}>;

export type P8IdentityMentionCandidate = Readonly<{
  entityId?: string;
  basis: P8IdentityCandidateBasis;
  tier: P8IdentityCandidateTier;
  roleTemporalState?: "active" | "expired" | "upcoming";
  surfaceForm?: string;
  contextAnchor?: string;
  evidenceReferences: readonly string[];
  provenanceClasses: readonly MemoryClaimProvenanceClass[];
}>;

export type P8IdentityUnresolvedReason =
  | "no-evidence"
  | "speech-variant-without-addressing"
  | "insufficient-authority"
  | "external-claim-only"
  | "assistant-inference-only";

export type P8IdentityMentionResolution = Readonly<{
  resolutionVersion: typeof P8_IDENTITY_VERSION;
  status: P8IdentityMentionStatus;
  /** The mention verbatim from the input. Never rewritten. */
  surfaceMention: string;
  identityKey: string;
  entityId?: string;
  candidates?: readonly P8IdentityMentionCandidate[];
  evidenceReferences: readonly string[];
  /** True only for contextual (current-conversation) resolutions. */
  ephemeral: boolean;
  contextAnchor?: string;
  unresolvedReason?: P8IdentityUnresolvedReason;
}>;

export type P8CurrentIdentityProjectionInput = Readonly<{
  address: P8IdentityAddress;
  scopeReference: string;
  longTermEvents?: readonly MemoryEvent[];
  recentConversation?: readonly P8RecentConversationMessageInput[];
}>;

/**
 * Rebuilds the derived current identity projection from eligible evidence.
 * The projection is disposable: rebuilding it from the same eligible evidence
 * is deterministic, and Memory remains the only durable authority.
 */
export function buildP8CurrentIdentityProjection(
  input: P8CurrentIdentityProjectionInput
): P8CurrentIdentityProjection {
  const scopeReference = validateScopeReference(input.scopeReference);
  const { records, excludedIneligibleCount } = collectEvidenceRecords(input, scopeReference);

  const persons = Object.freeze(
    [...buildPersonSurfaces(records).entries()]
      .map(([entityId, surfaces]) =>
        Object.freeze({
          entityId,
          surfaceForms: Object.freeze([...surfaces.values()].map(surfaceProjection))
        })
      )
      .sort(comparePerson)
  );

  return Object.freeze({
    projectionVersion: P8_IDENTITY_VERSION,
    address: input.address,
    scopeReference,
    persons,
    evidenceReferences: Object.freeze(
      uniqueSorted(records.map((record) => record.evidenceReference))
    ),
    excludedIneligibleCount
  });
}

/**
 * Resolves one identity mention against the current eligible evidence.
 *
 * Output statuses: RESOLVED (one entity, or one ephemeral contextual anchor),
 * AMBIGUOUS (several equally legal candidates), UNRESOLVED (insufficient
 * evidence). The resolver never guesses, never persists, and never rewrites
 * the mention.
 */
export function resolveP8IdentityMention(
  input: P8IdentityMentionResolutionInput
): P8IdentityMentionResolution {
  const scopeReference = validateScopeReference(input.context.scopeReference);
  const mention = validateMention(input.mention);
  const identityKey = identityKeyOf(mention);
  if (!identityKey) {
    throw new Error(
      "P8 identity mention must contain at least one letter, number, or CJK character."
    );
  }
  const currentTime = input.context.currentTime;
  const trustedAssertors = new Set(input.trustedAssertorEntityIds ?? []);
  const { records } = collectEvidenceRecords(
    {
      ...(input.longTermEvents === undefined ? {} : { longTermEvents: input.longTermEvents }),
      ...(input.recentConversation === undefined
        ? {}
        : { recentConversation: input.recentConversation })
    },
    scopeReference
  );

  const candidates: P8IdentityMentionCandidate[] = [];
  let blockedSpeechVariant = false;

  for (const match of nameMatches(
    records,
    identityKey,
    input.context.addressing === true,
    trustedAssertors
  )) {
    if (match.kind === "blocked") {
      blockedSpeechVariant = true;
      continue;
    }
    candidates.push({
      entityId: match.entityId,
      basis: "name",
      tier: match.tier,
      surfaceForm: match.surface,
      evidenceReferences: match.evidenceReferences,
      provenanceClasses: match.provenanceClasses
    });
  }
  // A mention that is itself an attested person surface is a name mention:
  // title matching must not re-interpret it as a role occurrence.
  if (!attestedSurfaceKeys(records).has(identityKey)) {
    for (const match of roleMatches(records, identityKey, currentTime, trustedAssertors)) {
      candidates.push({
        entityId: match.entityId,
        basis: "role",
        tier: match.tier,
        roleTemporalState: match.temporalState,
        evidenceReferences: match.evidenceReferences,
        provenanceClasses: match.provenanceClasses
      });
    }
  }

  const sorted = candidates.sort(compareCandidates);
  const base = {
    resolutionVersion: P8_IDENTITY_VERSION as typeof P8_IDENTITY_VERSION,
    surfaceMention: mention,
    identityKey,
    evidenceReferences: uniqueSorted(
      sorted.flatMap((candidate) => [...candidate.evidenceReferences])
    )
  };

  // 1. Active, decidable durable candidates decide.
  const activeDecidable = sorted.filter(
    (candidate) =>
      isDecidableTier(candidate.tier) &&
      candidate.roleTemporalState !== "expired" &&
      candidate.roleTemporalState !== "upcoming"
  );
  if (activeDecidable.length > 0) {
    const deciding = activeDecidable.filter(
      (candidate) => candidate.tier === activeDecidable[0]!.tier
    );
    const resolvedEntityId = deciding[0]!.entityId;
    if (resolvedEntityId === undefined) {
      throw new Error("P8 identity durable candidate is missing an entity id.");
    }
    if (new Set(deciding.map((candidate) => candidate.entityId)).size === 1) {
      return Object.freeze({
        ...base,
        status: "RESOLVED" as const,
        entityId: resolvedEntityId,
        ephemeral: false,
        candidates: Object.freeze(deciding)
      });
    }
    return Object.freeze({
      ...base,
      status: "AMBIGUOUS" as const,
      ephemeral: false,
      candidates: Object.freeze(deciding)
    });
  }

  // 2. Expired / upcoming durable role evidence supports historical reference.
  // Candidate-only (hearsay) roles can never decide, historically either.
  const inactiveRoles = sorted.filter(
    (candidate) => candidate.basis === "role" && isDecidableTier(candidate.tier)
  );
  if (inactiveRoles.length > 0) {
    const historicalEntityId = inactiveRoles[0]!.entityId;
    if (historicalEntityId === undefined) {
      throw new Error("P8 identity role candidate is missing an entity id.");
    }
    if (new Set(inactiveRoles.map((candidate) => candidate.entityId)).size === 1) {
      return Object.freeze({
        ...base,
        status: "RESOLVED" as const,
        entityId: historicalEntityId,
        ephemeral: false,
        candidates: Object.freeze(inactiveRoles)
      });
    }
    return Object.freeze({
      ...base,
      status: "AMBIGUOUS" as const,
      ephemeral: false,
      candidates: Object.freeze(inactiveRoles)
    });
  }

  // 3. Contextual (current-conversation) resolution is ephemeral.
  const contextual = contextualMatches(records, identityKey);
  if (contextual.length === 1) {
    const only = contextual[0]!;
    return Object.freeze({
      ...base,
      status: "RESOLVED" as const,
      evidenceReferences: [only.evidenceReference],
      ephemeral: true,
      contextAnchor: only.evidenceReference,
      candidates: Object.freeze([contextualCandidate(only)])
    });
  }
  if (contextual.length > 1) {
    return Object.freeze({
      ...base,
      status: "AMBIGUOUS" as const,
      ephemeral: false,
      candidates: Object.freeze(
        contextual.map((record) => contextualCandidate(record)).sort(compareCandidates)
      )
    });
  }

  // 4. Candidate-only evidence is reasoning, never a decision.
  return Object.freeze({
    ...base,
    status: "UNRESOLVED" as const,
    ephemeral: false,
    unresolvedReason: unresolvedReasonFor(sorted, blockedSpeechVariant, records, identityKey),
    ...(sorted.length === 0 ? {} : { candidates: Object.freeze(sorted) })
  });
}

const TIER_RANK: Record<P8IdentityCandidateTier, number> = Object.freeze({
  TRUSTED_EXPLICIT: 0,
  STRONG_ACTIVE: 1,
  CONSISTENT_OBSERVATION: 2,
  CONTEXTUAL: 3,
  CANDIDATE_ONLY: 4
});

const ROLE_PREFIXES = ["我们的", "你的", "我的", "我们", "你", "我"] as const;

type Attestation = {
  record: P8IdentityEvidenceRecord;
  surface: string;
  identityKey: string;
  latinKey?: string;
};

type NameMatch =
  | {
      kind: "candidate";
      entityId: string;
      surface: string;
      tier: P8IdentityCandidateTier;
      evidenceReferences: readonly string[];
      provenanceClasses: readonly MemoryClaimProvenanceClass[];
    }
  | { kind: "blocked" };

function collectEvidenceRecords(
  input: Pick<P8CurrentIdentityProjectionInput, "longTermEvents" | "recentConversation">,
  scopeReference: string
): { records: readonly P8IdentityEvidenceRecord[]; excludedIneligibleCount: number } {
  const scope = Object.freeze({ reference: scopeReference });
  const longTerm = eligibleIdentityEvidence(input.longTermEvents ?? [], scope);
  const recent = (input.recentConversation ?? []).map((message) =>
    recentMessageToIdentityEvidence(message, scope)
  );
  return {
    records: Object.freeze([...longTerm.records, ...recent]),
    excludedIneligibleCount: longTerm.excludedIneligibleCount
  };
}

function buildPersonSurfaces(
  records: readonly P8IdentityEvidenceRecord[]
): Map<string, Map<string, Attestation[]>> {
  const persons = new Map<string, Map<string, Attestation[]>>();
  for (const record of records) {
    for (const anchor of [record.subject, record.assertor]) {
      if (anchor === undefined || !anchor.surfaceMention) continue;
      const surface = anchor.surfaceMention;
      const key = identityKeyOf(surface);
      if (!key) continue;
      let surfaces = persons.get(anchor.entityId);
      if (surfaces === undefined) {
        surfaces = new Map();
        persons.set(anchor.entityId, surfaces);
      }
      const existing = surfaces.get(key) ?? [];
      existing.push({ record, surface, identityKey: key, ...latinKeyOf(key) });
      surfaces.set(key, existing);
    }
  }
  return persons;
}

function attestedSurfaceKeys(records: readonly P8IdentityEvidenceRecord[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const surfaces of buildPersonSurfaces(records).values()) {
    for (const key of surfaces.keys()) keys.add(key);
  }
  return keys;
}

function surfaceProjection(attestations: Attestation[]): P8IdentitySurfaceForm {
  const sorted = [...attestations].sort((left, right) =>
    compareText(left.record.evidenceReference, right.record.evidenceReference)
  );
  const best = [...sorted].sort(
    (left, right) => authorityRank(left.record.authority) - authorityRank(right.record.authority)
  )[0]!;
  const suppliedAt = sorted
    .map((attestation) => attestation.record.suppliedAt)
    .filter((value): value is string => value !== undefined)
    .sort()
    .at(-1);
  return Object.freeze({
    surface: best.surface,
    identityKey: best.identityKey,
    ...(best.latinKey === undefined ? {} : { latinKey: best.latinKey }),
    authority: best.record.authority,
    evidenceReferences: Object.freeze(
      uniqueSorted(sorted.map((attestation) => attestation.record.evidenceReference))
    ),
    ...(suppliedAt === undefined ? {} : { suppliedAt })
  });
}

function nameMatches(
  records: readonly P8IdentityEvidenceRecord[],
  mentionKey: string,
  addressing: boolean,
  trustedAssertors: ReadonlySet<string>
): NameMatch[] {
  const matches: NameMatch[] = [];
  const mentionLatin = latinKeyOf(mentionKey).latinKey;
  for (const [entityId, surfaces] of buildPersonSurfaces(records)) {
    for (const [key, attestations] of surfaces) {
      const exact = key === mentionKey;
      const variant =
        !exact &&
        mentionLatin !== undefined &&
        attestations.every((attestation) => attestation.latinKey !== undefined) &&
        attestations.some((attestation) => attestation.latinKey === mentionLatin);
      if (!exact && !variant) continue;

      // A latin-script surface is a speech/STT hypothesis: it binds a person
      // only in an addressing position, never by topical occurrence.
      if (mentionLatin !== undefined && !addressing) {
        matches.push({ kind: "blocked" });
        continue;
      }

      const tier = bestTier(
        attestations.map((attestation) => attestation.record),
        trustedAssertors
      );
      if (tier === undefined) continue;
      matches.push({
        kind: "candidate",
        entityId,
        surface: attestations[0]!.surface,
        tier,
        evidenceReferences: uniqueSorted(
          attestations.map((attestation) => attestation.record.evidenceReference)
        ),
        provenanceClasses: provenanceClassesOf(attestations.map((attestation) => attestation.record))
      });
    }
  }
  return matches;
}

function roleMatches(
  records: readonly P8IdentityEvidenceRecord[],
  mentionKey: string,
  currentTime: string | undefined,
  trustedAssertors: ReadonlySet<string>
): {
  entityId: string;
  tier: P8IdentityCandidateTier;
  temporalState: "active" | "expired" | "upcoming";
  evidenceReferences: readonly string[];
  provenanceClasses: readonly MemoryClaimProvenanceClass[];
}[] {
  const roleTerm = stripRolePrefixes(mentionKey);
  if (roleTerm.length < 2) return [];
  // Titles resolved here are CJK role references ("班长", "老大", …). Pure
  // latin role terms would degrade content containment into substring noise
  // and are out of scope for 13A.
  if (!/[\u3400-\u9fff]/.test(roleTerm)) return [];
  const byEntity = new Map<string, P8IdentityEvidenceRecord[]>();
  for (const record of records) {
    if (record.channel !== "LONG_TERM_EVIDENCE" || record.subject === undefined) continue;
    const contentKey = identityKeyOf(record.content);
    if (!contentKey || !contentKey.includes(roleTerm)) continue;
    if (tierForRecord(record, trustedAssertors) === undefined) continue;
    const existing = byEntity.get(record.subject.entityId) ?? [];
    existing.push(record);
    byEntity.set(record.subject.entityId, existing);
  }
  return [...byEntity.entries()]
    .map(([entityId, matched]) => ({
      entityId,
      tier: bestTier(matched, trustedAssertors) ?? "CANDIDATE_ONLY",
      temporalState: mergedTemporalState(matched, currentTime),
      evidenceReferences: uniqueSorted(matched.map((record) => record.evidenceReference)),
      provenanceClasses: provenanceClassesOf(matched)
    }))
    .sort((left, right) => compareText(left.entityId, right.entityId));
}

function contextualMatches(
  records: readonly P8IdentityEvidenceRecord[],
  mentionKey: string
): P8IdentityEvidenceRecord[] {
  if (mentionKey.length < 2) return [];
  return records
    .filter(
      (record) =>
        record.channel === "RECENT_CONVERSATION" &&
        record.content.toLowerCase().includes(mentionKey)
    )
    .sort((left, right) => compareText(left.evidenceReference, right.evidenceReference));
}

function contextualCandidate(record: P8IdentityEvidenceRecord): P8IdentityMentionCandidate {
  return Object.freeze({
    basis: "contextual" as const,
    tier: "CONTEXTUAL" as const,
    contextAnchor: record.evidenceReference,
    evidenceReferences: Object.freeze([record.evidenceReference]),
    provenanceClasses: provenanceClassesOf([record])
  });
}

/**
 * Candidate tier for a set of records attesting the same fact. Assistant
 * output never becomes a candidate; external claims and single weak
 * observations stay candidate-only.
 */
function bestTier(
  records: readonly P8IdentityEvidenceRecord[],
  trustedAssertors: ReadonlySet<string>
): P8IdentityCandidateTier | undefined {
  const meaningful = records
    .map((record) => tierForRecord(record, trustedAssertors))
    .filter((tier): tier is P8IdentityCandidateTier => tier !== undefined);
  if (meaningful.length === 0) return undefined;
  const best = [...meaningful].sort((left, right) => TIER_RANK[left] - TIER_RANK[right])[0]!;
  if (best !== "CANDIDATE_ONLY") return best;
  const observations = records.filter(
    (record) =>
      record.provenanceClass === undefined && record.authority === "OBSERVED_INTERACTION"
  );
  if (new Set(observations.map((record) => record.evidenceReference)).size >= 2) {
    return "CONSISTENT_OBSERVATION";
  }
  return "CANDIDATE_ONLY";
}

function tierForRecord(
  record: P8IdentityEvidenceRecord,
  trustedAssertors: ReadonlySet<string>
): P8IdentityCandidateTier | undefined {
  if (record.provenanceClass === "ASSISTANT_INFERENCE") return undefined;
  if (record.authority === "ASSISTANT_MODEL_GENERATED") return undefined;
  if (record.provenanceClass === "SELF_REPORT") return "TRUSTED_EXPLICIT";
  if (record.authority === "EXPLICIT_USER_ORIGINATED") return "TRUSTED_EXPLICIT";
  if (record.provenanceClass === "DIRECT_OBSERVATION") return "STRONG_ACTIVE";
  if (record.authority === "VERIFIED_SUPPORTED") return "STRONG_ACTIVE";
  if (
    record.provenanceClass === "EXTERNAL_CLAIM" &&
    record.assertor !== undefined &&
    trustedAssertors.has(record.assertor.entityId)
  ) {
    // The primary user's own explicit assignment/correction about someone
    // else is trusted evidence; the same claim from any other assertor stays
    // unverified hearsay.
    return "TRUSTED_EXPLICIT";
  }
  return "CANDIDATE_ONLY";
}

function mergedTemporalState(
  records: readonly P8IdentityEvidenceRecord[],
  currentTime: string | undefined
): "active" | "expired" | "upcoming" {
  const states = records.map((record) => temporalStateOf(record, currentTime));
  if (states.includes("active")) return "active";
  if (states.includes("expired")) return "expired";
  return "upcoming";
}

function temporalStateOf(
  record: P8IdentityEvidenceRecord,
  currentTime: string | undefined
): "active" | "expired" | "upcoming" {
  const reference =
    currentTime === undefined ? undefined : safeParseMs(currentTime);
  if (record.validUntil !== undefined) {
    const until = safeParseMs(record.validUntil);
    if (until !== undefined && reference !== undefined && reference > until) return "expired";
  }
  if (record.validFrom !== undefined) {
    const from = safeParseMs(record.validFrom);
    if (from !== undefined && reference !== undefined && reference < from) return "upcoming";
  }
  return "active";
}

function isDecidableTier(tier: P8IdentityCandidateTier): boolean {
  return TIER_RANK[tier] <= TIER_RANK.CONSISTENT_OBSERVATION;
}

function unresolvedReasonFor(
  candidates: readonly P8IdentityMentionCandidate[],
  blockedSpeechVariant: boolean,
  records: readonly P8IdentityEvidenceRecord[],
  mentionKey: string
): P8IdentityUnresolvedReason {
  if (blockedSpeechVariant) return "speech-variant-without-addressing";
  if (candidates.length === 0) {
    return assistantOnlyEvidence(records, mentionKey)
      ? "assistant-inference-only"
      : "no-evidence";
  }
  if (
    candidates.length > 0 &&
    candidates.every((candidate) => candidate.provenanceClasses.includes("EXTERNAL_CLAIM"))
  ) {
    return "external-claim-only";
  }
  return "insufficient-authority";
}

function assistantOnlyEvidence(
  records: readonly P8IdentityEvidenceRecord[],
  mentionKey: string
): boolean {
  const roleTerm = stripRolePrefixes(mentionKey);
  return records.some((record) => {
    const isAssistant =
      record.provenanceClass === "ASSISTANT_INFERENCE" ||
      record.authority === "ASSISTANT_MODEL_GENERATED";
    if (!isAssistant) return false;
    if (record.channel === "LONG_TERM_EVIDENCE" && roleTerm.length >= 2) {
      const contentKey = identityKeyOf(record.content);
      if (contentKey !== undefined && contentKey.includes(roleTerm)) return true;
    }
    return [record.subject, record.assertor].some(
      (anchor) =>
        anchor?.surfaceMention !== undefined && identityKeyOf(anchor.surfaceMention) === mentionKey
    );
  });
}

function stripRolePrefixes(identityKey: string): string {
  for (const prefix of ROLE_PREFIXES) {
    if (identityKey.startsWith(prefix) && identityKey.length > prefix.length) {
      return identityKey.slice(prefix.length);
    }
  }
  return identityKey;
}

function identityKeyOf(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .trim();
}

function latinKeyOf(identityKey: string): { latinKey?: string } {
  if (!/^[a-z0-9\s'-]+$/.test(identityKey) || !/[a-z0-9]/.test(identityKey)) return {};
  return { latinKey: identityKey.replace(/[^a-z0-9]/g, "") };
}

function provenanceClassesOf(
  records: readonly P8IdentityEvidenceRecord[]
): readonly MemoryClaimProvenanceClass[] {
  return Object.freeze(
    uniqueSorted(
      records
        .map((record) => record.provenanceClass)
        .filter(
          (provenanceClass): provenanceClass is MemoryClaimProvenanceClass =>
            provenanceClass !== undefined
        )
    )
  );
}

function authorityRank(authority: P8EvidenceAuthorityClass): number {
  switch (authority) {
    case "EXPLICIT_USER_ORIGINATED":
      return 0;
    case "VERIFIED_SUPPORTED":
      return 1;
    case "OBSERVED_INTERACTION":
      return 2;
    case "WEAK_INFERRED":
      return 3;
    case "ASSISTANT_MODEL_GENERATED":
      return 4;
  }
}

function safeParseMs(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function comparePerson(left: { entityId: string }, right: { entityId: string }): number {
  return compareText(left.entityId, right.entityId);
}

function compareCandidates(
  left: P8IdentityMentionCandidate,
  right: P8IdentityMentionCandidate
): number {
  const tier = TIER_RANK[left.tier] - TIER_RANK[right.tier];
  if (tier !== 0) return tier;
  const leftKey = left.entityId ?? left.contextAnchor ?? "";
  const rightKey = right.entityId ?? right.contextAnchor ?? "";
  return compareText(leftKey, rightKey);
}

function uniqueSorted<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateScopeReference(scopeReference: string): string {
  if (
    typeof scopeReference !== "string" ||
    scopeReference.length === 0 ||
    scopeReference.length > 160
  ) {
    throw new Error(
      "P8 identity evidence scope reference must be a non-empty string of at most 160 characters."
    );
  }
  return scopeReference;
}

function validateMention(mention: string): string {
  if (typeof mention !== "string" || mention.trim().length === 0 || mention.length > 120) {
    throw new Error("P8 identity mention must be a non-empty string of at most 120 characters.");
  }
  return mention;
}
