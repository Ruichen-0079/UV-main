import {
  createCorrelatedEmbodiedBehavior,
  type CorrelatedEmbodiedBehavior
} from "@companion/protocol";
import {
  RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION,
  type RuntimeEmbodiedEffectIdentity
} from "./runtime-embodied-effect-identity.js";
import {
  RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
  decideRuntimeEmbodiedEffectStateTransition,
  type RuntimeEmbodiedEffectState
} from "./runtime-embodied-effect-state-transition.js";

export const RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION =
  "runtime-embodied-effect-event-7n.v1" as const;

export type RuntimeEmbodiedEffectLifecycleEventPayload = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION;
  effectId: string;
  previousState: RuntimeEmbodiedEffectState;
  state: RuntimeEmbodiedEffectState;
  behavior: CorrelatedEmbodiedBehavior;
}>;

export type RuntimeEmbodiedEffectEventDecision =
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION;
      status: "EVENT_READY";
      payload: RuntimeEmbodiedEffectLifecycleEventPayload;
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION;
      status: "NO_EVENT";
      effectId: string;
    }>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  identity?: unknown;
  report?: unknown;
  currentEffectId?: unknown;
  admittedEffectId?: unknown;
  currentState?: unknown;
  effectId?: unknown;
  behavior?: unknown;
};

const OPAQUE_EFFECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/**
 * Prepare one canonical Runtime embodied-effect lifecycle event payload from an
 * applied 7M transition while preserving the 7G semantic identity that caused
 * the effect.
 *
 * This is a publication decision only. EVENT_READY means a later Runtime/EventBus
 * composition may publish the frozen payload; it does not allocate an event ID,
 * timestamp, publish anything, mutate effect state, render, persist, or create
 * Memory/P8 truth. NO_EVENT is returned for rejected or idempotent transitions.
 *
 * The payload intentionally contains only Runtime effect identity, authoritative
 * lifecycle states, and the already-stable 7B correlated behavior. Device,
 * provider, renderer, MCP, callback payload, and transport fields stay outside
 * the canonical event semantic.
 */
export function decideRuntimeEmbodiedEffectEvent(
  input: unknown
): RuntimeEmbodiedEffectEventDecision {
  const value = expectObject(input, "Runtime embodied effect event input");
  assertAllowedKeys(value, [
    "version",
    "identity",
    "report",
    "currentEffectId",
    "admittedEffectId",
    "currentState"
  ]);

  if (value.version !== RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION) {
    throw new Error(
      `Runtime embodied effect event version must be ${RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION}.`
    );
  }

  const identity = normalizeIdentity(value.identity);
  const transition = decideRuntimeEmbodiedEffectStateTransition({
    version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
    report: value.report,
    currentEffectId: value.currentEffectId,
    admittedEffectId: value.admittedEffectId,
    currentState: value.currentState
  });

  if (transition.effectId !== identity.effectId) {
    throw new Error("Runtime embodied effect event identity must match the transition effectId.");
  }

  if (transition.status !== "TRANSITION_APPLIED") {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
      status: "NO_EVENT",
      effectId: identity.effectId
    });
  }

  const payload = Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
    effectId: identity.effectId,
    previousState: transition.previousState,
    state: transition.nextState,
    behavior: identity.behavior
  });

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
    status: "EVENT_READY",
    payload
  });
}

function normalizeIdentity(input: unknown): RuntimeEmbodiedEffectIdentity {
  const value = expectObject(input, "Runtime embodied effect identity");
  assertAllowedKeys(value, ["version", "effectId", "behavior"]);

  if (value.version !== RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION) {
    throw new Error(
      `Runtime embodied effect identity version must be ${RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION}.`
    );
  }
  if (!isOpaqueEffectId(value.effectId)) {
    throw new Error("Runtime embodied effect identity effectId must be a valid opaque effect ID.");
  }

  const behavior = createCorrelatedEmbodiedBehavior(value.behavior);
  if (
    value.effectId === behavior.behavior.cause.reference ||
    value.effectId === behavior.sourceInstance.reference ||
    value.effectId === behavior.correlation.reference
  ) {
    throw new Error(
      "Runtime embodied effect identity must keep effectId distinct from semantic references."
    );
  }

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION,
    effectId: value.effectId,
    behavior
  });
}

function expectObject(input: unknown, field: string): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  return input as UnknownObject;
}

function assertAllowedKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Runtime embodied effect event input contains unknown field: ${unknown.sort().join(", ")}.`);
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
