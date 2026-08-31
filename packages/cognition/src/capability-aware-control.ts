import type { NormalizedCognitionResult } from "@companion/character-abi";
import type { ReasoningInput, ReasoningOutput } from "@companion/providers";
import {
  COGNITION_6H_VERSION,
  createCognitionCapabilityDescriptions,
  createCognitionCapabilityRequest,
  createCognitionFailureResult,
  normalizeCognitionReasoningOutput,
  type CognitionCapabilityDescriptionSet,
  type CognitionCapabilityRequest
} from "./index.js";
import { createCognitionCapabilityAwareReasoningInput } from "./capability-aware-task.js";

export const COGNITION_6W_V2_VERSION = "cognition-6w.v2" as const;
export const COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER =
  "YUVI_COGNITION_CAPABILITY_REQUEST_6W_V2" as const;

export type CognitionCapabilityAwareControlDisposition =
  | Readonly<{
      version: typeof COGNITION_6W_V2_VERSION;
      kind: "COMPLETE";
      result: NormalizedCognitionResult;
    }>
  | Readonly<{
      version: typeof COGNITION_6W_V2_VERSION;
      kind: "REQUEST_CAPABILITY";
      request: CognitionCapabilityRequest;
    }>;

/**
 * Add the backward-compatible one-round capability control wire to the existing
 * 6V input projection.
 *
 * Ordinary provider text remains the final-answer path. Only the reserved
 * marker followed by one strict 6H JSON request means REQUEST_CAPABILITY.
 * Concrete MCP/tool/server/path/schema/argument details never enter this wire.
 * CONTINUE_REASONING remains unavailable under the initial one-round contract.
 */
export function createCognitionCapabilityAwareControlReasoningInput(
  input: unknown
): ReasoningInput {
  const base = createCognitionCapabilityAwareReasoningInput(input);
  const inventory = extractInventoryFromSixVInput(input);
  const messages: ReasoningInput["messages"] = [
    ...base.messages,
    Object.freeze({
      role: "user",
      content: serializeControlProtocol(inventory)
    })
  ];
  Object.freeze(messages);
  return Object.freeze({ messages });
}

/**
 * Interpret one provider-normalized capability-aware response using the v2
 * compatible control wire.
 *
 * Normal text is normalized by the existing 6A result authority. A reserved
 * capability marker is revalidated through 6H against the current inventory.
 * Malformed/smuggled control frames fail closed to normalized ERROR without
 * exposing raw control text. Provider-boundary violations still throw.
 */
export function interpretCognitionCapabilityAwareControlReasoningOutput(
  input: unknown,
  capabilityDescriptions: unknown
): CognitionCapabilityAwareControlDisposition {
  const inventory = createCognitionCapabilityDescriptions(capabilityDescriptions);
  const output = expectReasoningOutput(input);
  if (output.reasoning !== "") {
    throw new Error(
      "Cognition capability-aware control output must be provider-normalized with an empty reasoning field."
    );
  }

  const finishReason = normalizeFinishReason(output.finishReason);
  if (finishReason === "content_filter" || finishReason === "tool_call" || finishReason === "unknown") {
    return completeDisposition(normalizeCognitionReasoningOutput(output));
  }

  if (typeof output.answer !== "string" || output.answer.trim().length === 0) {
    return errorDisposition();
  }

  if (finishReason === "length") {
    if (containsReservedMarker(output.answer)) {
      return errorDisposition();
    }
    return completeDisposition(normalizeCognitionReasoningOutput(output));
  }

  const parsedRequest = parseCapabilityRequestControlFrame(output.answer, inventory);
  if (parsedRequest.status === "ORDINARY_ANSWER") {
    return completeDisposition(normalizeCognitionReasoningOutput(output));
  }
  if (parsedRequest.status === "MALFORMED") {
    return errorDisposition();
  }

  return Object.freeze({
    version: COGNITION_6W_V2_VERSION,
    kind: "REQUEST_CAPABILITY",
    request: parsedRequest.request
  });
}

/** Runtime/Core failure adapter for the generic one-shot Cognition executor. */
export function createCognitionCapabilityAwareControlFailureDisposition(
  input: unknown
): CognitionCapabilityAwareControlDisposition {
  return completeDisposition(createCognitionFailureResult(input));
}

function extractInventoryFromSixVInput(input: unknown): CognitionCapabilityDescriptionSet {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Cognition 6W v2 input must be a 6U capability-aware task object.");
  }
  const value = input as Record<string, unknown>;
  return createCognitionCapabilityDescriptions(value["capabilities"]);
}

function serializeControlProtocol(inventory: CognitionCapabilityDescriptionSet): string {
  if (inventory.capabilities.length === 0) {
    return [
      "Cognition capability control protocol.",
      "No capability request is currently available. Return the final answer normally.",
      "Do not output CONTINUE_REASONING."
    ].join("\n");
  }

  return [
    "Cognition capability control protocol.",
    "Return the final answer normally unless exactly one currently listed capability is required first.",
    "If a capability is required, return only this two-line control frame with no Markdown or commentary:",
    COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER,
    `{"version":"${COGNITION_6H_VERSION}","kind":"REQUEST_CAPABILITY","capabilityRef":"<exact opaque reference from the current inventory>","request":"<semantic need only>"}`,
    "Do not invent concrete tools, servers, providers, paths, schemas, or arguments.",
    "Do not output CONTINUE_REASONING."
  ].join("\n");
}

type ControlParseResult =
  | Readonly<{ status: "ORDINARY_ANSWER" }>
  | Readonly<{ status: "MALFORMED" }>
  | Readonly<{ status: "REQUEST_CAPABILITY"; request: CognitionCapabilityRequest }>;

function parseCapabilityRequestControlFrame(
  answer: string,
  inventory: CognitionCapabilityDescriptionSet
): ControlParseResult {
  const trimmed = answer.trim();
  const markerIndex = trimmed.indexOf(COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER);
  if (markerIndex === -1) {
    return Object.freeze({ status: "ORDINARY_ANSWER" });
  }
  if (markerIndex !== 0) {
    return Object.freeze({ status: "MALFORMED" });
  }

  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) {
    return Object.freeze({ status: "MALFORMED" });
  }
  const markerLine = trimmed.slice(0, firstNewline).replace(/\r$/u, "");
  if (markerLine !== COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER) {
    return Object.freeze({ status: "MALFORMED" });
  }

  const payload = trimmed.slice(firstNewline + 1).trim();
  if (payload.length === 0) {
    return Object.freeze({ status: "MALFORMED" });
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    const request = createCognitionCapabilityRequest(parsed, inventory);
    return Object.freeze({
      status: "REQUEST_CAPABILITY",
      request
    });
  } catch {
    return Object.freeze({ status: "MALFORMED" });
  }
}

function containsReservedMarker(answer: string): boolean {
  return answer.includes(COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER);
}

function completeDisposition(
  result: NormalizedCognitionResult
): CognitionCapabilityAwareControlDisposition {
  return Object.freeze({
    version: COGNITION_6W_V2_VERSION,
    kind: "COMPLETE",
    result
  });
}

function errorDisposition(): CognitionCapabilityAwareControlDisposition {
  return createCognitionCapabilityAwareControlFailureDisposition({ status: "ERROR" });
}

function expectReasoningOutput(input: unknown): Record<string, unknown> & {
  reasoning?: unknown;
  answer?: unknown;
  finishReason?: unknown;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Cognition capability-aware control output must be an object.");
  }
  return input as Record<string, unknown> & {
    reasoning?: unknown;
    answer?: unknown;
    finishReason?: unknown;
  };
}

function normalizeFinishReason(input: unknown): NonNullable<ReasoningOutput["finishReason"]> {
  if (input === undefined) {
    return "stop";
  }
  if (
    input === "stop" ||
    input === "length" ||
    input === "tool_call" ||
    input === "content_filter" ||
    input === "unknown"
  ) {
    return input;
  }
  throw new Error("Cognition capability-aware control finishReason is invalid.");
}
