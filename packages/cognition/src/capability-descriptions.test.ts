import { describe, expect, it } from "vitest";
import {
  COGNITION_6G_VERSION,
  createCognitionCapabilityDescriptions
} from "./index.js";

describe("Cognition 6G capability descriptions", () => {
  it("accepts an explicitly empty current capability inventory", () => {
    const result = createCognitionCapabilityDescriptions({
      version: COGNITION_6G_VERSION,
      capabilities: []
    });

    expect(result).toEqual({
      version: COGNITION_6G_VERSION,
      capabilities: []
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
  });

  it("preserves bounded semantic descriptions and opaque refs in caller order", () => {
    const result = createCognitionCapabilityDescriptions({
      version: COGNITION_6G_VERSION,
      capabilities: [
        {
          capabilityRef: "capability://opaque/7",
          description: "Retrieve current public evidence relevant to the authorized question."
        },
        {
          capabilityRef: "runtime-capability-12",
          description: "Read an authorized repository snapshot and return relevant evidence."
        }
      ]
    });

    expect(result).toEqual({
      version: COGNITION_6G_VERSION,
      capabilities: [
        {
          capabilityRef: "capability://opaque/7",
          description: "Retrieve current public evidence relevant to the authorized question."
        },
        {
          capabilityRef: "runtime-capability-12",
          description: "Read an authorized repository snapshot and return relevant evidence."
        }
      ]
    });
    expect(Object.isFrozen(result.capabilities[0])).toBe(true);
    expect(Object.isFrozen(result.capabilities[1])).toBe(true);
  });

  it("keeps concrete routing, provider, protocol, and effect metadata outside the stable contract", () => {
    for (const extra of [
      { provider: "provider-a" },
      { model: "reasoning-model" },
      { serverName: "filesystem" },
      { toolName: "search" },
      { protocol: "mcp" },
      { effect: "READ_ONLY" },
      { inputSchema: { type: "object" } }
    ]) {
      expect(() =>
        createCognitionCapabilityDescriptions({
          version: COGNITION_6G_VERSION,
          capabilities: [],
          ...extra
        })
      ).toThrow(/unknown field/);
    }

    for (const extra of [
      { provider: "provider-a" },
      { serverName: "filesystem" },
      { toolName: "read_file" },
      { protocol: "mcp" },
      { effect: "READ_ONLY" },
      { arguments: { path: "README.md" } },
      { inputSchema: { type: "object" } }
    ]) {
      expect(() =>
        createCognitionCapabilityDescriptions({
          version: COGNITION_6G_VERSION,
          capabilities: [
            {
              capabilityRef: "opaque-ref",
              description: "Return authorized evidence.",
              ...extra
            }
          ]
        })
      ).toThrow(/unknown field/);
    }
  });

  it("rejects duplicate opaque refs and inventories beyond the fixed bound", () => {
    expect(() =>
      createCognitionCapabilityDescriptions({
        version: COGNITION_6G_VERSION,
        capabilities: [
          { capabilityRef: "same-ref", description: "First semantic capability." },
          { capabilityRef: "same-ref", description: "Second semantic capability." }
        ]
      })
    ).toThrow(/capabilityRef values must be unique/);

    expect(() =>
      createCognitionCapabilityDescriptions({
        version: COGNITION_6G_VERSION,
        capabilities: Array.from({ length: 33 }, (_, index) => ({
          capabilityRef: `cap-${index}`,
          description: "Bounded semantic capability."
        }))
      })
    ).toThrow(/must not exceed 32 entries/);
  });

  it("fails closed on malformed versions, refs, descriptions, sparse entries, and container shapes", () => {
    const sparseCapabilities = new Array(1);

    for (const invalid of [
      null,
      [],
      { version: "cognition-6f.v1", capabilities: [] },
      { version: COGNITION_6G_VERSION },
      { version: COGNITION_6G_VERSION, capabilities: {} },
      { version: COGNITION_6G_VERSION, capabilities: sparseCapabilities },
      {
        version: COGNITION_6G_VERSION,
        capabilities: [{ capabilityRef: "", description: "Valid description." }]
      },
      {
        version: COGNITION_6G_VERSION,
        capabilities: [{ capabilityRef: " surrounded ", description: "Valid description." }]
      },
      {
        version: COGNITION_6G_VERSION,
        capabilities: [{ capabilityRef: "x".repeat(201), description: "Valid description." }]
      },
      {
        version: COGNITION_6G_VERSION,
        capabilities: [{ capabilityRef: "opaque-ref", description: "   " }]
      },
      {
        version: COGNITION_6G_VERSION,
        capabilities: [{ capabilityRef: "opaque-ref", description: "x".repeat(1001) }]
      }
    ]) {
      expect(() => createCognitionCapabilityDescriptions(invalid)).toThrow();
    }
  });

  it("does not rewrite accepted semantic description text", () => {
    const description = "Read authorized evidence, then return only evidence relevant to the task.  Preserve uncertainty.";
    const result = createCognitionCapabilityDescriptions({
      version: COGNITION_6G_VERSION,
      capabilities: [{ capabilityRef: "opaque-ref", description }]
    });

    expect(result.capabilities[0]?.description).toBe(description);
  });
});
