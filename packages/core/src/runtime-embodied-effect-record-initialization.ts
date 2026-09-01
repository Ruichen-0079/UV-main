import {
  RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION,
  allocateRuntimeEmbodiedEffectIdentity,
  type RuntimeEmbodiedEffectIdentity
} from "./runtime-embodied-effect-identity.js";
import {
  RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION,
  initializeRuntimeEmbodiedEffectSnapshot,
  type RuntimeEmbodiedEffectSnapshotInitializationDecision
} from "./runtime-embodied-effect-snapshot-initialization.js";
import type { RuntimeEmbodiedEffectSnapshot } from "./runtime-embodied-effect-state-commit.js";

export const RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION =
  "runtime-embodied-effect-record-initialization-7t.v1" as const;

export type RuntimeEmbodiedEffectRecord = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION;
  identity: RuntimeEmbodiedEffectIdentity;
  snapshot: RuntimeEmbodiedEffectSnapshot;
}>;

export type RuntimeEmbodiedEffectRecordInitializationDecision =
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION;
      status: "RECORD_INITIALIZED";
      record: RuntimeEmbodiedEffectRecord;
      initialization: Extract<
        RuntimeEmbodiedEffectSnapshotInitializationDecision,
        { status: "SNAPSHOT_INITIALIZED" }
      >;
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION;
      status: "RECORD_NOT_CREATED";
      effectId: string;
      initialization: Extract<
        RuntimeEmbodiedEffectSnapshotInitializationDecision,
        { status: "SNAPSHOT_NOT_CREATED" }
      >;
    }>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  identity?: unknown;
  policyAllowsEmbodiedEffect?: unknown;
  effectId?: unknown;
  behavior?: unknown;
};

/**
 * Bind one canonical 7G identity to its first authoritative 7S/7O snapshot.
 *
 * The supplied identity is fully revalidated by reusing the 7G allocator with
 * its own opaque effectId as the local allocation result. This preserves 7G as
 * the authority for behavior canonicalization, ID shape, and semantic-reference
 * distinctness without allocating a second identity.
 *
 * If 7S policy admission rejects the effect, no record is created. An admitted
 * record always binds one canonical identity to an ADMITTED snapshot with the
 * same effectId.
 *
 * This is only an immutable value-object initializer. It does not retain a
 * current record, advance lifecycle, publish, invoke Presentation, execute,
 * cancel, persist, or create Memory/P8 truth.
 */
export function initializeRuntimeEmbodiedEffectRecord(
  input: unknown
): RuntimeEmbodiedEffectRecordInitializationDecision {
  const value = expectObject(input, "Runtime embodied effect record initialization input");
  assertAllowedKeys(value, ["version", "identity", "policyAllowsEmbodiedEffect"], "record initialization input");

  if (value.version !== RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION) {
    throw new Error(
      `Runtime embodied effect record initialization version must be ${RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION}.`
    );
  }
  if (typeof value.policyAllowsEmbodiedEffect !== "boolean") {
    throw new Error("Runtime embodied effect record policyAllowsEmbodiedEffect must be boolean.");
  }

  const identityInput = expectObject(value.identity, "Runtime embodied effect identity");
  assertAllowedKeys(identityInput, ["version", "effectId", "behavior"], "effect identity");
  if (identityInput.version !== RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION) {
    throw new Error("Runtime embodied effect record requires the canonical 7G identity version.");
  }
  if (typeof identityInput.effectId !== "string") {
    throw new Error("Runtime embodied effect record identity effectId must be a string.");
  }

  const identity = allocateRuntimeEmbodiedEffectIdentity(
    identityInput.behavior,
    () => identityInput.effectId as string
  );

  const initialization = initializeRuntimeEmbodiedEffectSnapshot({
    version: RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION,
    effectId: identity.effectId,
    policyAllowsEmbodiedEffect: value.policyAllowsEmbodiedEffect
  });

  if (initialization.status === "SNAPSHOT_NOT_CREATED") {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
      status: "RECORD_NOT_CREATED",
      effectId: identity.effectId,
      initialization
    });
  }

  if (initialization.snapshot.effectId !== identity.effectId) {
    throw new Error("Runtime embodied effect record identity and snapshot effectId must match.");
  }

  const record: RuntimeEmbodiedEffectRecord = Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
    identity,
    snapshot: initialization.snapshot
  });

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
    status: "RECORD_INITIALIZED",
    record,
    initialization
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
