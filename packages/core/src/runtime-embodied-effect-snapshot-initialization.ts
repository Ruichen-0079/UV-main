import {
  RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
  admitRuntimeEmbodiedEffect,
  type RuntimeEmbodiedEffectAdmissionDecision
} from "./runtime-embodied-effect-admission.js";
import {
  RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
  type RuntimeEmbodiedEffectSnapshot
} from "./runtime-embodied-effect-state-commit.js";

export const RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION =
  "runtime-embodied-effect-snapshot-initialization-7s.v1" as const;

export type RuntimeEmbodiedEffectSnapshotInitializationDecision =
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION;
      status: "SNAPSHOT_INITIALIZED";
      admission: Extract<RuntimeEmbodiedEffectAdmissionDecision, { status: "ADMITTED" }>;
      snapshot: RuntimeEmbodiedEffectSnapshot;
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION;
      status: "SNAPSHOT_NOT_CREATED";
      admission: Extract<RuntimeEmbodiedEffectAdmissionDecision, { status: "REJECTED" }>;
    }>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  effectId?: unknown;
  policyAllowsEmbodiedEffect?: unknown;
};

/**
 * Initialize the first immutable Runtime embodied-effect snapshot from the
 * existing 7I admission authority.
 *
 * Only a 7I ADMITTED decision may create a 7O snapshot, and that snapshot starts
 * exactly at ADMITTED for the same Runtime-owned effect ID. A policy rejection
 * creates no snapshot at all.
 *
 * This seam does not allocate effect identity, retain current state, invoke
 * Presentation, publish events, execute/cancel, persist, or create Memory/P8
 * truth. The supplied effectId is expected to have been allocated by 7G, as
 * already required by the 7I contract.
 */
export function initializeRuntimeEmbodiedEffectSnapshot(
  input: unknown
): RuntimeEmbodiedEffectSnapshotInitializationDecision {
  const value = expectObject(input);
  assertAllowedKeys(value);

  if (value.version !== RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION) {
    throw new Error(
      `Runtime embodied effect snapshot initialization version must be ${RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION}.`
    );
  }

  const admission = admitRuntimeEmbodiedEffect({
    version: RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
    effectId: value.effectId,
    policyAllowsEmbodiedEffect: value.policyAllowsEmbodiedEffect
  });

  if (admission.status === "REJECTED") {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION,
      status: "SNAPSHOT_NOT_CREATED",
      admission
    });
  }

  const snapshot: RuntimeEmbodiedEffectSnapshot = Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
    effectId: admission.effectId,
    state: "ADMITTED"
  });

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION,
    status: "SNAPSHOT_INITIALIZED",
    admission,
    snapshot
  });
}

function expectObject(input: unknown): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runtime embodied effect snapshot initialization input must be an object.");
  }
  return input as UnknownObject;
}

function assertAllowedKeys(value: Record<string, unknown>): void {
  const allowed = new Set(["version", "effectId", "policyAllowsEmbodiedEffect"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime embodied effect snapshot initialization input contains unknown field: ${unknown.sort().join(", ")}.`
    );
  }
}
