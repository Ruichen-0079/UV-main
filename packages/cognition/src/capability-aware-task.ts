import {
  createCognitionCapabilityDescriptions,
  createCognitionReasoningTask,
  type Cognition6AReasoningTask,
  type CognitionCapabilityDescriptionSet
} from "./index.js";

export const COGNITION_6U_VERSION = "cognition-6u.v1" as const;

export type CognitionCapabilityAwareReasoningTask = Readonly<{
  version: typeof COGNITION_6U_VERSION;
  task: Cognition6AReasoningTask;
  capabilities: CognitionCapabilityDescriptionSet;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  task?: unknown;
  capabilities?: unknown;
};

/**
 * Bind one validated initial 6A Cognition task to the current validated 6G
 * semantic capability descriptions without choosing a provider wire format.
 *
 * This is an input-semantic envelope only. It does not serialize capability
 * descriptions into model messages, request a capability, bind MCP tools,
 * execute anything, choose a provider/model, or own Runtime admission state.
 */
export function createCognitionCapabilityAwareReasoningTask(
  input: unknown
): CognitionCapabilityAwareReasoningTask {
  const value = expectObject(input, "Cognition 6U capability-aware reasoning task");
  assertAllowedKeys(
    value,
    ["version", "task", "capabilities"],
    "Cognition 6U capability-aware reasoning task"
  );
  if (value.version !== COGNITION_6U_VERSION) {
    throw new Error(`Cognition capability-aware task version must be ${COGNITION_6U_VERSION}.`);
  }

  const task = createCognitionReasoningTask(value.task);
  const capabilities = createCognitionCapabilityDescriptions(value.capabilities);

  return Object.freeze({
    version: COGNITION_6U_VERSION,
    task,
    capabilities
  });
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
