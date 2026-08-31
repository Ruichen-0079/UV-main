import { describe, expect, it } from "vitest";
import {
  COGNITION_6G_VERSION,
  COGNITION_6H_VERSION,
  createCognitionCapabilityRequest
} from "./index.js";

const capabilities = {
  version: COGNITION_6G_VERSION,
  capabilities: [
    {
      capabilityRef: "capability://opaque/public-evidence",
      description: "Retrieve current public evidence relevant to the authorized question."
    },
    {
      capabilityRef: "capability://opaque/repository-read",
      description: "Read authorized repository evidence without modifying it."
    }
  ]
};

describe("Cognition 6H capability request", () => {
  it("accepts one semantic request for a capability in the current inventory", () => {
    const requestText =
      "Retrieve current public evidence about the claim and preserve uncertainty in the returned evidence.";
    const result = createCognitionCapabilityRequest(
      {
        version: COGNITION_6H_VERSION,
        kind: "REQUEST_CAPABILITY",
        capabilityRef: "capability://opaque/public-evidence",
        request: requestText
      },
      capabilities
    );

    expect(result).toEqual({
      version: COGNITION_6H_VERSION,
      kind: "REQUEST_CAPABILITY",
      capabilityRef: "capability://opaque/public-evidence",
      request: requestText
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.request).toBe(requestText);
  });

  it("rejects refs absent from the current inventory, including an empty inventory", () => {
    expect(() =>
      createCognitionCapabilityRequest(
        {
          version: COGNITION_6H_VERSION,
          kind: "REQUEST_CAPABILITY",
          capabilityRef: "capability://opaque/hidden",
          request: "Retrieve evidence."
        },
        capabilities
      )
    ).toThrow(/current capability inventory/);

    expect(() =>
      createCognitionCapabilityRequest(
        {
          version: COGNITION_6H_VERSION,
          kind: "REQUEST_CAPABILITY",
          capabilityRef: "capability://opaque/public-evidence",
          request: "Retrieve evidence."
        },
        { version: COGNITION_6G_VERSION, capabilities: [] }
      )
    ).toThrow(/current capability inventory/);
  });

  it("revalidates the 6G inventory instead of trusting a forged description set", () => {
    expect(() =>
      createCognitionCapabilityRequest(
        {
          version: COGNITION_6H_VERSION,
          kind: "REQUEST_CAPABILITY",
          capabilityRef: "opaque-ref",
          request: "Retrieve evidence."
        },
        {
          version: COGNITION_6G_VERSION,
          capabilities: [
            {
              capabilityRef: "opaque-ref",
              description: "Retrieve evidence.",
              toolName: "read_file"
            }
          ]
        }
      )
    ).toThrow(/unknown field/);
  });

  it("keeps MCP routing, schemas, concrete arguments, providers, and effect metadata outside the contract", () => {
    for (const extra of [
      { provider: "provider-a" },
      { model: "reasoning-model" },
      { serverName: "filesystem" },
      { toolName: "read_file" },
      { protocol: "mcp" },
      { method: "tools/call" },
      { effect: "READ_ONLY" },
      { arguments: { path: "README.md" } },
      { inputSchema: { type: "object" } }
    ]) {
      expect(() =>
        createCognitionCapabilityRequest(
          {
            version: COGNITION_6H_VERSION,
            kind: "REQUEST_CAPABILITY",
            capabilityRef: "capability://opaque/public-evidence",
            request: "Retrieve evidence.",
            ...extra
          },
          capabilities
        )
      ).toThrow(/unknown field/);
    }
  });

  it("fails closed on malformed version, kind, ref, and request bounds", () => {
    for (const invalid of [
      null,
      [],
      {
        version: "cognition-6g.v1",
        kind: "REQUEST_CAPABILITY",
        capabilityRef: "capability://opaque/public-evidence",
        request: "Retrieve evidence."
      },
      {
        version: COGNITION_6H_VERSION,
        kind: "CONTINUE_REASONING",
        capabilityRef: "capability://opaque/public-evidence",
        request: "Retrieve evidence."
      },
      {
        version: COGNITION_6H_VERSION,
        kind: "REQUEST_CAPABILITY",
        capabilityRef: "",
        request: "Retrieve evidence."
      },
      {
        version: COGNITION_6H_VERSION,
        kind: "REQUEST_CAPABILITY",
        capabilityRef: " capability://opaque/public-evidence ",
        request: "Retrieve evidence."
      },
      {
        version: COGNITION_6H_VERSION,
        kind: "REQUEST_CAPABILITY",
        capabilityRef: "capability://opaque/public-evidence",
        request: "   "
      },
      {
        version: COGNITION_6H_VERSION,
        kind: "REQUEST_CAPABILITY",
        capabilityRef: "capability://opaque/public-evidence",
        request: "x".repeat(4001)
      }
    ]) {
      expect(() => createCognitionCapabilityRequest(invalid, capabilities)).toThrow();
    }
  });

  it("does not rewrite semantic request text", () => {
    const requestText = "Find evidence.  Preserve source uncertainty and return only what is relevant.";
    const result = createCognitionCapabilityRequest(
      {
        version: COGNITION_6H_VERSION,
        kind: "REQUEST_CAPABILITY",
        capabilityRef: "capability://opaque/public-evidence",
        request: requestText
      },
      capabilities
    );

    expect(result.request).toBe(requestText);
  });
});
