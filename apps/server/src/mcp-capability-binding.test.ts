import { describe, expect, it } from "vitest";
import { COGNITION_6H_VERSION } from "@companion/cognition";
import {
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
  bindServerMcpCapabilityRequest,
  createServerMcpCapabilityBindings
} from "./mcp-capability-binding.js";

function createRegistry() {
  return createServerMcpCapabilityBindings({
    version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
    capabilities: [
      {
        capabilityRef: "capability://opaque/repository-read",
        description: "Read one authorized repository text file without modifying it.",
        toolName: "read_text_file"
      }
    ]
  });
}

describe("Server 6K MCP capability binding", () => {
  it("projects only opaque refs and semantic descriptions toward Cognition", () => {
    const registry = createRegistry();

    expect(registry.descriptions).toEqual({
      version: "cognition-6g.v1",
      capabilities: [
        {
          capabilityRef: "capability://opaque/repository-read",
          description: "Read one authorized repository text file without modifying it."
        }
      ]
    });
    expect(JSON.stringify(registry.descriptions)).not.toContain("read_text_file");
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.bindings)).toBe(true);
  });

  it("binds a validated 6H request to the explicit allowlisted tool", () => {
    const bound = bindServerMcpCapabilityRequest(
      {
        version: COGNITION_6H_VERSION,
        kind: "REQUEST_CAPABILITY",
        capabilityRef: "capability://opaque/repository-read",
        request: "Read the authorized file needed to verify the claim."
      },
      createRegistry()
    );

    expect(bound).toEqual({
      version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
      toolName: "read_text_file",
      request: "Read the authorized file needed to verify the claim."
    });
    expect(Object.isFrozen(bound)).toBe(true);
  });

  it("rejects capability refs that are not in the static allowlist", () => {
    expect(() =>
      bindServerMcpCapabilityRequest(
        {
          version: COGNITION_6H_VERSION,
          kind: "REQUEST_CAPABILITY",
          capabilityRef: "capability://opaque/server-discovered-only",
          request: "Use the newly discovered server tool."
        },
        createRegistry()
      )
    ).toThrow(/current capability inventory/);
  });

  it("rejects concrete MCP routing or effect metadata inside allowlist entries", () => {
    for (const extra of [
      { serverName: "filesystem" },
      { protocol: "mcp" },
      { method: "tools/call" },
      { effect: "READ_ONLY" },
      { arguments: { path: "README.md" } },
      { inputSchema: { type: "object" } }
    ]) {
      expect(() =>
        createServerMcpCapabilityBindings({
          version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
          capabilities: [
            {
              capabilityRef: "capability://opaque/repository-read",
              description: "Read an authorized repository file.",
              toolName: "read_text_file",
              ...extra
            }
          ]
        })
      ).toThrow(/unknown field/);
    }
  });

  it("reuses 6G bounds and uniqueness instead of creating parallel semantic rules", () => {
    expect(() =>
      createServerMcpCapabilityBindings({
        version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
        capabilities: [
          {
            capabilityRef: "duplicate-ref",
            description: "First description.",
            toolName: "read_text_file"
          },
          {
            capabilityRef: "duplicate-ref",
            description: "Second description.",
            toolName: "another_read_tool"
          }
        ]
      })
    ).toThrow(/unique/);

    expect(() =>
      createServerMcpCapabilityBindings({
        version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
        capabilities: [
          {
            capabilityRef: "x".repeat(201),
            description: "Too long ref.",
            toolName: "read_text_file"
          }
        ]
      })
    ).toThrow(/200/);
  });

  it("does not require or consume MCP discovery output", () => {
    expect(() =>
      createServerMcpCapabilityBindings({
        version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
        capabilities: [],
        discoveredTools: [{ name: "surprise_write_tool" }]
      })
    ).toThrow(/unknown field/);
  });
});
