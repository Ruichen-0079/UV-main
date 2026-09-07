import { describe, expect, it } from "vitest";
import { admitVoiceProfilePersonBinding, type MemoryEvent } from "@companion/memory";
import { createDefaultP8IdentityAddress } from "@companion/p8";
import { interpretSpeechObservationIdentity } from "./runtime-speech-identity.js";

const SCOPE = "scope-runtime-voice";
const ADDRESS = createDefaultP8IdentityAddress("subject-runtime-voice");
const PRIMARY = "person_ruichen";
const PROFILE = "vp_7";

describe("Runtime speech identity interpretation", () => {
  it("resolves a single-speaker observation without admitting interaction", () => {
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
    const event: MemoryEvent = {
      id: "mem-runtime-voice",
      kind: "user_claim",
      content: admitted.content,
      source: "mem0",
      sourceRecordId: "mem-runtime-voice",
      scope: SCOPE,
      metadata: admitted.metadata,
      assertion: admitted.assertion,
      claim: admitted.claim
    };
    const interpretation = interpretSpeechObservationIdentity({
      observation: {
        observationId: "obs-1",
        captureEpoch: "epoch-1",
        text: "几点了",
        segments: [
          {
            segmentId: "seg-1",
            text: "几点了",
            speakerClusterId: "0",
            voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE }
          }
        ]
      },
      address: ADDRESS,
      scopeReference: SCOPE,
      longTermEvents: [event],
      trustedAssertorEntityIds: [PRIMARY]
    });
    expect(interpretation.remainsObservation).toBe(true);
    expect(interpretation.resolutions[0]?.status).toBe("RESOLVED_TRUSTED");
    expect(interpretation.claimAssertor).toEqual({ entityId: PRIMARY, resolution: "resolved" });
    expect(interpretation.characterSpeakers).toEqual([{ speaker: "resolved", personId: PRIMARY }]);
    expect(JSON.stringify(interpretation.characterSpeakers)).not.toContain(PROFILE);
    expect(JSON.stringify(interpretation.characterSpeakers)).not.toMatch(
      /embedding|threshold|score/
    );
  });

  it("fail-closes Atom 12 attribution for mixed capture without per-span transcript", () => {
    const interpretation = interpretSpeechObservationIdentity({
      observation: {
        text: "whole transcript",
        segments: [
          {
            segmentId: "seg-0",
            speakerClusterId: "0",
            voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE }
          },
          { segmentId: "seg-1", speakerClusterId: "1", voiceProfileMatch: { status: "NO_MATCH" } }
        ]
      },
      address: ADDRESS,
      scopeReference: SCOPE
    });
    expect(interpretation.resolutions).toHaveLength(2);
    expect(interpretation.resolutions[0]?.speakerClusterId).toBe("0");
    expect(interpretation.resolutions[1]?.speakerClusterId).toBe("1");
    expect(interpretation.claimAssertor).toEqual({ resolution: "unresolved" });
    expect(interpretation.claimAssertorReason).toBe("no-per-span-transcript");
    expect(interpretation.characterSpeakers).toEqual([
      { speaker: "unknown" },
      { speaker: "unknown" }
    ]);
  });
});

it("carries adapter span words and acoustic identity through the existing Memory binding authority", async () => {
  const { LocalSTTProvider } = await import("@companion/providers");
  const { vi } = await import("vitest");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            text: "first words second words",
            segments: [
              {
                speaker: "cluster-a",
                text: "first words",
                voiceProfileMatch: { status: "MATCHED", voiceProfileId: PROFILE }
              },
              {
                speaker: "cluster-b",
                text: "second words",
                voiceProfileMatch: { status: "MATCHED", voiceProfileId: "unbound-profile" }
              }
            ]
          })
        )
    )
  );
  try {
    const observation = await new LocalSTTProvider({
      baseUrl: "http://localhost:9876",
      model: "sensevoice"
    }).transcribeAudio({ audioBase64: "AAAA" });
    expect(observation.segments?.map((segment) => segment.text)).toEqual([
      "first words",
      "second words"
    ]);
    const input = {
      observation,
      address: ADDRESS,
      scopeReference: SCOPE,
      trustedAssertorEntityIds: [PRIMARY]
    };
    const unbound = interpretSpeechObservationIdentity(input);
    expect(unbound.characterSpeakers).toEqual([{ speaker: "unknown" }, { speaker: "unknown" }]);
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
    const event: MemoryEvent = {
      id: "binding",
      kind: "user_claim",
      content: admitted.content,
      source: "mem0",
      sourceRecordId: "binding",
      scope: SCOPE,
      metadata: admitted.metadata,
      assertion: admitted.assertion,
      claim: admitted.claim
    };
    const bound = interpretSpeechObservationIdentity({ ...input, longTermEvents: [event] });
    expect(bound.characterSpeakers).toEqual([
      { speaker: "resolved", personId: PRIMARY },
      { speaker: "unknown" }
    ]);
    expect(bound.remainsObservation).toBe(true);
    expect(bound.claimAssertor).toEqual({ resolution: "unresolved" });
    expect(JSON.stringify(bound.characterSpeakers)).not.toMatch(/vp_7|cluster-a|unbound-profile/);
  } finally {
    vi.unstubAllGlobals();
  }
});
