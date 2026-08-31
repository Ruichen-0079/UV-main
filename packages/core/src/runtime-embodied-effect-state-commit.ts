import {
  RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
  RUNTIME_EMBODIED_EFFECT_STATES,
  decideRuntimeEmbodiedEffectStateTransition,
  type RuntimeEmbodiedEffectState,
  type RuntimeEmbodiedEffectStateTransitionDecision
} from "./runtime-embodied-effect-state-transition.js";

export const RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION =
  "runtime-embodied-effect-state-commit-7o.v1" as const;

export type RuntimeEmbodiedEffectSnapshot = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION;
  effectId: string;
  state: RuntimeEmbodiedEffectState;
}>;

export type RuntimeEmbodiedEffectStateCommitDecision = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION;
  status: "SNAPSHOT_UPDATED" | "SNAPSHOT_UNCHANGED";
  snapshot: RuntimeEmbodiedEffectSnapshot;
  transition: RuntimeEmbodiedEffectStateTransitionDecision;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  snapshot?: unknown;
  report?: unknown;
  effectId?: unknown;
  state?: unknown;
};

const OPAQUE_EFFECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/**
 * Commit one accepted 7M transition into an immutable Runtime effect snapshot.
 *
 * The snapshot is the only current/admitted effect fact accepted by this seam;
 * currentEffectId and admittedEffectId are derived from it rather than supplied
 * separately by callers. A stale report therefore cannot redirect authority to
 * another effect. 7M remains the sole transition legality authority.
 *
 * This is an immutable state-commit primitive, not a store or manager. It does
 * not retain the returned snapshot, publish events, invoke Presentation, render,
 * cancel, persist, or create Memory/P8 truth.
 */
export function commitRuntimeEmbodiedEffectState(
  input: unknown
): RuntimeEmbodiedEffectStateCommitDecision {
  const value = expectObject(input, "Runtime embodied effect state commit input");
  assertAllowedKeys(value, ["version", "snapshot", "report"], "state commit input");

  if (value.version !== RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION) {
    throw new Error(
      `Runtime embodied effect state commit version must be ${RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION}.`
    );
  }

  const snapshot = normalizeSnapshot(value.snapshot);
  const transition = decideRuntimeEmbodiedEffectStateTransition({
    version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
    report: value.report,
    currentEffectId: snapshot.effectId,
    admittedEffectId: snapshot.effectId,
    currentState: snapshot.state
  });

  if (transition.status !== "TRANSITION_APPLIED") {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
      status: "SNAPSHOT_UNCHANGED",
      snapshot,
      transition
    });
  }

  if (transition.effectId !== snapshot.effectId || transition.previousState !== snapshot.state) {
    throw new Error("Runtime embodied effect transition does not match the current snapshot.");
  }

  const nextSnapshot = Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
    effectId: snapshot.effectId,
    state: transition.nextState
  });

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
    status: "SNAPSHOT_UPDATED",
    snapshot: nextSnapshot,
    transition
  });
}

function normalizeSnapshot(input: unknown): RuntimeEmbodiedEffectSnapshot {
  const value = expectObject(input, "Runtime embodied effect snapshot");
  assertAllowedKeys(value, ["version", "effectId", "state"], "effect snapshot");

  if (value.version !== RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION) {
    throw new Error(
      `Runtime embodied effect snapshot version must be ${RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION}.`
    );
  }
  if (!isOpaqueEffectId(value.effectId)) {
    throw new Error("Runtime embodied effect snapshot effectId must be a valid opaque effect ID.");
  }
  if (!isRuntimeEmbodiedEffectState(value.state)) {
    throw new Error("Runtime embodied effect snapshot state is invalid.");
  }

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
    effectId: value.effectId,
    state: value.state
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

function isOpaqueEffectId(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length >= 1 &&
    input.length <= 200 &&
    OPAQUE_EFFECT_ID_PATTERN.test(input)
  );
}

function isRuntimeEmbodiedEffectState(input: unknown): input is RuntimeEmbodiedEffectState {
  return (
    typeof input === "string" &&
    (RUNTIME_EMBODIED_EFFECT_STATES as readonly string[]).includes(input)
  );
}
