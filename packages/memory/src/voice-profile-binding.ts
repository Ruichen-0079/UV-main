import type {
  MemoryClaim,
  MemoryClaimIdentityInput,
  MemoryClaimProvenanceClass,
  MemoryEvent,
  MemoryEventAssertion,
  MemorySourceObservationRef,
  MemoryWriteEventInput
} from "./provider.js";
import {
  admitDurableMemoryClaim,
  planClaimAttributionCorrection,
  serializeClaimMetadata,
  type MemoryClaimAdmission,
  type MemoryClaimCorrectionPlan
} from "./claim.js";

/**
 * Durable voice-profile → person binding evidence (Atom 13B).
 *
 * SpeakerStore remains the acoustic template store. This module only admits
 * an opaque voiceProfileId plus a semantic person claim onto the existing
 * Memory evidence / supersession path. Raw embeddings, waveforms, and
 * biometric tensors are forbidden.
 */

export const VOICE_PROFILE_BINDING_METADATA = {
  voiceProfileId: "yuviVoiceProfileId",
  kind: "yuviVoiceProfileBinding"
} as const;

export const VOICE_PROFILE_BINDING_KIND = "assignment" as const;

const FORBIDDEN_METADATA_KEYS =
  /embedding|rawEmbedding|waveform|biometric|vector|speakerEmbedding/i;

export type VoiceProfilePersonBindingInput = {
  voiceProfileId: string;
  personId: string;
  assertor: MemoryClaimIdentityInput;
  provenanceClass: MemoryClaimProvenanceClass;
  /**
   * Trusted local controller authority. Ambient speech, remote participants,
   * the assistant, and Character cannot set this.
   */
  trustedController: boolean;
  content?: string | null | undefined;
  rawText?: string | null | undefined;
  sourceObservation?: MemorySourceObservationRef | null | undefined;
};

export type VoiceProfilePersonBindingAdmission =
  | {
      decision: "admit";
      content: string;
      claim: MemoryClaim;
      assertion: MemoryEventAssertion;
      metadata: Record<string, unknown>;
    }
  | {
      decision: "reject";
      reason: string;
    };

export function admitVoiceProfilePersonBinding(
  input: VoiceProfilePersonBindingInput
): VoiceProfilePersonBindingAdmission {
  if (input.trustedController !== true) {
    return reject("missing-trusted-controller");
  }
  if (input.provenanceClass === "ASSISTANT_INFERENCE") {
    return reject("assistant-inference-cannot-bind");
  }
  if (input.provenanceClass === "UNKNOWN_AMBIENT") {
    return reject("unresolved-ambient");
  }
  const voiceProfileId = normalizeOpaqueId(input.voiceProfileId);
  if (!voiceProfileId) {
    return reject("empty-voice-profile-id");
  }
  const personId = normalizeOpaqueId(input.personId);
  if (!personId) {
    return reject("empty-person-id");
  }

  const admitted = admitDurableMemoryClaim({
    provenanceClass: input.provenanceClass,
    content: input.content ?? `voice profile ${voiceProfileId} assigned to person`,
    rawText: input.rawText,
    assertor: input.assertor,
    subject: { entityId: personId, resolution: "resolved" },
    sourceObservation: input.sourceObservation
  });
  if (admitted.decision === "reject") {
    return admitted;
  }

  return {
    decision: "admit",
    content: admitted.content,
    claim: admitted.claim,
    assertion: admitted.assertion,
    metadata: {
      ...serializeClaimMetadata(admitted.claim),
      [VOICE_PROFILE_BINDING_METADATA.voiceProfileId]: voiceProfileId,
      [VOICE_PROFILE_BINDING_METADATA.kind]: VOICE_PROFILE_BINDING_KIND
    }
  };
}

export function planVoiceProfilePersonBindingCorrection(input: {
  original: MemoryEvent;
  corrected: VoiceProfilePersonBindingInput;
}): MemoryClaimAdmission | (MemoryClaimCorrectionPlan & { decision: "admit" }) {
  const admitted = admitVoiceProfilePersonBinding(input.corrected);
  if (admitted.decision === "reject") {
    return admitted;
  }
  const plan = planClaimAttributionCorrection({
    original: input.original,
    corrected: {
      provenanceClass: input.corrected.provenanceClass,
      content: admitted.content,
      rawText: input.corrected.rawText,
      assertor: input.corrected.assertor,
      subject: { entityId: input.corrected.personId, resolution: "resolved" },
      sourceObservation: input.corrected.sourceObservation
    }
  });
  if (plan.decision !== "admit" || !("corrected" in plan)) {
    return plan;
  }
  return {
    ...plan,
    corrected: {
      ...plan.corrected,
      metadata: {
        ...(plan.corrected.metadata ?? {}),
        [VOICE_PROFILE_BINDING_METADATA.voiceProfileId]:
          admitted.metadata[VOICE_PROFILE_BINDING_METADATA.voiceProfileId],
        [VOICE_PROFILE_BINDING_METADATA.kind]: VOICE_PROFILE_BINDING_KIND
      }
    }
  };
}

export function readVoiceProfileId(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  if (!metadata) return undefined;
  const value = metadata[VOICE_PROFILE_BINDING_METADATA.voiceProfileId];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isVoiceProfileBindingEvent(event: MemoryEvent): boolean {
  const kind = event.metadata?.[VOICE_PROFILE_BINDING_METADATA.kind];
  return kind === VOICE_PROFILE_BINDING_KIND && readVoiceProfileId(event.metadata) !== undefined;
}

export function assertNoBiometricMetadata(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return true;
  return !Object.keys(metadata).some((key) => FORBIDDEN_METADATA_KEYS.test(key));
}

export function voiceProfileBindingWriteFields(
  admitted: Extract<VoiceProfilePersonBindingAdmission, { decision: "admit" }>
): Pick<MemoryWriteEventInput, "kind" | "content" | "assertion" | "claim" | "metadata"> {
  return {
    kind: "user_claim",
    content: admitted.content,
    assertion: admitted.assertion,
    claim: admitted.claim,
    metadata: admitted.metadata
  };
}

function reject(reason: string): VoiceProfilePersonBindingAdmission {
  return { decision: "reject", reason };
}

function normalizeOpaqueId(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
