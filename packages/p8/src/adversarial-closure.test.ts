import { describe, expect, it } from "vitest";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  createDefaultP8IdentityAddress,
  createP8CorrectionRecord,
  parseP8CorrectionRecord,
  reconstructP8Projection,
  type P8CorrectionStoreLoadResult,
  type P8ExplicitCorrection,
  type P8IdentityAddress,
  type P8ReferencedInterpretationCandidate,
  type P8ReconstructionOutcome
} from "./index.js";

const ADDRESS = createDefaultP8IdentityAddress("subject-p8-1f");
const SCOPE = { reference: "scope-p8-1f" } as const;

function memoryEvent(
  overrides: {
    id?: string;
    content?: string;
    scope?: string;
    source?: string;
    sourceRecordId?: string;
    assertionSource?: "user" | "assistant" | "system" | "mixed" | "unknown";
    recordedAt?: string;
    metadata?: Record<string, unknown>;
    kind?: MemoryEvent["kind"];
  } = {}
): MemoryEvent {
  return {
    id: overrides.id ?? "memory-p8-1f",
    kind: overrides.kind ?? "fact",
    content: overrides.content ?? "The user supplied stable evidence.",
    source: overrides.source ?? "p8-1f-memory-backend",
    sourceRecordId: overrides.sourceRecordId ?? "opaque-source-record",
    scope: overrides.scope ?? SCOPE.reference,
    recordedAt: overrides.recordedAt ?? "2026-08-30T00:00:00.000Z",
    metadata: overrides.metadata ?? {},
    assertion: {
      source: overrides.assertionSource ?? "user",
      verification: "verified"
    }
  };
}

function retrieval(events: readonly MemoryEvent[]): MemoryRetrievalOutcome {
  return {
    status: events.length > 0 ? "ok" : "empty",
    events: [...events],
    source: "p8-1f-memory",
    limited: false
  };
}

function candidate(
  interpretationReference: string,
  overrides: {
    domain?: "BACKGROUND" | "COMMUNICATION_PREFERENCE" | "SHARED_HISTORY" | "RELATIONSHIP_CONTEXT";
    meaning?: string;
    links?: readonly {
      evidenceReference: string;
      relation: "SUPPORTS" | "CONTRADICTS";
      support: "DIRECT" | "LIMITED" | "NON_AUTHORITATIVE";
    }[];
  } = {}
): P8ReferencedInterpretationCandidate {
  return {
    interpretationReference,
    candidate: {
      domain: overrides.domain ?? "BACKGROUND",
      ...(overrides.meaning === undefined ? {} : { meaning: overrides.meaning }),
      ...(overrides.links === undefined ? {} : { evidenceLinks: overrides.links })
    }
  };
}

function correction(
  overrides: {
    correctionReference?: string;
    address?: P8IdentityAddress;
    scopeReference?: { reference: string };
    interpretationReference?: string;
    action?: "REVISE" | "RETRACT";
    replacementMeaning?: string;
    provenanceReference?: string;
    suppliedAt?: string;
    supersedesCorrectionReference?: string;
  } = {}
): P8ExplicitCorrection {
  const action = overrides.action ?? "REVISE";
  return {
    correctionReference: overrides.correctionReference ?? "correction-p8-1f",
    address: overrides.address ?? ADDRESS,
    scopeReference: overrides.scopeReference ?? SCOPE,
    target: {
      kind: "INTERPRETATION",
      interpretationReference: overrides.interpretationReference ?? "ref-p8-1f"
    },
    action,
    ...(action === "REVISE"
      ? { replacementMeaning: overrides.replacementMeaning ?? "Explicit corrected meaning." }
      : {}),
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: overrides.provenanceReference ?? "explicit-user-p8-1f",
      ...(overrides.suppliedAt === undefined ? {} : { suppliedAt: overrides.suppliedAt })
    },
    ...(overrides.supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference: overrides.supersedesCorrectionReference })
  };
}

function correctionStore(
  corrections: readonly P8ExplicitCorrection[]
): P8CorrectionStoreLoadResult {
  return corrections.length === 0
    ? { status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] }
    : { status: "SUCCESS_WITH_CORRECTIONS", corrections };
}

function reconstruct(
  overrides: {
    address?: P8IdentityAddress;
    longTerm?: MemoryRetrievalOutcome;
    recentConversation?: {
      messages: readonly {
        messageReference: string;
        role: "user" | "assistant";
        content: string;
        scopeReference: { reference: string };
      }[];
      maxMessages: number;
      maxCharacters: number;
    };
    candidates?: readonly P8ReferencedInterpretationCandidate[];
    store?: P8CorrectionStoreLoadResult;
    scopeReference?: { reference: string };
  } = {}
): P8ReconstructionOutcome {
  return reconstructP8Projection({
    address: overrides.address ?? ADDRESS,
    authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
    expectedScopeReference: overrides.scopeReference ?? SCOPE,
    longTerm: overrides.longTerm ?? retrieval([memoryEvent()]),
    ...(overrides.recentConversation === undefined
      ? {}
      : { recentConversation: overrides.recentConversation }),
    referencedInterpretationCandidates: overrides.candidates ?? [
      candidate("ref-p8-1f", {
        meaning: "Stable base meaning.",
        links: [{ evidenceReference: "memory-p8-1f", relation: "SUPPORTS", support: "DIRECT" }]
      })
    ],
    correctionStore: overrides.store ?? correctionStore([])
  });
}

function reconstructed(outcome: P8ReconstructionOutcome) {
  if (outcome.status !== "RECONSTRUCTED") {
    throw new Error(`Expected RECONSTRUCTED, got ${outcome.status}.`);
  }
  return outcome.projection;
}

describe("P8-1F adversarial closure", () => {
  it("does not let repeated assistant/model evidence self-reinforce into stable truth", () => {
    const assistantEvents = ["a", "b", "c", "d"].map((suffix) =>
      memoryEvent({
        id: `assistant-${suffix}`,
        content: "The assistant keeps claiming the relationship is close.",
        assertionSource: "assistant"
      })
    );
    const projection = reconstructed(
      reconstruct({
        longTerm: retrieval(assistantEvents),
        candidates: [
          candidate("relationship-ref", {
            domain: "RELATIONSHIP_CONTEXT",
            meaning: "The user and Yuvi have a close relationship.",
            links: assistantEvents.map((event) => ({
              evidenceReference: event.id,
              relation: "SUPPORTS" as const,
              support: "DIRECT" as const
            }))
          })
        ]
      })
    );

    expect(projection.interpretations[0]).toMatchObject({
      status: "UNKNOWN",
      support: "NON_AUTHORITATIVE"
    });
    expect(projection.interpretations[0]).not.toHaveProperty("meaning");
  });

  it("caps ordinary recent-user relationship, joke, and correction-like utterances below KNOWN", () => {
    const messages = [
      { messageReference: "recent-love", content: "I love you." },
      { messageReference: "recent-roleplay", content: "Pretend we are dating for this roleplay." },
      { messageReference: "recent-correction", content: "Correction: we are definitely married." }
    ].map((message) => ({
      ...message,
      role: "user" as const,
      scopeReference: SCOPE
    }));
    const projection = reconstructed(
      reconstruct({
        longTerm: retrieval([]),
        recentConversation: { messages, maxMessages: 3, maxCharacters: 300 },
        candidates: [
          candidate("recent-relationship-ref", {
            domain: "RELATIONSHIP_CONTEXT",
            meaning: "The user and Yuvi are romantic partners.",
            links: messages.map((message) => ({
              evidenceReference: `recent-conversation:${message.messageReference}`,
              relation: "SUPPORTS" as const,
              support: "DIRECT" as const
            }))
          })
        ]
      })
    );

    expect(projection.interpretations[0]).toMatchObject({
      status: "PARTIAL",
      support: "LIMITED",
      meaning: "The user and Yuvi are romantic partners."
    });
    expect(projection.correctionAudits).toEqual([]);
  });

  it("does not auto-promote natural-language correction wording into P8-1D authority", () => {
    const projection = reconstructed(
      reconstruct({
        longTerm: retrieval([
          memoryEvent({
            id: "preference-base",
            content: "The user prefers concise responses.",
            assertionSource: "user"
          })
        ]),
        recentConversation: {
          messages: [
            {
              messageReference: "recent-natural-language-correction",
              role: "user",
              content: "No, that's wrong. From now on I prefer very long answers.",
              scopeReference: SCOPE
            }
          ],
          maxMessages: 1,
          maxCharacters: 200
        },
        candidates: [
          candidate("preference-ref", {
            domain: "COMMUNICATION_PREFERENCE",
            meaning: "The user prefers concise responses.",
            links: [
              { evidenceReference: "preference-base", relation: "SUPPORTS", support: "DIRECT" }
            ]
          })
        ]
      })
    );

    expect(projection.interpretations[0]).toMatchObject({
      status: "KNOWN",
      meaning: "The user prefers concise responses."
    });
    expect(projection.correctionAudits).toEqual([]);
    expect(projection.correctionProvenance).toEqual([]);
  });

  it("fails closed when Memory evidence escapes the authorized scope", () => {
    expect(() =>
      reconstruct({
        longTerm: retrieval([memoryEvent({ scope: "scope-other" })])
      })
    ).toThrow("memory evidence scope is not authorized");
  });

  it.each([
    [
      "character instance",
      correction({ address: { ...ADDRESS, characterInstanceId: "other-character" } })
    ],
    ["persona profile", correction({ address: { ...ADDRESS, personaProfileId: "other-persona" } })],
    ["subject scope", correction({ address: { ...ADDRESS, subjectScopeId: "other-subject" } })],
    ["semantic scope", correction({ scopeReference: { reference: "scope-other" } })]
  ])("fails closed on correction %s leakage", (_label, foreignCorrection) => {
    expect(() => reconstruct({ store: correctionStore([foreignCorrection]) })).toThrow(/not authorized/);
  });

  it.each(["UNAVAILABLE", "ERROR"] as const)(
    "never resurrects uncorrected truth when correction storage is %s",
    (status) => {
      const outcome = reconstruct({ store: { status } });

      expect(outcome.status).toBe(status);
      expect(outcome).not.toHaveProperty("projection");
    }
  );

  it("rejects malformed or backend-decorated durable records instead of accepting partial authority", () => {
    const valid = createP8CorrectionRecord(correction());

    expect(() =>
      parseP8CorrectionRecord({ ...valid, recordVersion: "p8-1e.future" })
    ).toThrow("Unknown P8 correction record version");
    expect(() => parseP8CorrectionRecord({ ...valid, rowId: "postgres-row-42" })).toThrow(
      /unknown field/i
    );
    expect(() => parseP8CorrectionRecord({ ...valid, projection: { status: "KNOWN" } })).toThrow(
      /unknown field/i
    );
    expect(() =>
      parseP8CorrectionRecord({
        ...valid,
        provenance: { ...valid.provenance, source: "MEMORY_CORRECTION_EVENT" }
      })
    ).toThrow("does not have explicit user authority");
  });

  it("rejects non-explicit correction authority even when supplied directly to reconstruction", () => {
    const forged = {
      ...correction(),
      provenance: {
        source: "MEMORY_CORRECTION_EVENT",
        reference: "memory-kind-correction"
      }
    } as unknown as P8ExplicitCorrection;

    expect(() => reconstruct({ store: correctionStore([forged]) })).toThrow(
      "requires explicit user correction authority"
    );
  });

  it("does not use correction timestamps or row order as semantic precedence", () => {
    const oldCorrection = correction({
      correctionReference: "correction-old",
      replacementMeaning: "Older explicit meaning.",
      provenanceReference: "source-old",
      suppliedAt: "2020-01-01T00:00:00.000Z"
    });
    const newCorrection = correction({
      correctionReference: "correction-new",
      replacementMeaning: "Newer explicit meaning.",
      provenanceReference: "source-new",
      suppliedAt: "2030-01-01T00:00:00.000Z"
    });

    const forward = reconstructed(
      reconstruct({ store: correctionStore([oldCorrection, newCorrection]) })
    );
    const reversed = reconstructed(
      reconstruct({ store: correctionStore([newCorrection, oldCorrection]) })
    );

    expect(forward).toEqual(reversed);
    expect(forward.interpretations[0]?.status).toBe("CONFLICTING");
    expect(forward.interpretations[0]).not.toHaveProperty("meaning");
    expect(forward.supersededReferences).toEqual([]);
  });

  it("keeps authority behavior invariant across equivalent Memory backend replacements", () => {
    const backendA = reconstructed(
      reconstruct({
        longTerm: retrieval([
          memoryEvent({
            id: "backend-a-evidence",
            source: "mem0-a",
            sourceRecordId: "provider-row-a",
            recordedAt: "2024-01-01T00:00:00.000Z"
          })
        ]),
        candidates: [
          candidate("backend-invariant-ref", {
            meaning: "Equivalent authorized semantic meaning.",
            links: [
              { evidenceReference: "backend-a-evidence", relation: "SUPPORTS", support: "DIRECT" }
            ]
          })
        ]
      })
    );
    const backendB = reconstructed(
      reconstruct({
        longTerm: retrieval([
          memoryEvent({
            id: "backend-b-evidence",
            source: "replacement-memory",
            sourceRecordId: "provider-row-b",
            recordedAt: "2026-08-30T12:34:56.000Z"
          })
        ]),
        candidates: [
          candidate("backend-invariant-ref", {
            meaning: "Equivalent authorized semantic meaning.",
            links: [
              { evidenceReference: "backend-b-evidence", relation: "SUPPORTS", support: "DIRECT" }
            ]
          })
        ]
      })
    );

    expect(backendA.interpretations[0]).toMatchObject({
      status: "KNOWN",
      support: "DIRECT",
      meaning: "Equivalent authorized semantic meaning."
    });
    expect(backendB.interpretations[0]).toMatchObject({
      status: "KNOWN",
      support: "DIRECT",
      meaning: "Equivalent authorized semantic meaning."
    });
    expect({
      status: backendA.interpretations[0]?.status,
      support: backendA.interpretations[0]?.support,
      meaning: backendA.interpretations[0]?.meaning,
      accessStatus: backendA.longTermEvidence.accessStatus
    }).toEqual({
      status: backendB.interpretations[0]?.status,
      support: backendB.interpretations[0]?.support,
      meaning: backendB.interpretations[0]?.meaning,
      accessStatus: backendB.longTermEvidence.accessStatus
    });
  });

  it("projects semantic provenance without raw Memory/provider payloads", () => {
    const projection = reconstructed(
      reconstruct({
        longTerm: retrieval([
          memoryEvent({
            id: "privacy-evidence",
            content: "RAW_PRIVATE_MEMORY_PAYLOAD_SHOULD_NOT_PROJECT",
            source: "provider-internal-name",
            sourceRecordId: "provider-private-row-42",
            metadata: {
              backendDto: "provider-private-dto",
              databaseRowId: "postgres-row-42"
            }
          })
        ]),
        candidates: [
          candidate("privacy-ref", {
            meaning: "A minimized semantic interpretation.",
            links: [
              { evidenceReference: "privacy-evidence", relation: "SUPPORTS", support: "DIRECT" }
            ]
          })
        ]
      })
    );
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain("RAW_PRIVATE_MEMORY_PAYLOAD_SHOULD_NOT_PROJECT");
    expect(serialized).not.toContain("provider-internal-name");
    expect(serialized).not.toContain("provider-private-row-42");
    expect(serialized).not.toContain("provider-private-dto");
    expect(serialized).not.toContain("postgres-row-42");
    expect(projection.interpretations[0]?.meaning).toBe("A minimized semantic interpretation.");
  });

  it("does not grow scalar relationship, transient mood, Continuity, or channel-mode state", () => {
    const projection = reconstructed(
      reconstruct({
        candidates: [
          candidate("relationship-boundary-ref", {
            domain: "RELATIONSHIP_CONTEXT",
            meaning: "A qualitative relationship interpretation.",
            links: [
              { evidenceReference: "memory-p8-1f", relation: "SUPPORTS", support: "DIRECT" }
            ]
          })
        ]
      })
    );

    for (const forbidden of [
      "affinity",
      "trustScore",
      "intimacyScore",
      "relationshipLevel",
      "mood",
      "continuity",
      "openThreads",
      "channelMode"
    ]) {
      expect(projection).not.toHaveProperty(forbidden);
    }
    expect(projection.interpretations[0]).toMatchObject({
      domain: "RELATIONSHIP_CONTEXT",
      status: "KNOWN",
      meaning: "A qualitative relationship interpretation."
    });
  });
});
