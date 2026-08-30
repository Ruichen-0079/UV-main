import { describe, expect, it } from "vitest";
import {
  CHARACTER_ABI_2A_VERSION,
  NORMALIZED_COGNITION_RESULT_VERSION,
  createCharacterAbiContext,
  createCharacterProposal,
  createNormalizedCognitionResult,
  type CharacterAbiContext,
  type CharacterProposal,
  type NormalizedCognitionResult
} from "./index.js";

type SemanticEnvelope = Readonly<{
  context: CharacterAbiContext;
  cognitionResult?: NormalizedCognitionResult;
}>;

type AdapterWire = Readonly<{
  encode(input: SemanticEnvelope): unknown;
  decode(wire: unknown): SemanticEnvelope;
  parseProposal(wire: unknown): CharacterProposal;
}>;

type Fixture = Readonly<{
  name: string;
  envelope: SemanticEnvelope;
}>;

function envelope(
  contextInput: unknown,
  cognitionInput?: unknown
): SemanticEnvelope {
  const context = createCharacterAbiContext(contextInput);
  const cognitionResult =
    cognitionInput === undefined
      ? undefined
      : createNormalizedCognitionResult(cognitionInput);

  return Object.freeze({
    context,
    ...(cognitionResult === undefined ? {} : { cognitionResult })
  });
}

const FIXTURES: readonly Fixture[] = Object.freeze([
  Object.freeze({
    name: "grounded-partial-context",
    envelope: envelope({
      abiVersion: CHARACTER_ABI_2A_VERSION,
      sections: [
        {
          kind: "IDENTITY",
          state: "KNOWN",
          summary: "character.name: Yuvi",
          provenanceReferences: ["p8:authored:character-name"]
        },
        { kind: "PERSONA", state: "UNKNOWN" },
        {
          kind: "RELATIONSHIP_CONTEXT",
          state: "PARTIAL",
          summary: "Some grounded relationship meaning is available.",
          provenanceReferences: ["p8:evidence:relationship-1"]
        },
        { kind: "CONTINUITY", state: "EMPTY" }
      ]
    })
  }),
  Object.freeze({
    name: "conflicting-relationship",
    envelope: envelope({
      abiVersion: CHARACTER_ABI_2A_VERSION,
      sections: [
        {
          kind: "IDENTITY",
          state: "KNOWN",
          summary: "character.name: Yuvi"
        },
        {
          kind: "RELATIONSHIP_CONTEXT",
          state: "CONFLICTING",
          provenanceReferences: ["p8:correction:a", "p8:correction:b"]
        }
      ]
    })
  }),
  Object.freeze({
    name: "upstream-unavailable",
    envelope: envelope({
      abiVersion: CHARACTER_ABI_2A_VERSION,
      sections: [
        { kind: "IDENTITY", state: "UNAVAILABLE" },
        { kind: "PERSONA", state: "UNAVAILABLE" },
        { kind: "RELATIONSHIP_CONTEXT", state: "UNAVAILABLE" }
      ]
    })
  }),
  Object.freeze({
    name: "normalized-cognition-success",
    envelope: envelope(
      {
        abiVersion: CHARACTER_ABI_2A_VERSION,
        sections: [
          {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "character.name: Yuvi"
          },
          {
            kind: "CURRENT_SITUATION",
            state: "PARTIAL",
            summary: "A bounded current situation is available."
          }
        ]
      },
      {
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "SUCCESS",
        answer: "A normalized answer ready for character expression.",
        keyFacts: ["Fact one.", "Fact two."],
        evidence: [
          {
            reference: "evidence:1",
            statement: "Bounded evidence statement."
          }
        ],
        uncertainty: ["One detail remains uncertain."],
        caveats: ["Do not infer beyond normalized evidence."]
      }
    )
  }),
  Object.freeze({
    name: "normalized-cognition-partial",
    envelope: envelope(
      {
        abiVersion: CHARACTER_ABI_2A_VERSION,
        sections: [
          {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "character.name: Yuvi"
          }
        ]
      },
      {
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "PARTIAL",
        answer: "A bounded partial answer.",
        uncertainty: ["Additional verification would be required for certainty."]
      }
    )
  })
]);

const objectWireAdapter: AdapterWire = Object.freeze({
  encode(input) {
    return Object.freeze({
      wireVersion: "fixture-object-v1",
      semantic: input
    });
  },
  decode(wire) {
    const record = expectRecord(wire, "object adapter wire");
    expectExactKeys(record, ["wireVersion", "semantic"], "object adapter wire");
    if (record["wireVersion"] !== "fixture-object-v1") {
      throw new Error("object adapter wireVersion is invalid.");
    }
    return normalizeEnvelope(record["semantic"]);
  },
  parseProposal(wire) {
    const record = expectRecord(wire, "object proposal wire");
    expectExactKeys(record, ["wireVersion", "proposal"], "object proposal wire");
    if (record["wireVersion"] !== "fixture-object-proposal-v1") {
      throw new Error("object proposal wireVersion is invalid.");
    }
    return createCharacterProposal(record["proposal"]);
  }
});

const textWireAdapter: AdapterWire = Object.freeze({
  encode(input) {
    return `fixture-text-v1\n${JSON.stringify(input)}`;
  },
  decode(wire) {
    if (typeof wire !== "string" || !wire.startsWith("fixture-text-v1\n")) {
      throw new Error("text adapter wire is invalid.");
    }
    return normalizeEnvelope(JSON.parse(wire.slice("fixture-text-v1\n".length)) as unknown);
  },
  parseProposal(wire) {
    if (typeof wire !== "string" || !wire.startsWith("fixture-text-proposal-v1\n")) {
      throw new Error("text proposal wire is invalid.");
    }
    return createCharacterProposal(
      JSON.parse(wire.slice("fixture-text-proposal-v1\n".length)) as unknown
    );
  }
});

const ADAPTERS = [objectWireAdapter, textWireAdapter] as const;

function normalizeEnvelope(input: unknown): SemanticEnvelope {
  const record = expectRecord(input, "semantic envelope");
  expectExactKeys(record, ["context", "cognitionResult"], "semantic envelope");
  const context = createCharacterAbiContext(record["context"]);
  const cognitionResult =
    record["cognitionResult"] === undefined
      ? undefined
      : createNormalizedCognitionResult(record["cognitionResult"]);

  return Object.freeze({
    context,
    ...(cognitionResult === undefined ? {} : { cognitionResult })
  });
}

function objectProposalWire(proposal: unknown): unknown {
  return {
    wireVersion: "fixture-object-proposal-v1",
    proposal
  };
}

function textProposalWire(proposal: unknown): string {
  return `fixture-text-proposal-v1\n${JSON.stringify(proposal)}`;
}

function expectRecord(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function expectExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown field: ${unknown.sort().join(", ")}.`);
  }
}

describe("Character ABI 2C provider-neutral adapter fixtures", () => {
  it("runs the same semantic fixtures through replaceable wire adapters without meaning drift", () => {
    for (const fixture of FIXTURES) {
      for (const adapter of ADAPTERS) {
        const decoded = adapter.decode(adapter.encode(fixture.envelope));
        expect(decoded, fixture.name).toEqual(fixture.envelope);
      }
    }
  });

  it("allows wire syntax to differ while keeping the semantic envelope identical", () => {
    const fixture = FIXTURES[0];
    if (fixture === undefined) {
      throw new Error("expected at least one Character ABI fixture.");
    }

    const objectWire = objectWireAdapter.encode(fixture.envelope);
    const textWire = textWireAdapter.encode(fixture.envelope);

    expect(typeof objectWire).toBe("object");
    expect(typeof textWire).toBe("string");
    expect(objectWireAdapter.decode(objectWire)).toEqual(textWireAdapter.decode(textWire));
  });

  it("keeps adapter wrappers from becoming a source of Character ABI meaning", () => {
    const fixture = FIXTURES[0];
    if (fixture === undefined) {
      throw new Error("expected at least one Character ABI fixture.");
    }

    expect(() =>
      objectWireAdapter.decode({
        wireVersion: "fixture-object-v1",
        semantic: fixture.envelope,
        relationshipLevel: 9
      })
    ).toThrow(/unknown field: relationshipLevel/);

    expect(() =>
      normalizeEnvelope({
        context: fixture.envelope.context,
        provider: "local-model-provider"
      })
    ).toThrow(/unknown field: provider/);
  });

  it("fails closed when an adapter attempts to manufacture meaning for unknown or unavailable sections", () => {
    expect(() =>
      normalizeEnvelope({
        context: {
          abiVersion: CHARACTER_ABI_2A_VERSION,
          sections: [
            {
              kind: "RELATIONSHIP_CONTEXT",
              state: "UNKNOWN",
              summary: "Adapter-invented relationship certainty."
            }
          ]
        }
      })
    ).toThrow(/cannot invent a summary/);

    expect(() =>
      normalizeEnvelope({
        context: {
          abiVersion: CHARACTER_ABI_2A_VERSION,
          sections: [
            {
              kind: "IDENTITY",
              state: "UNAVAILABLE",
              summary: "Adapter fallback identity."
            }
          ]
        }
      })
    ).toThrow(/cannot invent a summary/);
  });

  it("fails closed on Runtime, provider, database, tool, and raw-reasoning leakage", () => {
    const forbiddenContextFields = [
      ["traceId", "runtime-trace"],
      ["sessionId", "runtime-session"],
      ["provider", "provider-name"],
      ["databaseRowId", 42],
      ["toolName", "browser.search"]
    ] as const;

    for (const [field, value] of forbiddenContextFields) {
      expect(() =>
        normalizeEnvelope({
          context: {
            abiVersion: CHARACTER_ABI_2A_VERSION,
            sections: [],
            [field]: value
          }
        })
      ).toThrow(/unknown field/);
    }

    expect(() =>
      normalizeEnvelope({
        context: {
          abiVersion: CHARACTER_ABI_2A_VERSION,
          sections: []
        },
        cognitionResult: {
          version: NORMALIZED_COGNITION_RESULT_VERSION,
          status: "SUCCESS",
          answer: "Safe answer.",
          rawChainOfThought: "must not cross the ABI"
        }
      })
    ).toThrow(/unknown field: rawChainOfThought/);
  });

  it("parses valid Character proposals consistently across replaceable adapters", () => {
    const proposals = [
      { disposition: "RESPOND", text: "A bounded response." },
      { disposition: "SILENCE" },
      { disposition: "TERMINATE" },
      {
        disposition: "NEED_COGNITION",
        focus: "Reliable external verification is required."
      }
    ] as const;

    for (const proposal of proposals) {
      expect(objectWireAdapter.parseProposal(objectProposalWire(proposal))).toEqual(proposal);
      expect(textWireAdapter.parseProposal(textProposalWire(proposal))).toEqual(proposal);
    }
  });

  it("rejects capability execution and adapter-specific output authority across all adapters", () => {
    const invalid = [
      {
        disposition: "REQUEST_CAPABILITY",
        capability: "shell"
      },
      {
        disposition: "NEED_COGNITION",
        focus: "Needs verification.",
        toolName: "browser.search"
      },
      {
        disposition: "RESPOND",
        text: "Answer.",
        provider: "model-a"
      }
    ] as const;

    for (const proposal of invalid) {
      expect(() => objectWireAdapter.parseProposal(objectProposalWire(proposal))).toThrow();
      expect(() => textWireAdapter.parseProposal(textProposalWire(proposal))).toThrow();
    }
  });

  it("does not let a model adapter mutate the authoritative semantic fixture", () => {
    const fixture = FIXTURES[0];
    if (fixture === undefined) {
      throw new Error("expected at least one Character ABI fixture.");
    }
    const firstSection = fixture.envelope.context.sections[0];
    if (firstSection === undefined) {
      throw new Error("expected a Character ABI section.");
    }

    expect(Object.isFrozen(fixture.envelope.context)).toBe(true);
    expect(Object.isFrozen(fixture.envelope.context.sections)).toBe(true);
    expect(Object.isFrozen(firstSection)).toBe(true);
    expect(() => {
      (firstSection as { summary?: string }).summary = "Adapter-mutated identity.";
    }).toThrow();
    expect(fixture.envelope.context.sections[0]?.summary).toBe("character.name: Yuvi");
  });

  it("keeps fixture semantics free of relationship scalars and transient orchestration state", () => {
    const serialized = JSON.stringify(FIXTURES);
    for (const forbidden of [
      "affinity",
      "trustScore",
      "intimacy",
      "relationshipLevel",
      "moodScore",
      "dependencyScore",
      "openThreads",
      "channelMode",
      "traceId",
      "sessionId"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
