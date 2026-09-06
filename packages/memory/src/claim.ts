import type {
  MemoryClaim,
  MemoryClaimAttributionInput,
  MemoryClaimIdentity,
  MemoryClaimIdentityInput,
  MemoryClaimIdentityResolution,
  MemoryClaimProvenanceClass,
  MemoryEvent,
  MemoryEventAssertion,
  MemoryEventVerification,
  MemorySourceObservationRef,
  MemoryWriteEventInput
} from "./provider.js";
import { MEMORY_CLAIM_PROVENANCE_CLASSES } from "./provider.js";

export const MEMORY_CLAIM_METADATA = {
  provenanceClass: "yuviClaimProvenanceClass",
  assertorEntityId: "yuviClaimAssertorEntityId",
  assertorSurfaceMention: "yuviClaimAssertorSurfaceMention",
  assertorResolution: "yuviClaimAssertorResolution",
  subjectEntityId: "yuviClaimSubjectEntityId",
  subjectSurfaceMention: "yuviClaimSubjectSurfaceMention",
  subjectResolution: "yuviClaimSubjectResolution",
  rawText: "yuviClaimRawText",
  observationId: "yuviSourceObservationId",
  captureEpoch: "yuviSourceCaptureEpoch",
  segmentId: "yuviSourceSegmentId",
  supersedes: "yuviClaimSupersedes",
  memoryStatus: "yuviMemoryStatus"
} as const;

export type MemoryClaimAdmission =
  | {
      decision: "admit";
      content: string;
      claim: MemoryClaim;
      assertion: MemoryEventAssertion;
    }
  | {
      decision: "reject";
      reason: string;
    };

export type MemoryClaimCorrectionPlan = {
  originalEventId: string;
  originalRemainsImmutable: true;
  supersededEventId: string;
  corrected: Pick<MemoryWriteEventInput, "kind" | "content" | "assertion" | "claim" | "metadata">;
};

const LEGAL_PROVENANCE = new Set<string>(MEMORY_CLAIM_PROVENANCE_CLASSES);
const LEGAL_RESOLUTION = new Set<MemoryClaimIdentityResolution>(["resolved", "unresolved"]);

export function admitDurableMemoryClaim(
  input: MemoryClaimAttributionInput
): MemoryClaimAdmission {
  const provenanceClass = input.provenanceClass;
  if (!LEGAL_PROVENANCE.has(provenanceClass)) {
    return reject("unknown-provenance-class");
  }
  if (provenanceClass === "UNKNOWN_AMBIENT") {
    return reject("unresolved-ambient");
  }

  const rawText = normalizeOptionalText(input.rawText);
  const content = normalizeRequiredText(input.content) ?? rawText;
  if (!content) {
    return reject("empty-claim");
  }

  const assertor = normalizeIdentity(input.assertor);
  const subject = normalizeIdentity(input.subject);
  if (assertor.resolution === "unresolved" || subject.resolution === "unresolved") {
    return reject("unresolved-identity");
  }
  if (provenanceClass === "SELF_REPORT" && assertor.entityId !== subject.entityId) {
    return reject("self-report-requires-same-assertor-subject");
  }

  const verification = verificationFor(provenanceClass, input.verification, input.confidence);
  const assertion: MemoryEventAssertion = {
    source: assertionSourceFor(provenanceClass),
    verification
  };
  const sourceObservation = normalizeSourceObservation(input.sourceObservation);
  const claim: MemoryClaim = {
    provenanceClass,
    assertor,
    subject,
    ...(rawText ? { rawText } : {}),
    ...(sourceObservation ? { sourceObservation } : {})
  };

  return { decision: "admit", content, claim, assertion };
}

export function planClaimAttributionCorrection(input: {
  original: MemoryEvent;
  corrected: MemoryClaimAttributionInput;
}): MemoryClaimAdmission | (MemoryClaimCorrectionPlan & { decision: "admit" }) {
  const admitted = admitDurableMemoryClaim({
    ...input.corrected,
    content: input.corrected.content ?? input.original.content,
    rawText: input.corrected.rawText ?? input.original.claim?.rawText
  });
  if (admitted.decision === "reject") {
    return admitted;
  }
  return {
    decision: "admit",
    originalEventId: input.original.id,
    originalRemainsImmutable: true,
    supersededEventId: input.original.id,
    corrected: {
      kind: "correction",
      content: admitted.content,
      assertion: admitted.assertion,
      claim: admitted.claim,
      metadata: {
        ...serializeClaimMetadata(admitted.claim),
        [MEMORY_CLAIM_METADATA.supersedes]: [input.original.id],
        correctionReason: "attribution-correction"
      }
    }
  };
}

export function currentEligibleMemoryEvents(events: readonly MemoryEvent[]): MemoryEvent[] {
  const superseded = new Set<string>();
  for (const event of events) {
    for (const id of readSupersededIds(event.metadata)) {
      superseded.add(id);
    }
  }
  return events.filter(
    (event) => !superseded.has(event.id) && !isSupersededClaimMetadata(event.metadata)
  );
}

export function serializeClaimMetadata(claim: MemoryClaim): Record<string, string | string[]> {
  const metadata: Record<string, string | string[]> = {
    [MEMORY_CLAIM_METADATA.provenanceClass]: claim.provenanceClass,
    [MEMORY_CLAIM_METADATA.assertorResolution]: claim.assertor.resolution,
    [MEMORY_CLAIM_METADATA.subjectResolution]: claim.subject.resolution
  };
  if (claim.assertor.entityId) {
    metadata[MEMORY_CLAIM_METADATA.assertorEntityId] = claim.assertor.entityId;
  }
  if (claim.assertor.surfaceMention) {
    metadata[MEMORY_CLAIM_METADATA.assertorSurfaceMention] = claim.assertor.surfaceMention;
  }
  if (claim.subject.entityId) {
    metadata[MEMORY_CLAIM_METADATA.subjectEntityId] = claim.subject.entityId;
  }
  if (claim.subject.surfaceMention) {
    metadata[MEMORY_CLAIM_METADATA.subjectSurfaceMention] = claim.subject.surfaceMention;
  }
  if (claim.rawText) {
    metadata[MEMORY_CLAIM_METADATA.rawText] = claim.rawText;
  }
  const observation = claim.sourceObservation;
  if (observation?.observationId) {
    metadata[MEMORY_CLAIM_METADATA.observationId] = observation.observationId;
  }
  if (observation?.captureEpoch) {
    metadata[MEMORY_CLAIM_METADATA.captureEpoch] = observation.captureEpoch;
  }
  if (observation?.segmentId) {
    metadata[MEMORY_CLAIM_METADATA.segmentId] = observation.segmentId;
  }
  return metadata;
}

export function deserializeClaimMetadata(
  metadata: Record<string, unknown> | undefined
): MemoryClaim | undefined {
  if (!metadata) return undefined;
  const provenanceClass = readString(metadata, MEMORY_CLAIM_METADATA.provenanceClass);
  if (!provenanceClass || !LEGAL_PROVENANCE.has(provenanceClass)) {
    return undefined;
  }
  const assertor = identityFromMetadata(
    metadata,
    MEMORY_CLAIM_METADATA.assertorEntityId,
    MEMORY_CLAIM_METADATA.assertorSurfaceMention,
    MEMORY_CLAIM_METADATA.assertorResolution
  );
  const subject = identityFromMetadata(
    metadata,
    MEMORY_CLAIM_METADATA.subjectEntityId,
    MEMORY_CLAIM_METADATA.subjectSurfaceMention,
    MEMORY_CLAIM_METADATA.subjectResolution
  );
  if (!assertor || !subject) return undefined;
  const rawText = readString(metadata, MEMORY_CLAIM_METADATA.rawText);
  const sourceObservation = normalizeSourceObservation({
    observationId: readString(metadata, MEMORY_CLAIM_METADATA.observationId),
    captureEpoch: readString(metadata, MEMORY_CLAIM_METADATA.captureEpoch),
    segmentId: readString(metadata, MEMORY_CLAIM_METADATA.segmentId)
  });
  return {
    provenanceClass: provenanceClass as MemoryClaimProvenanceClass,
    assertor,
    subject,
    ...(rawText ? { rawText } : {}),
    ...(sourceObservation ? { sourceObservation } : {})
  };
}

export function claimAttributionFromUnknown(
  value: unknown
): MemoryClaimAttributionInput | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as MemoryClaimAttributionInput;
  if (!LEGAL_PROVENANCE.has(record.provenanceClass)) {
    return undefined;
  }
  return record;
}

function reject(reason: string): MemoryClaimAdmission {
  return { decision: "reject", reason };
}

function normalizeIdentity(input: MemoryClaimIdentityInput | null | undefined): MemoryClaimIdentity {
  const surfaceMention = normalizeOptionalText(input?.surfaceMention) ?? null;
  const entityId = normalizeOptionalText(input?.entityId);
  const requested = input?.resolution;
  const resolution: MemoryClaimIdentityResolution =
    requested && LEGAL_RESOLUTION.has(requested)
      ? requested
      : entityId
        ? "resolved"
        : "unresolved";
  if (resolution !== "resolved" || !entityId) {
    return {
      entityId: null,
      ...(surfaceMention ? { surfaceMention } : {}),
      resolution: "unresolved"
    };
  }
  return {
    entityId,
    ...(surfaceMention ? { surfaceMention } : {}),
    resolution: "resolved"
  };
}

function identityFromMetadata(
  metadata: Record<string, unknown>,
  entityKey: string,
  surfaceKey: string,
  resolutionKey: string
): MemoryClaimIdentity | undefined {
  const resolution = readString(metadata, resolutionKey);
  if (!resolution || !LEGAL_RESOLUTION.has(resolution as MemoryClaimIdentityResolution)) {
    return undefined;
  }
  return normalizeIdentity({
    entityId: readString(metadata, entityKey),
    surfaceMention: readString(metadata, surfaceKey),
    resolution: resolution as MemoryClaimIdentityResolution
  });
}

function verificationFor(
  provenanceClass: MemoryClaimProvenanceClass,
  requested: MemoryEventVerification | null | undefined,
  _confidence: number | null | undefined
): MemoryEventVerification {
  if (provenanceClass === "EXTERNAL_CLAIM" || provenanceClass === "ASSISTANT_INFERENCE") {
    return "unverified";
  }
  if (requested === "verified" || requested === "unverified" || requested === "unknown") {
    return requested;
  }
  return "unverified";
}

function assertionSourceFor(
  provenanceClass: MemoryClaimProvenanceClass
): MemoryEventAssertion["source"] {
  switch (provenanceClass) {
    case "ASSISTANT_INFERENCE":
      return "assistant";
    case "DIRECT_OBSERVATION":
      return "system";
    case "SELF_REPORT":
    case "EXTERNAL_CLAIM":
      return "user";
    case "UNKNOWN_AMBIENT":
      return "unknown";
  }
}

function normalizeSourceObservation(
  input: MemorySourceObservationRef | null | undefined
): MemorySourceObservationRef | undefined {
  if (!input) return undefined;
  const observationId = normalizeOptionalText(input.observationId);
  const captureEpoch = normalizeOptionalText(input.captureEpoch);
  const segmentId = normalizeOptionalText(input.segmentId);
  if (!observationId && !captureEpoch && !segmentId) return undefined;
  return {
    ...(observationId ? { observationId } : {}),
    ...(captureEpoch ? { captureEpoch } : {}),
    ...(segmentId ? { segmentId } : {})
  };
}

function readSupersededIds(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const value = metadata[MEMORY_CLAIM_METADATA.supersedes];
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isSupersededClaimMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false;
  const status = readString(metadata, MEMORY_CLAIM_METADATA.memoryStatus);
  return status === "superseded" || status === "forgotten" || status === "retracted";
}

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRequiredText(value: string | null | undefined): string | undefined {
  return normalizeOptionalText(value)?.replace(/\s+/g, " ");
}

function readString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
