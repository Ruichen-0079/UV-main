import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  createDefaultP8IdentityAddress,
  reconstructP8Projection
} from "../../p8/src/index.js";
import type { P8ExplicitCorrection } from "../../p8/src/correction.js";
import type {
  P8ReconstructionInput,
  P8ReferencedInterpretationCandidate
} from "../../p8/src/reconstruction.js";
import {
  projectP8ReconstructionToCharacterAbi,
  P8_CHARACTER_ABI_PROJECTION_VERSION
} from "./p8-projection.js";

const ADDRESS = createDefaultP8IdentityAddress("subject-character-abi-2b");
const SCOPE = { reference: "scope-character-abi-2b" } as const;

type LongTermOutcome = P8ReconstructionInput["longTerm"];
type LongTermEvent = LongTermOutcome["events"][number];

function memoryEvent(
  overrides: {
    id?: string;
    content?: string;
    source?: string;
    sourceRecordId?: string;
    metadata?: Record<string, unknown>;
  } = {}
): LongTermEvent {
  return {
    id: overrides.id ?? "relationship-memory",
    kind: "fact",
    content: overrides.content ?? "The user supplied stable relationship evidence.",
    source: overrides.source ?? "backend-a",
    sourceRecordId: overrides.sourceRecordId ?? "backend-row-a",
    scope: SCOPE.reference,
    recordedAt: "2026-08-31T00:00:00.000Z",
    metadata: overrides.metadata ?? {},
    assertion: {
      source: "user",
      verification: "verified"
    }
  };
}

function retrieval(events: readonly LongTermEvent[]): LongTermOutcome {
  return {
    status: events.length === 0 ? "empty" : "ok",
    events: [...events],
    source: "character-abi-2b-test",
    limited: false
  };
}

function relationshipCandidate(
  meaning = "The relationship is familiar and grounded."
): P8ReferencedInterpretationCandidate {
  return {
    interpretationReference: "relationship-ref",
    candidate: {
      domain: "RELATIONSHIP_CONTEXT",
      meaning,
      evidenceLinks: [
        {
          evidenceReference: "relationship-memory",
          relation: "SUPPORTS",
          support: "DIRECT"
        }
      ]
    }
  };
}

function correction(
  correctionReference: string,
  replacementMeaning: string,
  supersedesCorrectionReference?: string
): P8ExplicitCorrection {
  return {
    correctionReference,
    address: ADDRESS,
    scopeReference: SCOPE,
    target: {
      kind: "INTERPRETATION",
      interpretationReference: "relationship-ref"
    },
    action: "REVISE",
    replacementMeaning,
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: `user:${correctionReference}`
    },
    ...(supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference })
  };
}

function reconstruct(
  overrides: {
    longTerm?: LongTermOutcome;
    recentConversation?: P8ReconstructionInput["recentConversation"];
    candidates?: readonly P8ReferencedInterpretationCandidate[];
    corrections?: readonly P8ExplicitCorrection[];
    correctionStoreStatus?: "UNAVAILABLE" | "ERROR";
  } = {}
) {
  const correctionStore =
    overrides.correctionStoreStatus !== undefined
      ? ({ status: overrides.correctionStoreStatus } as const)
      : overrides.corrections !== undefined && overrides.corrections.length > 0
        ? ({ status: "SUCCESS_WITH_CORRECTIONS", corrections: overrides.corrections } as const)
        : ({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] } as const);

  return reconstructP8Projection({
    address: ADDRESS,
    authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
    expectedScopeReference: SCOPE,
    longTerm: overrides.longTerm ?? retrieval([]),
    ...(overrides.recentConversation === undefined
      ? {}
      : { recentConversation: overrides.recentConversation }),
    ...(overrides.candidates === undefined
      ? {}
      : { referencedInterpretationCandidates: overrides.candidates }),
    correctionStore
  });
}

describe("Character ABI 2B P8 projection", () => {
  it("projects only P8-owned identity/persona meanings and preserves absence", () => {
    const context = projectP8ReconstructionToCharacterAbi(reconstruct());

    expect(P8_CHARACTER_ABI_PROJECTION_VERSION).toBe("character-abi-2b-p8.v1");
    expect(context.sections).toEqual([
      {
        kind: "IDENTITY",
        state: "KNOWN",
        summary: "character.name: Yuvi",
        provenanceReferences: ["p8:authored:p8-1a/default/character-name@p8-1a"]
      },
      {
        kind: "PERSONA",
        state: "UNKNOWN"
      }
    ]);
    expect(context.sections.some((section) => section.kind === "RELATIONSHIP_CONTEXT")).toBe(false);
  });

  it("projects grounded relationship meaning without leaking Memory backend details", () => {
    const event = memoryEvent({
      source: "secret-backend-name",
      sourceRecordId: "database-row-42",
      metadata: { providerPayload: "must-not-leak" }
    });
    const context = projectP8ReconstructionToCharacterAbi(
      reconstruct({
        longTerm: retrieval([event]),
        candidates: [relationshipCandidate()]
      })
    );
    const relationship = context.sections.find(
      (section) => section.kind === "RELATIONSHIP_CONTEXT"
    );

    expect(relationship).toEqual({
      kind: "RELATIONSHIP_CONTEXT",
      state: "KNOWN",
      summary: "The relationship is familiar and grounded.",
      provenanceReferences: [
        "p8:evidence:scope-character-abi-2b:relationship-memory"
      ]
    });
    expect(JSON.stringify(context)).not.toContain("secret-backend-name");
    expect(JSON.stringify(context)).not.toContain("database-row-42");
    expect(JSON.stringify(context)).not.toContain("providerPayload");
  });

  it("keeps Memory and recent-conversation channels out of the P8-owned ABI adapter", () => {
    const context = projectP8ReconstructionToCharacterAbi(
      reconstruct({
        longTerm: retrieval([memoryEvent()]),
        recentConversation: {
          messages: [
            {
              messageReference: "recent-user-1",
              role: "user",
              content: "A bounded recent utterance.",
              scopeReference: SCOPE
            }
          ],
          maxMessages: 1,
          maxCharacters: 100
        },
        candidates: [relationshipCandidate()]
      })
    );
    const kinds = context.sections.map((section) => section.kind);

    expect(kinds).toEqual(["IDENTITY", "PERSONA", "RELATIONSHIP_CONTEXT"]);
    expect(kinds).not.toContain("MEMORY_EVIDENCE");
    expect(kinds).not.toContain("RECENT_CONVERSATION");
  });

  it("projects explicit correction authority as current relationship meaning", () => {
    const context = projectP8ReconstructionToCharacterAbi(
      reconstruct({
        longTerm: retrieval([memoryEvent()]),
        candidates: [relationshipCandidate("Old relationship meaning.")],
        corrections: [correction("correction-current", "Explicit corrected relationship meaning.")]
      })
    );
    const relationship = context.sections.find(
      (section) => section.kind === "RELATIONSHIP_CONTEXT"
    );

    expect(relationship).toEqual({
      kind: "RELATIONSHIP_CONTEXT",
      state: "KNOWN",
      summary: "Explicit corrected relationship meaning.",
      provenanceReferences: ["p8:correction:correction-current"]
    });
  });

  it("preserves unresolved explicit correction conflict without selecting by order", () => {
    const first = correction("correction-a", "Meaning A.");
    const second = correction("correction-b", "Meaning B.");
    const left = projectP8ReconstructionToCharacterAbi(
      reconstruct({
        longTerm: retrieval([memoryEvent()]),
        candidates: [relationshipCandidate()],
        corrections: [first, second]
      })
    );
    const right = projectP8ReconstructionToCharacterAbi(
      reconstruct({
        longTerm: retrieval([memoryEvent()]),
        candidates: [relationshipCandidate()],
        corrections: [second, first]
      })
    );
    const relationship = left.sections.find(
      (section) => section.kind === "RELATIONSHIP_CONTEXT"
    );

    expect(left).toEqual(right);
    expect(relationship).toEqual({
      kind: "RELATIONSHIP_CONTEXT",
      state: "CONFLICTING",
      provenanceReferences: [
        "p8:correction:correction-a",
        "p8:correction:correction-b"
      ]
    });
  });

  it.each(["UNAVAILABLE", "ERROR"] as const)(
    "fails closed across every P8-owned ABI section when correction reconstruction is %s",
    (status) => {
      const context = projectP8ReconstructionToCharacterAbi(
        reconstruct({ correctionStoreStatus: status })
      );

      expect(context.sections).toEqual([
        { kind: "IDENTITY", state: status },
        { kind: "PERSONA", state: status },
        { kind: "RELATIONSHIP_CONTEXT", state: status }
      ]);
      expect(context.sections.every((section) => section.summary === undefined)).toBe(true);
    }
  );

  it("is invariant to Memory backend implementation details once P8 semantics are equivalent", () => {
    const fromBackendA = projectP8ReconstructionToCharacterAbi(
      reconstruct({
        longTerm: retrieval([
          memoryEvent({ source: "backend-a", sourceRecordId: "row-a", metadata: { a: 1 } })
        ]),
        candidates: [relationshipCandidate()]
      })
    );
    const fromBackendB = projectP8ReconstructionToCharacterAbi(
      reconstruct({
        longTerm: retrieval([
          memoryEvent({ source: "backend-b", sourceRecordId: "row-b", metadata: { b: 2 } })
        ]),
        candidates: [relationshipCandidate()]
      })
    );

    expect(fromBackendA).toEqual(fromBackendB);
  });
});
