import {
  RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION,
  allocateRuntimeEmbodiedEffectIdentity,
  type RuntimeEmbodiedEffectIdentity
} from "./runtime-embodied-effect-identity.js";
import {
  RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
  type RuntimeEmbodiedEffectRecord
} from "./runtime-embodied-effect-record-initialization.js";
import {
  RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION,
  constructRuntimeEmbodiedEffectRuntimeEvent,
  type RuntimeEmbodiedEffectRuntimeEventDecision
} from "./runtime-embodied-effect-runtime-event.js";

export const RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION =
  "runtime-embodied-effect-record-advancement-7u.v1" as const;

export type RuntimeEmbodiedEffectRecordAdvancementDecision =
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION;
      status: "RECORD_ADVANCED";
      record: RuntimeEmbodiedEffectRecord;
      decision: Extract<RuntimeEmbodiedEffectRuntimeEventDecision, { status: "EVENT_CONSTRUCTED" }>;
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION;
      status: "RECORD_UNCHANGED";
      record: RuntimeEmbodiedEffectRecord;
      decision: Extract<RuntimeEmbodiedEffectRuntimeEventDecision, { status: "NO_EVENT" }>;
    }>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  record?: unknown;
  report?: unknown;
  identity?: unknown;
  snapshot?: unknown;
  effectId?: unknown;
  behavior?: unknown;
};

/**
 * Advance one immutable Runtime embodied-effect record with one Presentation
 * outcome report.
 *
 * 7G remains the sole identity canonicalization authority and 7Q remains the
 * sole snapshot/event-construction composition authority. This seam only binds
 * their results back into the 7T record shape so callers can thread the returned
 * record into a later callback without separately carrying current state.
 *
 * Duplicate, stale, or otherwise non-applicable reports therefore return a
 * canonical RECORD_UNCHANGED result. Applied transitions return RECORD_ADVANCED
 * plus the canonical 7Q RuntimeEvent decision, but this seam never publishes it.
 *
 * This is a pure immutable reducer. It does not retain active state, publish to
 * EventBus, invoke Presentation, execute/cancel, retry, persist, or create
 * Memory/P8 truth.
 */
export function advanceRuntimeEmbodiedEffectRecord(
  input: unknown
): RuntimeEmbodiedEffectRecordAdvancementDecision {
  const value = expectObject(input, "Runtime embodied effect record advancement input");
  assertAllowedKeys(value, ["version", "record", "report"], "record advancement input");

  if (value.version !== RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION) {
    throw new Error(
      `Runtime embodied effect record advancement version must be ${RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION}.`
    );
  }

  const recordInput = expectObject(value.record, "Runtime embodied effect record");
  assertAllowedKeys(recordInput, ["version", "identity", "snapshot"], "effect record");
  if (recordInput.version !== RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION) {
    throw new Error("Runtime embodied effect advancement requires the canonical 7T record version.");
  }

  const identity = canonicalizeIdentity(recordInput.identity);
  const decision = constructRuntimeEmbodiedEffectRuntimeEvent({
    version: RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION,
    identity,
    snapshot: recordInput.snapshot,
    report: value.report
  });

  if (decision.snapshot.effectId !== identity.effectId) {
    throw new Error("Runtime embodied effect record identity and snapshot effectId must match.");
  }

  const record: RuntimeEmbodiedEffectRecord = Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
    identity,
    snapshot: decision.snapshot
  });

  if (decision.status === "NO_EVENT") {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION,
      status: "RECORD_UNCHANGED",
      record,
      decision
    });
  }

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION,
    status: "RECORD_ADVANCED",
    record,
    decision
  });
}

function canonicalizeIdentity(input: unknown): RuntimeEmbodiedEffectIdentity {
  const value = expectObject(input, "Runtime embodied effect identity");
  assertAllowedKeys(value, ["version", "effectId", "behavior"], "effect identity");

  if (value.version !== RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION) {
    throw new Error("Runtime embodied effect record advancement requires the canonical 7G identity version.");
  }
  if (typeof value.effectId !== "string") {
    throw new Error("Runtime embodied effect record advancement identity effectId must be a string.");
  }

  return allocateRuntimeEmbodiedEffectIdentity(
    value.behavior,
    () => value.effectId as string
  );
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
