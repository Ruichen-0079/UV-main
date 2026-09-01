import { createEvent, type RuntimeEvent } from "@companion/protocol";
import {
  RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
  decideRuntimeEmbodiedEffectEvent,
  type RuntimeEmbodiedEffectLifecycleEventPayload
} from "./runtime-embodied-effect-event.js";
import {
  RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
  commitRuntimeEmbodiedEffectState,
  type RuntimeEmbodiedEffectSnapshot
} from "./runtime-embodied-effect-state-commit.js";
import type { RuntimeEmbodiedEffectStateTransitionDecision } from "./runtime-embodied-effect-state-transition.js";

export const RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION =
  "runtime-embodied-effect-runtime-event-7q.v1" as const;

export type RuntimeEmbodiedEffectRuntimeEvent = RuntimeEvent<
  "runtime.embodied.effect",
  RuntimeEmbodiedEffectLifecycleEventPayload
>;

export type RuntimeEmbodiedEffectRuntimeEventDecision =
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION;
      status: "EVENT_CONSTRUCTED";
      snapshot: RuntimeEmbodiedEffectSnapshot;
      transition: RuntimeEmbodiedEffectStateTransitionDecision;
      event: RuntimeEmbodiedEffectRuntimeEvent;
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION;
      status: "NO_EVENT";
      snapshot: RuntimeEmbodiedEffectSnapshot;
      transition: RuntimeEmbodiedEffectStateTransitionDecision;
    }>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  identity?: unknown;
  snapshot?: unknown;
  report?: unknown;
};

/**
 * Construct one canonical Runtime embodied-effect event only after the existing
 * 7O immutable commit primitive has accepted an authoritative state update.
 *
 * Snapshot authority is never reopened: callers supply only the 7O snapshot,
 * not separate current/admitted effect IDs. Stale, duplicate, or invalid reports
 * therefore stop at 7O as NO_EVENT. For an applied transition, 7N revalidates the
 * matching 7G identity and prepares the canonical payload, then the shared
 * protocol createEvent factory owns event ID/timestamp allocation.
 *
 * 7B turn/session/decision correlation remains semantic payload metadata and is
 * deliberately not promoted into RuntimeEvent.traceId. Until a later Runtime
 * composition boundary supplies a real execution trace, this seam keeps the
 * createEvent default self-trace (`traceId === id`). It does not accept caller-
 * supplied event metadata and does not publish to EventBus, retain state, invoke
 * Presentation, render, persist, or create Memory/P8 truth.
 */
export function constructRuntimeEmbodiedEffectRuntimeEvent(
  input: unknown
): RuntimeEmbodiedEffectRuntimeEventDecision {
  const value = expectObject(input);
  assertAllowedKeys(value);

  if (value.version !== RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION) {
    throw new Error(
      `Runtime embodied effect Runtime event version must be ${RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION}.`
    );
  }

  const committed = commitRuntimeEmbodiedEffectState({
    version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
    snapshot: value.snapshot,
    report: value.report
  });

  if (committed.status === "SNAPSHOT_UNCHANGED") {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION,
      status: "NO_EVENT",
      snapshot: committed.snapshot,
      transition: committed.transition
    });
  }

  if (committed.transition.status !== "TRANSITION_APPLIED") {
    throw new Error("Runtime embodied effect updated snapshot requires an applied transition.");
  }

  const eventDecision = decideRuntimeEmbodiedEffectEvent({
    version: RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
    identity: value.identity,
    report: value.report,
    currentEffectId: committed.snapshot.effectId,
    admittedEffectId: committed.snapshot.effectId,
    currentState: committed.transition.previousState
  });

  if (eventDecision.status !== "EVENT_READY") {
    throw new Error("Runtime embodied effect committed transition must produce a canonical event payload.");
  }

  const event = Object.freeze(
    createEvent("runtime.embodied.effect", eventDecision.payload)
  );

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION,
    status: "EVENT_CONSTRUCTED",
    snapshot: committed.snapshot,
    transition: committed.transition,
    event
  });
}

function expectObject(input: unknown): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runtime embodied effect Runtime event input must be an object.");
  }
  return input as UnknownObject;
}

function assertAllowedKeys(value: Record<string, unknown>): void {
  const allowed = new Set(["version", "identity", "snapshot", "report"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime embodied effect Runtime event input contains unknown field: ${unknown.sort().join(", ")}.`
    );
  }
}
