import type { EventBus } from "@companion/event-bus";
import {
  RuntimeEventSchema,
  createCorrelatedEmbodiedBehavior,
  type RuntimeEvent
} from "@companion/protocol";
import { RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION } from "./runtime-embodied-effect-event.js";
import { RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION } from "./runtime-embodied-effect-runtime-event.js";
import {
  RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
  RUNTIME_EMBODIED_EFFECT_STATES,
  type RuntimeEmbodiedEffectState
} from "./runtime-embodied-effect-state-transition.js";
import { RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION } from "./runtime-embodied-effect-state-commit.js";

export const RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION =
  "runtime-embodied-effect-event-publication-7r.v1" as const;

export type RuntimeEmbodiedEffectEventPublicationResult = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION;
  status: "EVENT_PUBLISHED" | "PUBLISH_SKIPPED";
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  decision?: unknown;
  status?: unknown;
  snapshot?: unknown;
  transition?: unknown;
  event?: unknown;
  effectId?: unknown;
  state?: unknown;
  previousState?: unknown;
  nextState?: unknown;
  payload?: unknown;
  behavior?: unknown;
};

/**
 * Publish exactly one already-constructed 7Q embodied RuntimeEvent.
 *
 * This adapter owns only the final EventBus side effect. It does not rerun
 * admission, lifecycle transition, state commit, event construction, or model /
 * Presentation logic. Before publishing it revalidates the cross-contract facts
 * that make the 7Q event safe: snapshot, applied transition, 7N payload, Runtime
 * event type, and correlation-derived traceId must all agree.
 *
 * NO_EVENT decisions always produce zero EventBus calls. EventBus failures
 * propagate and are never retried here. This seam does not retain snapshots,
 * persist, render, cancel, or create Memory/P8 truth.
 */
export async function publishRuntimeEmbodiedEffectEvent(
  input: unknown,
  eventBus: Pick<EventBus, "publish">
): Promise<RuntimeEmbodiedEffectEventPublicationResult> {
  if (typeof eventBus !== "object" || eventBus === null || typeof eventBus.publish !== "function") {
    throw new Error("Runtime embodied effect publication requires an EventBus publish boundary.");
  }

  const value = expectObject(input, "Runtime embodied effect publication input");
  assertAllowedKeys(value, ["version", "decision"], "publication input");
  if (value.version !== RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION) {
    throw new Error(
      `Runtime embodied effect publication version must be ${RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION}.`
    );
  }

  const decision = expectObject(value.decision, "Runtime embodied effect 7Q decision");
  if (decision.version !== RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION) {
    throw new Error("Runtime embodied effect publication requires the canonical 7Q decision version.");
  }

  if (decision.status === "NO_EVENT") {
    assertAllowedKeys(
      decision,
      ["version", "status", "snapshot", "transition"],
      "7Q NO_EVENT decision"
    );
    if (Object.prototype.hasOwnProperty.call(decision, "event")) {
      throw new Error("Runtime embodied effect NO_EVENT decision must not contain an event.");
    }
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
      status: "PUBLISH_SKIPPED"
    });
  }

  if (decision.status !== "EVENT_CONSTRUCTED") {
    throw new Error("Runtime embodied effect 7Q decision status is invalid.");
  }
  assertAllowedKeys(
    decision,
    ["version", "status", "snapshot", "transition", "event"],
    "7Q EVENT_CONSTRUCTED decision"
  );

  const snapshot = normalizeSnapshot(decision.snapshot);
  const transition = normalizeAppliedTransition(decision.transition);
  const parsedEvent = normalizeRuntimeEvent(decision.event);
  const payload = normalizeLifecyclePayload(parsedEvent.payload);

  if (
    transition.effectId !== snapshot.effectId ||
    transition.nextState !== snapshot.state ||
    payload.effectId !== snapshot.effectId ||
    payload.previousState !== transition.previousState ||
    payload.state !== transition.nextState
  ) {
    throw new Error("Runtime embodied effect publication facts are inconsistent.");
  }
  if (parsedEvent.traceId !== payload.behavior.correlation.reference) {
    throw new Error("Runtime embodied effect event traceId must equal the 7B correlation reference.");
  }

  const event = Object.freeze({
    ...parsedEvent,
    payload
  }) as RuntimeEvent<"runtime.embodied.effect", typeof payload>;

  await eventBus.publish(event);

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
    status: "EVENT_PUBLISHED"
  });
}

function normalizeSnapshot(input: unknown): Readonly<{ effectId: string; state: RuntimeEmbodiedEffectState }> {
  const value = expectObject(input, "Runtime embodied effect snapshot");
  assertAllowedKeys(value, ["version", "effectId", "state"], "effect snapshot");
  if (value.version !== RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION) {
    throw new Error("Runtime embodied effect publication snapshot version is invalid.");
  }
  if (!isOpaqueReference(value.effectId) || !isRuntimeState(value.state)) {
    throw new Error("Runtime embodied effect publication snapshot is invalid.");
  }
  return Object.freeze({ effectId: value.effectId, state: value.state });
}

function normalizeAppliedTransition(input: unknown): Readonly<{
  effectId: string;
  previousState: RuntimeEmbodiedEffectState;
  nextState: RuntimeEmbodiedEffectState;
}> {
  const value = expectObject(input, "Runtime embodied effect transition");
  assertAllowedKeys(
    value,
    ["version", "effectId", "status", "previousState", "nextState"],
    "applied transition"
  );
  if (
    value.version !== RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION ||
    value.status !== "TRANSITION_APPLIED" ||
    !isOpaqueReference(value.effectId) ||
    !isRuntimeState(value.previousState) ||
    !isRuntimeState(value.nextState)
  ) {
    throw new Error("Runtime embodied effect publication requires an applied transition.");
  }
  return Object.freeze({
    effectId: value.effectId,
    previousState: value.previousState,
    nextState: value.nextState
  });
}

function normalizeRuntimeEvent(input: unknown): RuntimeEvent<"runtime.embodied.effect", unknown> {
  const parsed = RuntimeEventSchema.parse(input);
  if (parsed.type !== "runtime.embodied.effect") {
    throw new Error("Runtime embodied effect publication requires runtime.embodied.effect event type.");
  }
  return parsed as RuntimeEvent<"runtime.embodied.effect", unknown>;
}

function normalizeLifecyclePayload(input: unknown): Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION;
  effectId: string;
  previousState: RuntimeEmbodiedEffectState;
  state: RuntimeEmbodiedEffectState;
  behavior: ReturnType<typeof createCorrelatedEmbodiedBehavior>;
}> {
  const value = expectObject(input, "Runtime embodied effect lifecycle payload");
  assertAllowedKeys(
    value,
    ["version", "effectId", "previousState", "state", "behavior"],
    "lifecycle payload"
  );
  if (value.version !== RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION) {
    throw new Error("Runtime embodied effect lifecycle payload version is invalid.");
  }
  if (
    !isOpaqueReference(value.effectId) ||
    !isRuntimeState(value.previousState) ||
    !isRuntimeState(value.state)
  ) {
    throw new Error("Runtime embodied effect lifecycle payload state is invalid.");
  }
  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
    effectId: value.effectId,
    previousState: value.previousState,
    state: value.state,
    behavior: createCorrelatedEmbodiedBehavior(value.behavior)
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

function isRuntimeState(input: unknown): input is RuntimeEmbodiedEffectState {
  return (
    typeof input === "string" &&
    (RUNTIME_EMBODIED_EFFECT_STATES as readonly string[]).includes(input)
  );
}

function isOpaqueReference(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length >= 1 &&
    input.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(input)
  );
}
