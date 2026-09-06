import {
  currentEligibleMemoryEvents,
  isVoiceProfileBindingEvent,
  readVoiceProfileId,
  type MemoryClaimIdentityInput,
  type MemoryClaimProvenanceClass,
  type MemoryEvent
} from "@companion/memory";
import type { P8IdentityAddress } from "./index.js";

/**
 * Voice profile → person resolution (Atom 13B).
 *
 * Acoustic match identifies a voice profile. P8 interprets eligible Memory
 * binding evidence to a person. Similarity scores, sidecar labels, cluster
 * ids, and transcript self-identification cannot resolve a person.
 *
 * RESOLVED_SUPPORTED is part of the published status vocabulary for contract
 * compatibility, but current evidence architecture has no legal "supported
 * but not trusted" voice-person binding. Only trusted explicit controller
 * assignment can resolve. This module never emits RESOLVED_SUPPORTED.
 */

export const P8_VOICE_PERSON_VERSION = "p8-voice-person.v1" as const;

export const P8_VOICE_PERSON_STATUSES = [
  "RESOLVED_TRUSTED",
  "RESOLVED_SUPPORTED",
  "UNRESOLVED",
  "CONFLICTING"
] as const;

export type P8VoicePersonStatus = (typeof P8_VOICE_PERSON_STATUSES)[number];

export const P8_VOICE_PROFILE_MATCH_STATUSES = ["MATCHED", "NO_MATCH"] as const;

export type P8VoiceProfileMatchStatus = (typeof P8_VOICE_PROFILE_MATCH_STATUSES)[number];

export type P8VoiceProfileMatch = Readonly<{
  status: P8VoiceProfileMatchStatus;
  voiceProfileId?: string;
}>;

export type P8VoicePersonUnresolvedReason =
  | "no-acoustic-match"
  | "no-person-binding"
  | "mixed-capture-unattributed"
  | "speaker-cluster-only"
  | "voice-profile-only"
  | "sidecar-label-only"
  | "similarity-score-only"
  | "assistant-inference-only"
  | "transcript-self-identification"
  | "no-per-span-transcript";

export type P8VoicePersonResolution = Readonly<{
  resolutionVersion: typeof P8_VOICE_PERSON_VERSION;
  status: P8VoicePersonStatus;
  speakerClusterId?: string;
  voiceProfileId?: string;
  personId?: string;
  evidenceReferences: readonly string[];
  unresolvedReason?: P8VoicePersonUnresolvedReason;
}>;

export type P8CharacterSpeakerView = Readonly<
  { speaker: "resolved"; personId: string } | { speaker: "unknown" } | { speaker: "conflicting" }
>;

export type P8VoicePersonResolutionInput = Readonly<{
  address: P8IdentityAddress;
  scopeReference: string;
  speakerClusterId?: string;
  voiceProfileMatch?: P8VoiceProfileMatch;
  longTermEvents?: readonly MemoryEvent[];
  trustedAssertorEntityIds?: readonly string[];
  /**
   * Forbidden bootstrap inputs. Presence never creates a person binding.
   */
  sidecarLabel?: string;
  similarityScore?: number;
  transcriptClaim?: string;
}>;

export function resolveP8VoicePerson(input: P8VoicePersonResolutionInput): P8VoicePersonResolution {
  validateScopeReference(input.scopeReference);
  const speakerClusterId = normalizeOptional(input.speakerClusterId);
  const match = input.voiceProfileMatch;
  const voiceProfileId =
    match?.status === "MATCHED" ? normalizeOptional(match.voiceProfileId) : undefined;

  const base = {
    resolutionVersion: P8_VOICE_PERSON_VERSION as typeof P8_VOICE_PERSON_VERSION,
    ...(speakerClusterId === undefined ? {} : { speakerClusterId }),
    ...(voiceProfileId === undefined ? {} : { voiceProfileId }),
    evidenceReferences: Object.freeze([]) as readonly string[]
  };

  if (match === undefined || match.status === "NO_MATCH" || voiceProfileId === undefined) {
    return Object.freeze({
      ...base,
      status: "UNRESOLVED" as const,
      unresolvedReason: unresolvedWithoutMatch(input)
    });
  }

  const eligible = currentEligibleMemoryEvents(input.longTermEvents ?? []);
  const trustedAssertors = new Set(input.trustedAssertorEntityIds ?? []);
  const bindings = eligible.filter(
    (event) =>
      isVoiceProfileBindingEvent(event) &&
      readVoiceProfileId(event.metadata) === voiceProfileId &&
      event.scope === input.scopeReference
  );

  const trustedPersons = new Map<string, string[]>();
  let assistantOnly = false;
  for (const event of bindings) {
    const personId = event.claim?.subject.entityId;
    const provenance = event.claim?.provenanceClass;
    if (!personId || event.claim?.subject.resolution !== "resolved") continue;
    if (provenance === "ASSISTANT_INFERENCE" || event.assertion?.source === "assistant") {
      assistantOnly = true;
      continue;
    }
    if (!isTrustedBinding(event, trustedAssertors, provenance)) continue;
    const refs = trustedPersons.get(personId) ?? [];
    refs.push(event.id);
    trustedPersons.set(personId, refs);
  }

  if (trustedPersons.size > 1) {
    return Object.freeze({
      ...base,
      status: "CONFLICTING" as const,
      evidenceReferences: Object.freeze(
        [...trustedPersons.values()].flat().sort((left, right) => left.localeCompare(right))
      )
    });
  }

  const resolved = [...trustedPersons.entries()][0];
  if (resolved) {
    return Object.freeze({
      ...base,
      status: "RESOLVED_TRUSTED" as const,
      personId: resolved[0],
      evidenceReferences: Object.freeze(
        resolved[1].slice().sort((left, right) => left.localeCompare(right))
      )
    });
  }

  return Object.freeze({
    ...base,
    status: "UNRESOLVED" as const,
    unresolvedReason: assistantOnly
      ? "assistant-inference-only"
      : transcriptLooksLikeSelfId(input.transcriptClaim)
        ? "transcript-self-identification"
        : "no-person-binding",
    evidenceReferences: Object.freeze(
      bindings.map((event) => event.id).sort((left, right) => left.localeCompare(right))
    )
  });
}

export function projectVoicePersonForCharacter(
  resolution: P8VoicePersonResolution
): P8CharacterSpeakerView {
  if (resolution.status === "RESOLVED_TRUSTED" && resolution.personId) {
    return Object.freeze({ speaker: "resolved", personId: resolution.personId });
  }
  if (resolution.status === "CONFLICTING") {
    return Object.freeze({ speaker: "conflicting" });
  }
  return Object.freeze({ speaker: "unknown" });
}

/**
 * Atom 12 assertor from a speech observation. Fail-closed when transcript
 * attribution is not cluster-safe (multiple clusters, no per-span text).
 */
export function voicePersonClaimAssertor(input: {
  resolutions: readonly P8VoicePersonResolution[];
  segments?: readonly {
    speakerClusterId?: string;
    text?: string;
    voiceProfileMatch?: P8VoiceProfileMatch;
  }[];
  wholeTranscript?: string;
}): { assertor: MemoryClaimIdentityInput; reason?: P8VoicePersonUnresolvedReason } {
  const clusterIds = unique(
    (input.segments ?? [])
      .map((segment) => segment.speakerClusterId)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  );
  const perSpanTranscript = (input.segments ?? []).some(
    (segment) => typeof segment.text === "string" && segment.text.trim().length > 0
  );

  if (clusterIds.length > 1 && !perSpanTranscript) {
    return {
      assertor: { resolution: "unresolved" },
      reason: "no-per-span-transcript"
    };
  }

  const distinctPersons = unique(
    input.resolutions
      .filter((resolution) => resolution.status === "RESOLVED_TRUSTED" && resolution.personId)
      .map((resolution) => resolution.personId as string)
  );
  const conflicting = input.resolutions.some((resolution) => resolution.status === "CONFLICTING");
  if (conflicting || distinctPersons.length !== 1) {
    return {
      assertor: { resolution: "unresolved" },
      reason: distinctPersons.length === 0 ? "no-person-binding" : "mixed-capture-unattributed"
    };
  }

  return {
    assertor: { entityId: distinctPersons[0], resolution: "resolved" }
  };
}

function isTrustedBinding(
  event: MemoryEvent,
  trustedAssertors: ReadonlySet<string>,
  provenance: MemoryClaimProvenanceClass | undefined
): boolean {
  const assertorId = event.claim?.assertor.entityId;
  if (!assertorId || event.claim?.assertor.resolution !== "resolved") return false;
  if (provenance === "SELF_REPORT") return true;
  if (provenance === "EXTERNAL_CLAIM") return trustedAssertors.has(assertorId);
  return false;
}

function unresolvedWithoutMatch(
  input: P8VoicePersonResolutionInput
): P8VoicePersonUnresolvedReason {
  if (input.similarityScore !== undefined && input.voiceProfileMatch === undefined) {
    return "similarity-score-only";
  }
  if (input.sidecarLabel !== undefined && input.voiceProfileMatch === undefined) {
    return "sidecar-label-only";
  }
  if (
    input.speakerClusterId !== undefined &&
    (input.voiceProfileMatch === undefined || input.voiceProfileMatch.status === "NO_MATCH")
  ) {
    return input.voiceProfileMatch === undefined ? "speaker-cluster-only" : "no-acoustic-match";
  }
  if (transcriptLooksLikeSelfId(input.transcriptClaim)) {
    return "transcript-self-identification";
  }
  if (input.voiceProfileMatch?.status === "MATCHED" && !input.voiceProfileMatch.voiceProfileId) {
    return "voice-profile-only";
  }
  return "no-acoustic-match";
}

function transcriptLooksLikeSelfId(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  return /我是|i am\b|i'm\b/i.test(value);
}

function unique(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function validateScopeReference(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 160) {
    throw new Error(
      "P8 voice person scope reference must be a non-empty string of at most 160 characters."
    );
  }
}
