import { describe, expect, it } from "vitest";
import { currentEligibleMemoryEvents, type MemoryEvent } from "./index.js";
import {
  admitVoiceProfilePersonBinding,
  assertNoBiometricMetadata,
  isVoiceProfileBindingEvent,
  planVoiceProfilePersonBindingCorrection,
  readVoiceProfileId,
  VOICE_PROFILE_BINDING_METADATA
} from "./voice-profile-binding.js";

const PRIMARY = "person_ruichen";
const PERSON_B = "person_b";
const PROFILE = "vp_7";

function eventFromAdmission(
  id: string,
  admitted: Extract<ReturnType<typeof admitVoiceProfilePersonBinding>, { decision: "admit" }>
): MemoryEvent {
  return {
    id,
    kind: "user_claim",
    content: admitted.content,
    source: "mem0",
    sourceRecordId: id,
    scope: "scope-voice",
    metadata: admitted.metadata,
    assertion: admitted.assertion,
    claim: admitted.claim
  };
}

describe("voice profile person binding evidence", () => {
  it("admits a trusted controller assignment of an opaque voiceProfileId", () => {
    const admitted = admitVoiceProfilePersonBinding({
      voiceProfileId: PROFILE,
      personId: PRIMARY,
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      provenanceClass: "SELF_REPORT",
      trustedController: true,
      content: "This is my voice."
    });
    expect(admitted.decision).toBe("admit");
    if (admitted.decision !== "admit") return;
    expect(readVoiceProfileId(admitted.metadata)).toBe(PROFILE);
    expect(admitted.claim.subject.entityId).toBe(PRIMARY);
    expect(JSON.stringify(admitted)).not.toMatch(/embedding|waveform|0\.\d{2,}/);
    expect(assertNoBiometricMetadata(admitted.metadata)).toBe(true);
  });

  it("rejects assistant inference, third-party self-id, and missing controller", () => {
    expect(
      admitVoiceProfilePersonBinding({
        voiceProfileId: PROFILE,
        personId: PRIMARY,
        assertor: { entityId: PRIMARY, resolution: "resolved" },
        provenanceClass: "ASSISTANT_INFERENCE",
        trustedController: true
      })
    ).toEqual({ decision: "reject", reason: "assistant-inference-cannot-bind" });

    expect(
      admitVoiceProfilePersonBinding({
        voiceProfileId: PROFILE,
        personId: "person_musk",
        assertor: { entityId: "unknown_speaker", resolution: "resolved" },
        provenanceClass: "SELF_REPORT",
        trustedController: false,
        content: "我是马斯克"
      })
    ).toEqual({ decision: "reject", reason: "missing-trusted-controller" });

    expect(
      admitVoiceProfilePersonBinding({
        voiceProfileId: PROFILE,
        personId: PRIMARY,
        assertor: { resolution: "unresolved" },
        provenanceClass: "SELF_REPORT",
        trustedController: true
      }).decision
    ).toBe("reject");
  });

  it("does not treat transcript self-identification as a binding", () => {
    const admitted = admitVoiceProfilePersonBinding({
      voiceProfileId: PROFILE,
      personId: "person_musk",
      assertor: { surfaceMention: "马斯克", resolution: "unresolved" },
      provenanceClass: "SELF_REPORT",
      trustedController: true,
      content: "我是马斯克"
    });
    expect(admitted).toEqual({ decision: "reject", reason: "unresolved-identity" });
  });

  it("supersedes a wrong binding without rewriting the original observation", () => {
    const originalAdmission = admitVoiceProfilePersonBinding({
      voiceProfileId: PROFILE,
      personId: PRIMARY,
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      provenanceClass: "SELF_REPORT",
      trustedController: true,
      content: "This is A."
    });
    expect(originalAdmission.decision).toBe("admit");
    if (originalAdmission.decision !== "admit") return;
    const original = eventFromAdmission("mem-wrong-voice", originalAdmission);
    const plan = planVoiceProfilePersonBindingCorrection({
      original,
      corrected: {
        voiceProfileId: PROFILE,
        personId: PERSON_B,
        assertor: { entityId: PRIMARY, resolution: "resolved" },
        provenanceClass: "EXTERNAL_CLAIM",
        trustedController: true,
        content: "刚才那个声音其实是 B。"
      }
    });
    expect(plan.decision).toBe("admit");
    if (plan.decision !== "admit" || !("corrected" in plan)) return;
    expect(plan.originalRemainsImmutable).toBe(true);
    expect(original.claim?.subject.entityId).toBe(PRIMARY);
    expect(plan.corrected.claim?.subject.entityId).toBe(PERSON_B);
    expect(readVoiceProfileId(plan.corrected.metadata)).toBe(PROFILE);

    const corrected: MemoryEvent = {
      id: "mem-corrected-voice",
      kind: "correction",
      content: plan.corrected.content,
      source: "mem0",
      sourceRecordId: "mem-corrected-voice",
      scope: "scope-voice",
      metadata: plan.corrected.metadata ?? {},
      ...(plan.corrected.assertion === undefined ? {} : { assertion: plan.corrected.assertion }),
      ...(plan.corrected.claim === undefined ? {} : { claim: plan.corrected.claim })
    };
    const eligible = currentEligibleMemoryEvents([original, corrected]);
    expect(eligible.map((event) => event.id)).toEqual(["mem-corrected-voice"]);
    expect(isVoiceProfileBindingEvent(corrected)).toBe(true);
    expect(eligible[0]?.metadata[VOICE_PROFILE_BINDING_METADATA.voiceProfileId]).toBe(PROFILE);
  });
});
