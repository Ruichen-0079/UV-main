import { describe, expect, it } from "vitest";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  createDefaultP8IdentityAddress,
  type P8EvidenceAdapterInput,
  P8_1C_VERSION,
  adaptP8MemoryRetrievalOutcome,
  adaptP8RecentConversation,
  createP8EvidenceAdapterProjection,
  recentEvidenceReference,
  type P8RecentConversationMessageInput
} from "./index.js";

const SCOPE = { reference: "scope-user-a" } as const;

function memoryEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "memory-1",
    kind: "fact",
    content: "The user supplied a bounded fact.",
    source: "test-memory",
    sourceRecordId: "database-record-1",
    scope: SCOPE.reference,
    recordedAt: "2026-08-29T00:00:00.000Z",
    metadata: {},
    ...overrides
  };
}

function retrieval(
  status: MemoryRetrievalOutcome["status"],
  events: MemoryEvent[] = [],
  overrides: Partial<MemoryRetrievalOutcome> = {}
): MemoryRetrievalOutcome {
  return {
    status,
    events,
    source: "test-memory",
    limited: false,
    ...overrides
  };
}

function recentMessage(
  overrides: Partial<P8RecentConversationMessageInput> = {}
): P8RecentConversationMessageInput {
  return {
    messageReference: "message-1",
    role: "user",
    content: "The user said this in the current session.",
    scopeReference: SCOPE,
    suppliedAt: "2026-08-29T00:01:00.000Z",
    ...overrides
  };
}

function projection(overrides: Partial<P8EvidenceAdapterInput> = {}) {
  return createP8EvidenceAdapterProjection({
    address: createDefaultP8IdentityAddress(),
    authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
    expectedScopeReference: SCOPE,
    longTerm: retrieval("empty"),
    ...overrides
  });
}

function directCandidate(
  evidenceReference: string,
  meaning = "The user supplied this fact.",
  domain:
    | "BACKGROUND"
    | "COMMUNICATION_PREFERENCE"
    | "SHARED_HISTORY"
    | "RELATIONSHIP_CONTEXT" = "BACKGROUND"
) {
  return {
    domain,
    meaning,
    evidenceLinks: [
      { evidenceReference, relation: "SUPPORTS" as const, support: "DIRECT" as const }
    ]
  };
}

describe("P8-1C read-only evidence adapter", () => {
  it("accepts a legacy interpretation candidate without a target reference", () => {
    const result = projection({
      longTerm: retrieval("ok", [memoryEvent()]),
      interpretationCandidates: [directCandidate("memory-1")]
    });

    expect(result.interpretations).toHaveLength(1);
    expect(result.interpretations[0]?.interpretationVersion).toBe("p8-1b.v1");
    expect(result.interpretations[0]).not.toHaveProperty("interpretationReference");
  });

  it("uses the versioned compact projection without changing P8-1A identity semantics", () => {
    const result = projection({
      longTerm: retrieval("ok", [memoryEvent()])
    });

    expect(result.projectionVersion).toBe(P8_1C_VERSION);
    expect(result.identity.status).toBe("KNOWN");
    expect(result.persona.status).toBe("UNKNOWN");
    expect(result.longTermEvidence.status).toBe("UNKNOWN");
  });

  it.each([
    ["ok", "SUCCESS_WITH_EVIDENCE", "UNKNOWN"],
    ["empty", "SUCCESS_WITH_NO_RELEVANT_EVIDENCE", "EMPTY"],
    ["partial", "PARTIAL", "PARTIAL"],
    ["unavailable", "UNAVAILABLE", "UNAVAILABLE"],
    ["error", "ERROR", "ERROR"]
  ] as const)("preserves Memory retrieval state %s as %s/%s", (status, accessStatus, epistemic) => {
    const events = status === "ok" || status === "partial" ? [memoryEvent()] : [];
    const result = projection({ longTerm: retrieval(status, events) });

    expect(result.longTermEvidence.accessStatus).toBe(accessStatus);
    expect(result.longTermEvidence.status).toBe(epistemic);
  });

  it("rejects retrieval states whose event payload contradicts the Memory contract", () => {
    expect(() =>
      adaptP8MemoryRetrievalOutcome({
        outcome: retrieval("ok"),
        expectedScopeReference: SCOPE
      })
    ).toThrow("ok retrieval with no events");
    expect(() =>
      adaptP8MemoryRetrievalOutcome({
        outcome: retrieval("empty", [memoryEvent()]),
        expectedScopeReference: SCOPE
      })
    ).toThrow("empty retrieval with events");
    expect(() =>
      adaptP8MemoryRetrievalOutcome({
        outcome: retrieval("unavailable", [memoryEvent()]),
        expectedScopeReference: SCOPE
      })
    ).toThrow("unavailable retrieval with events");
    expect(() =>
      adaptP8MemoryRetrievalOutcome({
        outcome: retrieval("error", [memoryEvent()]),
        expectedScopeReference: SCOPE
      })
    ).toThrow("error retrieval with events");
  });

  it("maps explicit, verified, observed, weak, and assistant sources conservatively", () => {
    const user = adaptP8MemoryRetrievalOutcome({
      outcome: retrieval("ok", [
        memoryEvent({
          id: "user-verified",
          assertion: { source: "user", verification: "verified" }
        }),
        memoryEvent({
          id: "user-unverified",
          assertion: { source: "user", verification: "unverified" }
        }),
        memoryEvent({
          id: "system-verified",
          assertion: { source: "system", verification: "verified" }
        }),
        memoryEvent({
          id: "mixed",
          assertion: { source: "mixed", verification: "verified" }
        }),
        memoryEvent({
          id: "assistant",
          assertion: { source: "assistant", verification: "verified" }
        }),
        memoryEvent({ id: "observed", kind: "interaction" })
      ]) as MemoryRetrievalOutcome,
      expectedScopeReference: SCOPE
    });

    const byReference = new Map(
      user.outcome.evidence.map((evidence) => [evidence.evidenceReference, evidence])
    );
    expect(byReference.get("user-verified")).toMatchObject({
      sourceClass: "EXPLICIT_USER_ORIGINATED",
      support: "DIRECT"
    });
    expect(byReference.get("user-unverified")).toMatchObject({
      sourceClass: "EXPLICIT_USER_ORIGINATED",
      support: "LIMITED"
    });
    expect(byReference.get("system-verified")).toMatchObject({
      sourceClass: "VERIFIED_SUPPORTED",
      support: "DIRECT"
    });
    expect(byReference.get("mixed")).toMatchObject({
      sourceClass: "WEAK_INFERRED",
      support: "LIMITED"
    });
    expect(byReference.get("assistant")).toMatchObject({
      sourceClass: "ASSISTANT_MODEL_GENERATED",
      support: "NON_AUTHORITATIVE"
    });
    expect(byReference.get("observed")).toMatchObject({
      sourceClass: "OBSERVED_INTERACTION",
      support: "LIMITED"
    });
  });

  it("maps Atom 12 claim provenance without upgrading hearsay or inference", () => {
    const result = adaptP8MemoryRetrievalOutcome({
      outcome: retrieval("ok", [
        memoryEvent({
          id: "self-report",
          assertion: { source: "user", verification: "verified" },
          claim: {
            provenanceClass: "SELF_REPORT",
            assertor: { entityId: "person_ruichen", resolution: "resolved" },
            subject: { entityId: "person_ruichen", resolution: "resolved" }
          }
        }),
        memoryEvent({
          id: "hearsay",
          assertion: { source: "user", verification: "unverified" },
          claim: {
            provenanceClass: "EXTERNAL_CLAIM",
            assertor: { entityId: "person_xiaoming", resolution: "resolved" },
            subject: { entityId: "person_ruichen", resolution: "resolved" }
          }
        }),
        memoryEvent({
          id: "assistant-inference",
          assertion: { source: "assistant", verification: "unverified" },
          claim: {
            provenanceClass: "ASSISTANT_INFERENCE",
            assertor: { entityId: "assistant_yuvi", resolution: "resolved" },
            subject: { entityId: "person_ruichen", resolution: "resolved" }
          }
        })
      ]) as MemoryRetrievalOutcome,
      expectedScopeReference: SCOPE
    });
    const byReference = new Map(
      result.outcome.evidence.map((evidence) => [evidence.evidenceReference, evidence])
    );
    expect(byReference.get("self-report")).toMatchObject({
      sourceClass: "EXPLICIT_USER_ORIGINATED",
      support: "DIRECT"
    });
    expect(byReference.get("hearsay")).toMatchObject({
      sourceClass: "WEAK_INFERRED",
      support: "LIMITED"
    });
    expect(byReference.get("assistant-inference")).toMatchObject({
      sourceClass: "ASSISTANT_MODEL_GENERATED",
      support: "NON_AUTHORITATIVE"
    });
  });

  it("does not use confidence, rank, limit, or repetition as authority", () => {
    const event = memoryEvent({
      assertion: { source: "unknown", verification: "unknown" },
      confidence: 0.99
    });
    const result = projection({
      longTerm: retrieval("ok", [event], {
        limited: true,
        rawCount: 100,
        selectedCount: 1,
        limitReason: "ranked top result"
      }),
      interpretationCandidates: [directCandidate(event.id)]
    });

    expect(result.interpretations[0]).toMatchObject({
      status: "PARTIAL",
      support: "LIMITED"
    });
    expect(result.interpretations[0]?.meaning).toBe("The user supplied this fact.");
    expect(JSON.stringify(result)).not.toContain("0.99");
  });

  it("uses the best supplied event timestamp and never invents one", () => {
    const withFallback = projection({
      longTerm: retrieval("ok", [
        memoryEvent({
          occurredAt: null,
          observedAt: "2026-08-29T00:02:00.000Z",
          recordedAt: "2026-08-29T00:03:00.000Z"
        })
      ])
    });
    const withoutTime = projection({
      longTerm: retrieval("ok", [memoryEvent({ recordedAt: null })])
    });

    expect(withFallback.longTermEvidence.provenance[0]?.suppliedAt).toBe(
      "2026-08-29T00:02:00.000Z"
    );
    expect(withoutTime.longTermEvidence.provenance[0]).not.toHaveProperty("suppliedAt");
  });

  it("fails closed when long-term evidence is missing or outside the authorized scope", () => {
    expect(() =>
      projection({
        longTerm: retrieval("ok", [memoryEvent({ scope: null })])
      })
    ).toThrow("scope is not authorized");
    expect(() =>
      projection({
        longTerm: retrieval("ok", [memoryEvent({ scope: "scope-user-b" })])
      })
    ).toThrow("scope is not authorized");
  });

  it("keeps same-text evidence distinct by identity and scope provenance", () => {
    const result = projection({
      longTerm: retrieval("ok", [
        memoryEvent({ id: "same-text-a", content: "The same text." }),
        memoryEvent({ id: "same-text-b", content: "The same text." })
      ])
    });

    expect(result.longTermEvidence.evidenceCount).toBe(2);
    expect(result.longTermEvidence.provenance.map((item) => item.reference)).toEqual([
      "same-text-a",
      "same-text-b"
    ]);
    expect(
      result.longTermEvidence.provenance.every(
        (item) => item.scopeReference.reference === SCOPE.reference
      )
    ).toBe(true);
  });

  it("adapts bounded recent conversation separately, excluding only the current message identity", () => {
    const result = projection({
      recentConversation: {
        messages: [
          recentMessage({ messageReference: "current", content: "same text" }),
          recentMessage({ messageReference: "history-a", content: "same text" }),
          recentMessage({ messageReference: "history-b", content: "same text" })
        ],
        maxMessages: 2,
        maxCharacters: 100,
        currentMessageReference: "current"
      }
    });

    expect(result.recentConversation?.accessStatus).toBe("SUCCESS_WITH_EVIDENCE");
    expect(result.recentConversation?.evidenceCount).toBe(2);
    expect(result.recentConversation?.provenance.map((item) => item.reference)).toEqual([
      recentEvidenceReference("history-a"),
      recentEvidenceReference("history-b")
    ]);
  });

  it("does not deduplicate recent messages by text and enforces the supplied bounded window", () => {
    expect(() =>
      projection({
        recentConversation: {
          messages: [recentMessage(), recentMessage({ messageReference: "message-2" })],
          maxMessages: 1,
          maxCharacters: 200
        }
      })
    ).toThrow("maxMessages");
    expect(() =>
      projection({
        recentConversation: {
          messages: [recentMessage({ content: "12345" })],
          maxMessages: 1,
          maxCharacters: 4
        }
      })
    ).toThrow("maxCharacters");
  });

  it("fails closed when recent conversation crosses the authorized scope", () => {
    expect(() =>
      projection({
        recentConversation: {
          messages: [recentMessage({ scopeReference: { reference: "scope-user-b" } })],
          maxMessages: 1,
          maxCharacters: 200
        }
      })
    ).toThrow("recent conversation scope is not authorized");
  });

  it("maps recent user and assistant authority without turning conversation into long-term memory", () => {
    const adapted = adaptP8RecentConversation(
      {
        messages: [
          recentMessage({ messageReference: "user-message", role: "user" }),
          recentMessage({ messageReference: "assistant-message", role: "assistant" })
        ],
        maxMessages: 2,
        maxCharacters: 200
      },
      SCOPE
    );
    const adaptedByReference = new Map(
      adapted.outcome.evidence.map((evidence) => [evidence.evidenceReference, evidence])
    );

    expect(adaptedByReference.get(recentEvidenceReference("user-message"))).toMatchObject({
      sourceClass: "EXPLICIT_USER_ORIGINATED",
      support: "LIMITED"
    });
    expect(adaptedByReference.get(recentEvidenceReference("assistant-message"))).toMatchObject({
      sourceClass: "ASSISTANT_MODEL_GENERATED",
      support: "NON_AUTHORITATIVE"
    });

    const result = projection({
      recentConversation: {
        messages: [
          recentMessage({ messageReference: "user-message", role: "user" }),
          recentMessage({ messageReference: "assistant-message", role: "assistant" })
        ],
        maxMessages: 2,
        maxCharacters: 200
      }
    });

    const provenance = result.recentConversation?.provenance ?? [];
    expect(provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: recentEvidenceReference("user-message"),
          sourceClass: "EXPLICIT_USER_ORIGINATED"
        }),
        expect.objectContaining({
          reference: recentEvidenceReference("assistant-message"),
          sourceClass: "ASSISTANT_MODEL_GENERATED"
        })
      ])
    );
    expect(result.longTermEvidence.evidenceCount).toBe(0);
  });

  it("does not manufacture EMPTY merely because recent context was not supplied", () => {
    const result = projection();

    expect(result.recentConversation).toBeUndefined();
    expect(result.interpretations).toEqual([]);
  });

  it("represents a supplied empty recent query as EMPTY, distinct from absent context", () => {
    const result = projection({
      recentConversation: {
        messages: [],
        maxMessages: 2,
        maxCharacters: 200
      }
    });

    expect(result.recentConversation).toMatchObject({
      accessStatus: "SUCCESS_WITH_NO_RELEVANT_EVIDENCE",
      status: "EMPTY",
      evidenceCount: 0
    });
  });

  it("keeps a recent user question as evidence only until an explicit candidate is supplied", () => {
    const result = projection({
      recentConversation: {
        messages: [recentMessage({ content: "Are you annoyed with me?" })],
        maxMessages: 1,
        maxCharacters: 200
      }
    });

    expect(result.interpretations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("annoyed");
  });

  it("projects only candidate-linked meaning and provenance", () => {
    const linked = memoryEvent({
      id: "linked",
      assertion: { source: "user", verification: "verified" }
    });
    const unrelated = memoryEvent({
      id: "unrelated",
      content: "An unrelated authoritative statement.",
      assertion: { source: "user", verification: "verified" }
    });
    const result = projection({
      longTerm: retrieval("ok", [linked, unrelated]),
      interpretationCandidates: [directCandidate(linked.id, "The user supplied the linked fact.")]
    });

    expect(result.interpretations).toHaveLength(1);
    expect(result.interpretations[0]).toMatchObject({
      status: "KNOWN",
      meaning: "The user supplied the linked fact.",
      evidenceLinks: [{ evidenceReference: "linked", support: "DIRECT" }]
    });
    expect(result.interpretations[0]?.provenance.map((item) => item.reference)).toEqual(["linked"]);
    expect(JSON.stringify(result)).not.toContain("An unrelated authoritative statement.");
  });

  it("preserves partial retrieval and cannot upgrade it to KNOWN", () => {
    const event = memoryEvent({
      assertion: { source: "user", verification: "verified" }
    });
    const result = projection({
      longTerm: retrieval("partial", [event]),
      interpretationCandidates: [directCandidate(event.id)]
    });

    expect(result.longTermEvidence.status).toBe("PARTIAL");
    expect(result.interpretations[0]).toMatchObject({ status: "PARTIAL", support: "LIMITED" });
  });

  it("keeps assistant output non-authoritative even when repeated across both channels", () => {
    const assistantMemory = memoryEvent({
      id: "assistant-memory",
      assertion: { source: "assistant", verification: "verified" }
    });
    const assistantRecent = recentMessage({
      messageReference: "assistant-recent",
      role: "assistant"
    });
    const result = projection({
      longTerm: retrieval("ok", [assistantMemory]),
      recentConversation: {
        messages: [assistantRecent],
        maxMessages: 1,
        maxCharacters: 200
      },
      interpretationCandidates: [
        {
          domain: "RELATIONSHIP_CONTEXT",
          meaning: "The relationship has a stable property.",
          evidenceLinks: [
            { evidenceReference: assistantMemory.id, relation: "SUPPORTS", support: "DIRECT" },
            {
              evidenceReference: recentEvidenceReference(assistantRecent.messageReference),
              relation: "SUPPORTS",
              support: "DIRECT"
            }
          ]
        }
      ]
    });

    expect(result.interpretations[0]).toMatchObject({
      status: "UNKNOWN",
      support: "NON_AUTHORITATIVE"
    });
    expect(result.interpretations[0]?.meaning).toBeUndefined();
  });

  it("keeps Memory outage separate while preserving available recent context", () => {
    const result = projection({
      longTerm: retrieval("unavailable"),
      recentConversation: {
        messages: [recentMessage()],
        maxMessages: 1,
        maxCharacters: 200
      }
    });

    expect(result.longTermEvidence).toMatchObject({
      accessStatus: "UNAVAILABLE",
      status: "UNAVAILABLE",
      evidenceCount: 0
    });
    expect(result.recentConversation).toMatchObject({
      accessStatus: "SUCCESS_WITH_EVIDENCE",
      status: "UNKNOWN",
      evidenceCount: 1
    });
  });

  it("evaluates a candidate against the channel that supplied its linked evidence", () => {
    const recent = recentMessage({ messageReference: "recent-user" });
    const result = projection({
      longTerm: retrieval("unavailable"),
      recentConversation: {
        messages: [recent],
        maxMessages: 1,
        maxCharacters: 200
      },
      interpretationCandidates: [
        directCandidate(recentEvidenceReference(recent.messageReference), "A bounded current fact.")
      ]
    });

    expect(result.interpretations[0]).toMatchObject({
      status: "PARTIAL",
      support: "LIMITED",
      accessStatus: "SUCCESS_WITH_EVIDENCE"
    });
    expect(result.interpretations[0]?.evidenceLinks).toEqual([
      {
        evidenceReference: recentEvidenceReference(recent.messageReference),
        relation: "SUPPORTS",
        support: "LIMITED"
      }
    ]);
  });

  it("does not treat a raw recent relationship utterance as known meaning", () => {
    const recent = recentMessage({
      messageReference: "love-you",
      content: "I love you"
    });
    const result = projection({
      recentConversation: {
        messages: [recent],
        maxMessages: 1,
        maxCharacters: 200
      },
      interpretationCandidates: [
        directCandidate(
          recentEvidenceReference(recent.messageReference),
          "The relationship has a stable romantic property.",
          "RELATIONSHIP_CONTEXT"
        )
      ]
    });

    expect(result.interpretations[0]).toMatchObject({
      domain: "RELATIONSHIP_CONTEXT",
      status: "PARTIAL",
      support: "LIMITED"
    });
    expect(result.interpretations[0]?.status).not.toBe("KNOWN");
  });

  it("does not treat a raw recent relationship question as known meaning", () => {
    const recent = recentMessage({
      messageReference: "annoyed-question",
      content: "Are you annoyed with me?"
    });
    const result = projection({
      recentConversation: {
        messages: [recent],
        maxMessages: 1,
        maxCharacters: 200
      },
      interpretationCandidates: [
        directCandidate(
          recentEvidenceReference(recent.messageReference),
          "The current relationship has a stable conflict state.",
          "RELATIONSHIP_CONTEXT"
        )
      ]
    });

    expect(result.interpretations[0]).toMatchObject({
      domain: "RELATIONSHIP_CONTEXT",
      status: "PARTIAL",
      support: "LIMITED"
    });
    expect(result.interpretations[0]?.status).not.toBe("KNOWN");
  });

  it("remains deterministic and keeps distinct identity addresses isolated", () => {
    const input = {
      address: createDefaultP8IdentityAddress("subject-a"),
      authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
      expectedScopeReference: SCOPE,
      longTerm: retrieval("ok", [memoryEvent()])
    } satisfies P8EvidenceAdapterInput;
    const first = createP8EvidenceAdapterProjection(input);
    const second = createP8EvidenceAdapterProjection(input);
    const other = createP8EvidenceAdapterProjection({
      ...input,
      address: {
        characterInstanceId: "other-character-instance",
        personaProfileId: "other-persona-profile",
        subjectScopeId: "subject-a"
      }
    });

    expect(first).toEqual(second);
    expect(first).not.toEqual(other);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.longTermEvidence)).toBe(true);
  });

  it("does not expose raw Memory or conversation DTO fields in the compact projection", () => {
    const result = projection({
      longTerm: retrieval("ok", [
        memoryEvent({
          id: "opaque-event-reference",
          sourceRecordId: "raw-database-primary-key",
          metadata: { providerSecret: "must-not-project" },
          conversationId: "conversation-internal-id"
        })
      ]),
      recentConversation: {
        messages: [recentMessage({ messageReference: "opaque-message-reference" })],
        maxMessages: 1,
        maxCharacters: 200
      }
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("raw-database-primary-key");
    expect(serialized).not.toContain("providerSecret");
    expect(serialized).not.toContain("conversation-internal-id");
    expect(serialized).not.toContain("must-not-project");
    expect(serialized).not.toContain("events");
    expect(serialized).not.toContain("messages");
  });

  it("does not introduce relationship scalar fields or prompt/runtime dependencies", () => {
    const result = projection();
    const serialized = JSON.stringify(result);

    expect(serialized).not.toMatch(/affinity|trust|intimacy|relationshipLevel/i);
    expect(serialized).not.toMatch(/PromptBuilder|PromptSectionName|Runtime/i);
  });

  it("keeps the seven epistemic states distinct", () => {
    const states = ["KNOWN", "UNKNOWN", "CONFLICTING", "PARTIAL", "EMPTY", "UNAVAILABLE", "ERROR"];
    expect(new Set(states).size).toBe(7);
    expect(states).toEqual([
      "KNOWN",
      "UNKNOWN",
      "CONFLICTING",
      "PARTIAL",
      "EMPTY",
      "UNAVAILABLE",
      "ERROR"
    ]);
  });

  it("does not import a Memory provider, repository, retriever, or backend", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./adapter.ts", import.meta.url), "utf8")
    );

    expect(source).toContain('from "@companion/memory"');
    expect(source).not.toMatch(
      /MemoryProvider|MemoryService|MemoryRepository|Mem0|Postgres|retrieveRelevant/
    );
    expect(source).not.toMatch(/PromptBuilder|PromptSectionName|RuntimeOrchestrator/);
  });
});
