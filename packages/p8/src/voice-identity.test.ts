import { describe, expect, it } from "vitest";
import {
  admitVoiceProfilePersonBinding,
  currentEligibleMemoryEvents,
  planVoiceProfilePersonBindingCorrection,
  type MemoryEvent
} from "@companion/memory";
import { createDefaultP8IdentityAddress, resolveP8IdentityMention } from "./index.js";
import {
  projectVoicePersonForCharacter,
  resolveP8VoicePerson,
  voicePersonClaimAssertor,
  type P8VoicePersonResolution
} from "./voice-identity.js";

const SCOPE = "scope-voice-person";
const ADDRESS = createDefaultP8IdentityAddress("subject-voice-person");
const PRIMARY = "person_ruichen";
const PERSON_B = "person_b";
const PROFILE = "vp_7";

function bindingEvent(
  id: string,
  input: Parameters<typeof admitVoiceProfilePersonBinding>[0]
): MemoryEvent | null {
  const admitted = admitVoiceProfilePersonBinding(input);
  if (admitted.decision !== "admit") return null;
  return {
    id,
    kind: "user_claim",
    content: admitted.content,
    source: "mem0",
    sourceRecordId: id,
    scope: SCOPE,
    metadata: admitted.metadata,
    assertion: admitted.assertion,
    claim: admitted.claim
  };
}

function resolve(
  overrides: Partial<Parameters<typeof resolveP8VoicePerson>[0]> = {}
): P8VoicePersonResolution {
  return resolveP8VoicePerson({
    address: ADDRESS,
    scopeReference: SCOPE,
    trustedAssertorEntityIds: [PRIMARY],
    ...overrides
  });
}

describe("P8 voice person resolution", () => {
  it("resolves a matched profile with a trusted binding", () => {
    const event = bindingEvent("mem-trusted-voice", {
      voiceProfileId: PROFILE,
      personId: PRIMARY,
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      provenanceClass: "SELF_REPORT",
      trustedController: true,
      content: "This is my voice."
    });
    const resolution = resolve({
      speakerClusterId: "0",
      voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE },
      longTermEvents: event ? [event] : []
    });
    expect(resolution.status).toBe("RESOLVED_TRUSTED");
    expect(resolution.personId).toBe(PRIMARY);
    expect(resolution.voiceProfileId).toBe(PROFILE);
    expect(projectVoicePersonForCharacter(resolution)).toEqual({
      speaker: "resolved",
      personId: PRIMARY
    });
    expect(JSON.stringify(projectVoicePersonForCharacter(resolution))).not.toContain(PROFILE);
  });

  it("stays unresolved when a matched profile has no person binding", () => {
    const resolution = resolve({
      voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE }
    });
    expect(resolution).toMatchObject({
      status: "UNRESOLVED",
      unresolvedReason: "no-person-binding"
    });
    expect(resolution.personId).toBeUndefined();
  });

  it("reports CONFLICTING when eligible bindings name different people", () => {
    const first = bindingEvent("mem-a", {
      voiceProfileId: PROFILE,
      personId: PRIMARY,
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      provenanceClass: "SELF_REPORT",
      trustedController: true
    });
    const second = bindingEvent("mem-b", {
      voiceProfileId: PROFILE,
      personId: PERSON_B,
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      provenanceClass: "EXTERNAL_CLAIM",
      trustedController: true
    });
    const resolution = resolve({
      voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE },
      longTermEvents: [first, second].filter((event): event is MemoryEvent => event !== null)
    });
    expect(resolution.status).toBe("CONFLICTING");
    expect(resolution.personId).toBeUndefined();
    expect(projectVoicePersonForCharacter(resolution)).toEqual({ speaker: "conflicting" });
  });

  it("ignores superseded bindings and lets the correction win", () => {
    const original = bindingEvent("mem-old", {
      voiceProfileId: PROFILE,
      personId: PRIMARY,
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      provenanceClass: "SELF_REPORT",
      trustedController: true
    });
    expect(original).not.toBeNull();
    const plan = planVoiceProfilePersonBindingCorrection({
      original: original!,
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
    const corrected: MemoryEvent = {
      id: "mem-new",
      kind: "correction",
      content: plan.corrected.content,
      source: "mem0",
      sourceRecordId: "mem-new",
      scope: SCOPE,
      metadata: plan.corrected.metadata ?? {},
      ...(plan.corrected.assertion === undefined ? {} : { assertion: plan.corrected.assertion }),
      ...(plan.corrected.claim === undefined ? {} : { claim: plan.corrected.claim })
    };
    const eligible = currentEligibleMemoryEvents([original!, corrected]);
    const resolution = resolve({
      voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE },
      longTermEvents: eligible
    });
    expect(resolution.status).toBe("RESOLVED_TRUSTED");
    expect(resolution.personId).toBe(PERSON_B);
    expect(resolution.evidenceReferences).toEqual(["mem-new"]);
  });

  it("cannot bind from assistant inference or third-party self-identification", () => {
    const assistant: MemoryEvent = {
      id: "mem-assistant",
      kind: "fact",
      content: "I think this is Ruichen.",
      source: "mem0",
      sourceRecordId: "mem-assistant",
      scope: SCOPE,
      metadata: { yuviVoiceProfileId: PROFILE, yuviVoiceProfileBinding: "assignment" },
      assertion: { source: "assistant", verification: "unverified" },
      claim: {
        provenanceClass: "ASSISTANT_INFERENCE",
        assertor: { entityId: "assistant", resolution: "resolved" },
        subject: { entityId: PRIMARY, resolution: "resolved" }
      }
    };
    expect(
      resolve({
        voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE },
        longTermEvents: [assistant]
      })
    ).toMatchObject({ status: "UNRESOLVED", unresolvedReason: "assistant-inference-only" });

    expect(
      resolve({
        voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE },
        transcriptClaim: "我是马斯克",
        longTermEvents: []
      })
    ).toMatchObject({
      status: "UNRESOLVED",
      unresolvedReason: "transcript-self-identification"
    });
    expect(
      resolve({
        speakerClusterId: "unknown",
        voiceProfileMatch: { status: "NO_MATCH" },
        transcriptClaim: "我是马斯克"
      }).personId
    ).toBeUndefined();
  });

  it("does not resolve a person from cluster, profile, label, or score alone", () => {
    expect(resolve({ speakerClusterId: "0" })).toMatchObject({
      status: "UNRESOLVED",
      unresolvedReason: "speaker-cluster-only"
    });
    expect(
      resolve({ voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE } })
    ).toMatchObject({ status: "UNRESOLVED", unresolvedReason: "no-person-binding" });
    expect(resolve({ sidecarLabel: "ruichen" })).toMatchObject({
      status: "UNRESOLVED",
      unresolvedReason: "sidecar-label-only"
    });
    expect(resolve({ similarityScore: 0.99 })).toMatchObject({
      status: "UNRESOLVED",
      unresolvedReason: "similarity-score-only"
    });
  });

  it("keeps two unknown clusters distinct and does not fabricate claim attribution", () => {
    const first = resolve({
      speakerClusterId: "0",
      voiceProfileMatch: { status: "NO_MATCH" }
    });
    const second = resolve({
      speakerClusterId: "1",
      voiceProfileMatch: { status: "NO_MATCH" }
    });
    expect(first.speakerClusterId).toBe("0");
    expect(second.speakerClusterId).toBe("1");
    expect(first.speakerClusterId).not.toBe(second.speakerClusterId);
    expect(first.status).toBe("UNRESOLVED");
    expect(second.status).toBe("UNRESOLVED");
    expect(
      voicePersonClaimAssertor({
        resolutions: [first, second],
        segments: [{ speakerClusterId: "0" }, { speakerClusterId: "1" }],
        wholeTranscript: "hello together"
      })
    ).toEqual({
      assertor: { resolution: "unresolved" },
      reason: "no-per-span-transcript"
    });
  });

  it("supplies Atom 12 assertor only for a safe single-speaker resolution", () => {
    const event = bindingEvent("mem-single", {
      voiceProfileId: PROFILE,
      personId: PRIMARY,
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      provenanceClass: "SELF_REPORT",
      trustedController: true
    });
    const trusted = resolve({
      speakerClusterId: "0",
      voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE },
      longTermEvents: event ? [event] : []
    });
    expect(
      voicePersonClaimAssertor({
        resolutions: [trusted],
        segments: [{ speakerClusterId: "0", text: "hello" }]
      }).assertor
    ).toEqual({ entityId: PRIMARY, resolution: "resolved" });

    expect(
      voicePersonClaimAssertor({
        resolutions: [{ ...trusted, status: "UNRESOLVED", evidenceReferences: [] }],
        segments: [{ speakerClusterId: "0", text: "hello" }]
      }).assertor
    ).toEqual({ resolution: "unresolved" });
  });

  it("reuses 13A person resolution as the trusted enrollment target", () => {
    const mention = resolveP8IdentityMention({
      mention: "Ruichen",
      address: ADDRESS,
      context: { scopeReference: SCOPE, addressing: true, channel: "typed" },
      longTermEvents: [
        {
          id: "mem-name",
          kind: "fact",
          content: "我叫 Ruichen。",
          source: "mem0",
          sourceRecordId: "mem-name",
          scope: SCOPE,
          metadata: {},
          claim: {
            provenanceClass: "SELF_REPORT",
            assertor: { entityId: PRIMARY, resolution: "resolved" },
            subject: { entityId: PRIMARY, surfaceMention: "Ruichen", resolution: "resolved" }
          }
        }
      ],
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(mention.status).toBe("RESOLVED");
    const admitted = admitVoiceProfilePersonBinding({
      voiceProfileId: PROFILE,
      personId: mention.entityId!,
      assertor: { entityId: PRIMARY, resolution: "resolved" },
      provenanceClass: "SELF_REPORT",
      trustedController: true,
      content: "This is my voice."
    });
    expect(admitted.decision).toBe("admit");
    if (admitted.decision !== "admit") return;
    const event: MemoryEvent = {
      id: "mem-enroll",
      kind: "user_claim",
      content: admitted.content,
      source: "mem0",
      sourceRecordId: "mem-enroll",
      scope: SCOPE,
      metadata: admitted.metadata,
      assertion: admitted.assertion,
      claim: admitted.claim
    };
    const resolution = resolve({
      voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE },
      longTermEvents: [event]
    });
    expect(resolution.status).toBe("RESOLVED_TRUSTED");
    expect(resolution.personId).toBe(PRIMARY);
  });
});
