import {
  createCognitionReasoningTask,
  type Cognition6AReasoningTask
} from "./index.js";
import {
  createCognitionCapabilityObservation,
  type CognitionCapabilityObservation
} from "./capability-observation.js";

export const COGNITION_6P_VERSION = "cognition-6p.v1" as const;

export type CognitionPostCapabilityReasoningTask = Readonly<{
  version: typeof COGNITION_6P_VERSION;
  task: Cognition6AReasoningTask;
  observation: CognitionCapabilityObservation;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  task?: unknown;
  observation?: unknown;
};

/**
 * Bind one validated 6A reasoning task to one validated post-capability 6N
 * observation without serializing either into provider messages.
 *
 * Runtime retains round/admission state. The observation remains evidence for
 * the next reasoning step rather than final Character-facing truth.
 */
export function createCognitionPostCapabilityReasoningTask(
  input: unknown
): CognitionPostCapabilityReasoningTask {
  const value = expectObject(input, "Cognition 6P post-capability reasoning task");
  assertAllowedKeys(
    value,
    ["version", "task", "observation"],
    "Cognition 6P post-capability reasoning task"
  );
  if (value.version !== COGNITION_6P_VERSION) {
    throw new Error(`Cognition post-capability task version must be ${COGNITION_6P_VERSION}.`);
  }

  const task = createCognitionReasoningTask(value.task);
  const observation = createCognitionCapabilityObservation(value.observation);

  return Object.freeze({
    version: COGNITION_6P_VERSION,
    task,
    observation
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
