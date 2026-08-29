import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  DEFAULT_CHARACTER_INSTANCE_ID,
  DEFAULT_PERSONA_PROFILE_ID,
  P8_EPISTEMIC_STATES,
  P8_PROJECTION_VERSION,
  createDefaultP8IdentityAddress,
  createP8Projection,
  type P8AuthoredInvariant
} from "./index.js";

const authoredInvariants: readonly P8AuthoredInvariant[] = [
  {
    key: "character.name",
    target: "identity",
    statement: "Yuvi",
    provenance: {
      source: "authored",
      reference: "test/identity/name",
      revision: "r1"
    }
  },
  {
    key: "identity.boundary",
    target: "identity",
    statement: "The character identity is authored and does not come from generated prose.",
    provenance: {
      source: "authored",
      reference: "test/identity/boundary",
      revision: "r1"
    }
  },
  {
    key: "persona.core-identity",
    target: "persona",
    statement: "The authored persona has a stable core identity.",
    provenance: {
      source: "authored",
      reference: "test/persona/core-identity",
      revision: "r1"
    }
  }
];

describe("P8-1A semantic identity projection", () => {
  it("reconstructs deterministically from the same authored input", () => {
    const input = {
      address: createDefaultP8IdentityAddress("subject-scope-1"),
      authoredInvariants
    };

    expect(createP8Projection(input)).toEqual(
      createP8Projection({
        ...input,
        authoredInvariants: [...authoredInvariants].reverse()
      })
    );
    expect(createP8Projection(input).projectionVersion).toBe(P8_PROJECTION_VERSION);
  });

  it("keeps the semantic contract independent of providers, models, and runtime state", () => {
    const projection = createP8Projection({
      address: createDefaultP8IdentityAddress(),
      authoredInvariants
    });
    const serialized = JSON.stringify(projection);

    expect(projection).not.toHaveProperty("provider");
    expect(projection).not.toHaveProperty("model");
    expect(projection).not.toHaveProperty("runtime");
    expect(serialized).not.toContain("PromptBuilder");
    expect(serialized).not.toContain("MemoryRepository");
  });

  it("projects only the tiny authored invariant surface and no style behavior", () => {
    const projection = createP8Projection({
      address: createDefaultP8IdentityAddress(),
      authoredInvariants
    });

    expect(projection.identity.invariants.map((invariant) => invariant.key)).toEqual([
      "character.name",
      "identity.boundary"
    ]);
    expect(projection.persona.status).toBe("KNOWN");
    expect(projection.persona.invariants.map((invariant) => invariant.key)).toEqual([
      "persona.core-identity"
    ]);
    expect(projection).not.toHaveProperty("characterStyle");
    expect(projection).not.toHaveProperty("relationshipContext");
    expect(JSON.stringify(projection)).not.toContain("warm");
    expect(JSON.stringify(projection)).not.toContain("1–3 sentences");
  });

  it("keeps distinct character instances and persona profiles isolated", () => {
    const first = createP8Projection({
      address: {
        characterInstanceId: "character-a",
        personaProfileId: "profile-a"
      },
      authoredInvariants
    });
    const second = createP8Projection({
      address: {
        characterInstanceId: "character-b",
        personaProfileId: "profile-b"
      },
      authoredInvariants
    });

    expect(first.address).not.toEqual(second.address);
    expect(first.address.characterInstanceId).toBe("character-a");
    expect(second.address.personaProfileId).toBe("profile-b");
  });

  it("keeps all epistemic states distinct for future evidence-backed phases", () => {
    expect(P8_EPISTEMIC_STATES).toHaveLength(7);
    expect(new Set(P8_EPISTEMIC_STATES).size).toBe(7);
    expect(P8_EPISTEMIC_STATES).toEqual([
      "KNOWN",
      "UNKNOWN",
      "CONFLICTING",
      "PARTIAL",
      "EMPTY",
      "UNAVAILABLE",
      "ERROR"
    ]);
  });

  it("does not expose relationship scalar authority", () => {
    const projection = createP8Projection({
      address: createDefaultP8IdentityAddress(),
      authoredInvariants
    });

    for (const field of [
      "affinity",
      "trust",
      "intimacy",
      "relationshipLevel",
      "moodMeter",
      "dependencyScore"
    ]) {
      expect(projection).not.toHaveProperty(field);
    }
  });

  it("keeps Memory, PromptBuilder, and recent behavior outside the projection boundary", () => {
    const projection = createP8Projection({
      address: createDefaultP8IdentityAddress(),
      authoredInvariants: DEFAULT_AUTHORED_INVARIANTS
    });

    expect(projection.persona.status).toBe("EMPTY");
    expect(projection).not.toHaveProperty("retrievedMemories");
    expect(projection).not.toHaveProperty("rankedMemories");
    expect(projection).not.toHaveProperty("recentConversation");
    expect(projection).not.toHaveProperty("prompt");
    expect(projection).not.toHaveProperty("sections");
  });

  it("is deeply immutable and accepts bounded authored provenance only", () => {
    const projection = createP8Projection({
      address: createDefaultP8IdentityAddress(),
      authoredInvariants
    });

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.address)).toBe(true);
    expect(Object.isFrozen(projection.identity.invariants)).toBe(true);
    expect(Object.isFrozen(projection.identity.invariants[0]?.provenance)).toBe(true);
    expect(() =>
      createP8Projection({
        address: createDefaultP8IdentityAddress(),
        authoredInvariants: [
          {
            ...authoredInvariants[0]!,
            provenance: { source: "authored", reference: "" }
          }
        ]
      })
    ).toThrow("provenance.reference");
  });

  it("provides one minimal default identity address without making it a singleton", () => {
    const address = createDefaultP8IdentityAddress();

    expect(address).toEqual({
      characterInstanceId: DEFAULT_CHARACTER_INSTANCE_ID,
      personaProfileId: DEFAULT_PERSONA_PROFILE_ID
    });
    expect(address.characterInstanceId).not.toBe(address.personaProfileId);
  });
});
