import {
  COGNITION_6G_VERSION,
  createCognitionCapabilityDescriptions,
  createCognitionCapabilityRequest,
  type CognitionCapabilityDescriptionSet,
  type CognitionCapabilityRequest
} from "@companion/cognition";
import type { ServerMcpTool } from "./mcp-client.js";

export const SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION =
  "server-mcp-capability-bindings-6k.v1" as const;

export type ServerMcpCapabilityBinding = Readonly<{
  capabilityRef: string;
  toolName: string;
}>;

export type ServerMcpCapabilityBindings = Readonly<{
  version: typeof SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION;
  descriptions: CognitionCapabilityDescriptionSet;
  bindings: readonly ServerMcpCapabilityBinding[];
}>;

export type ServerMcpBoundCapabilityRequest = Readonly<{
  version: typeof SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION;
  toolName: string;
  request: string;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  capabilities?: unknown;
  capabilityRef?: unknown;
  description?: unknown;
  toolName?: unknown;
};

/**
 * Build the explicit server-side allowlist that binds stable opaque capability
 * refs to concrete MCP tool names.
 *
 * This registry is the only source of capability exposure. MCP `listTools()`
 * output must never be promoted into Cognition inventory automatically. The
 * Cognition-visible projection is revalidated through the 6G contract while
 * concrete tool names remain server infrastructure data.
 */
export function createServerMcpCapabilityBindings(input: unknown): ServerMcpCapabilityBindings {
  const value = expectObject(input, "Server MCP capability bindings");
  assertAllowedKeys(value, ["version", "capabilities"], "Server MCP capability bindings");
  if (value.version !== SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION) {
    throw new Error(
      `Server MCP capability bindings version must be ${SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION}.`
    );
  }
  if (!Array.isArray(value.capabilities)) {
    throw new Error("Server MCP capabilities must be an array.");
  }

  const semanticCapabilities: Array<{ capabilityRef: string; description: string }> = [];
  const bindings: ServerMcpCapabilityBinding[] = [];

  for (const [index, entry] of Array.from(value.capabilities).entries()) {
    const field = `Server MCP capability ${index}`;
    const capability = expectObject(entry, field);
    assertAllowedKeys(capability, ["capabilityRef", "description", "toolName"], field);

    semanticCapabilities.push({
      capabilityRef: requireString(capability.capabilityRef, `${field} capabilityRef`),
      description: requireString(capability.description, `${field} description`)
    });
    bindings.push(
      Object.freeze({
        capabilityRef: requireString(capability.capabilityRef, `${field} capabilityRef`),
        toolName: requireToolName(capability.toolName, `${field} toolName`)
      })
    );
  }

  const descriptions = createCognitionCapabilityDescriptions({
    version: COGNITION_6G_VERSION,
    capabilities: semanticCapabilities
  });
  Object.freeze(bindings);

  return Object.freeze({
    version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
    descriptions,
    bindings
  });
}

/**
 * Intersect the explicit 6K allowlist with the tools currently reported by an
 * MCP server.
 *
 * Discovery may only remove unavailable allowlisted capabilities. It can never
 * create a new capability, replace semantic descriptions, or promote an
 * unlisted server tool. Static ordering is preserved.
 */
export function createCurrentServerMcpCapabilityBindings(
  staticRegistry: ServerMcpCapabilityBindings,
  discoveredTools: readonly ServerMcpTool[]
): ServerMcpCapabilityBindings {
  const discoveredNames = new Set(discoveredTools.map((tool) => tool.name));
  const descriptionByRef = new Map(
    staticRegistry.descriptions.capabilities.map((capability) => [
      capability.capabilityRef,
      capability.description
    ])
  );

  const capabilities = staticRegistry.bindings.flatMap((binding) => {
    if (!discoveredNames.has(binding.toolName)) {
      return [];
    }
    const description = descriptionByRef.get(binding.capabilityRef);
    if (description === undefined) {
      throw new Error("Server MCP static binding is missing its semantic description.");
    }
    return [
      {
        capabilityRef: binding.capabilityRef,
        description,
        toolName: binding.toolName
      }
    ];
  });

  return createServerMcpCapabilityBindings({
    version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
    capabilities
  });
}

/**
 * Bind one already-proposed Cognition capability request to its explicit MCP
 * tool allowlist entry.
 *
 * The 6H request is revalidated against the registry's 6G projection before
 * lookup. No MCP discovery, call, arguments, retry, or Runtime admission occurs
 * here.
 */
export function bindServerMcpCapabilityRequest(
  input: unknown,
  registry: ServerMcpCapabilityBindings
): ServerMcpBoundCapabilityRequest {
  const request: CognitionCapabilityRequest = createCognitionCapabilityRequest(
    input,
    registry.descriptions
  );
  const binding = registry.bindings.find(
    (candidate) => candidate.capabilityRef === request.capabilityRef
  );
  if (binding === undefined) {
    throw new Error("Server MCP capability request has no explicit binding.");
  }

  return Object.freeze({
    version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
    toolName: binding.toolName,
    request: request.request
  });
}

function requireString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0 || input.trim() !== input) {
    throw new Error(`${field} must be a non-empty string without surrounding whitespace.`);
  }
  return input;
}

function requireToolName(input: unknown, field: string): string {
  const value = requireString(input, field);
  if (value.length > 200) {
    throw new Error(`${field} must not exceed 200 characters.`);
  }
  return value;
}

function expectObject(input: unknown, field: string): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  return input as UnknownObject;
}

function assertAllowedKeys(
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
