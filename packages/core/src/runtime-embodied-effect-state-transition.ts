import type { EmbodiedPresentationOutcomeKind } from "@companion/protocol";
import {
  RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION,
  decideRuntimeEmbodiedPresentationOutcomeAcceptance
} from "./runtime-embodied-presentation-outcome-acceptance.js";

export const RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION =
  "runtime-embodied-effect-state-transition-7m.v1" as const;

export const RUNTIME_EMBODIED_EFFECT_STATES = [
  "ADMITTED",
  "STARTED",
  "COMPLETED",
  "REJECTED",
  "FAILED",
  "INTERRUPTED"
] as const;

export type RuntimeEmbodiedEffectState = (typeof RUNTIME_EMBODIED_EFFECT_STATES)[number];

export const RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_REJECTION_REASONS = [
  "OBSERVATION_NOT_ACCEPTED",
  "INVALID_SEQUENCE"
] as const;

export type RuntimeEmbodiedEffectStateTransitionRejectionReason =
  (typeof RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_REJECTION_REASONS)[number];

export type RuntimeEmbodiedEffectStateTransitionDecision =
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION;
      effectId: string;
      status: "TRANSITION_APPLIED";
      previousState: RuntimeEmbodiedEffectState;
      nextState: RuntimeEmbodiedEffectState;
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION;
      effectId: string;
      status: "TRANSITION_NO_CHANGE";
      state: RuntimeEmbodiedEffectState;
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION;
      effectId: string;
      status: "TRANSITION_REJECTED";
      state: RuntimeEmbodiedEffectState;
      reason: RuntimeEmbodiedEffectStateTransitionRejectionReason;
    }>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  report?: unknown;
  currentEffectId?: unknown;
  admittedEffectId?: unknown;
  currentState?: unknown;
};

/**
 * Decide one authoritative Runtime embodied-effect state transition from a
 * Presentation observation that must first pass the 7L acceptance boundary.
 *
 * The state machine is intentionally small and monotonic:
 * - ADMITTED -> STARTED -> COMPLETED | FAILED | INTERRUPTED
 * - ADMITTED -> REJECTED | FAILED | INTERRUPTED
 * - exact duplicate observations are idempotent NO_CHANGE
 * - skipped, reversed, or contradictory transitions are rejected
 *
 * This remains a pure transition decision. It does not store the state, publish
 * a canonical event, invoke Presentation, cancel work, persist, or create
 * Memory/P8 truth. A later Runtime composition must commit an applied decision.
 */
export function decideRuntimeEmbodiedEffectStateTransition(
  input: unknown
): RuntimeEmbodiedEffectStateTransitionDecision {
  const value = expectObject(input);
  assertAllowedKeys(value);

  if (value.version !== RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION) {
    throw new Error(
      `Runtime embodied effect state transition version must be ${RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION}.`
    );
  }
  if (!isRuntimeEmbodiedEffectState(value.currentState)) {
    throw new Error("Runtime embodied effect currentState is invalid.");
  }

  const currentState = value.currentState;
  const acceptance = decideRuntimeEmbodiedPresentationOutcomeAcceptance({
    version: RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION,
    report: value.report,
    currentEffectId: value.currentEffectId,
    admittedEffectId: value.admittedEffectId
  });

  if (acceptance.status === "OBSERVATION_IGNORED") {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
      effectId: acceptance.effectId,
      status: "TRANSITION_REJECTED",
      state: currentState,
      reason: "OBSERVATION_NOT_ACCEPTED"
    });
  }

  const effectId = acceptance.report.effectId;
  const targetState = outcomeTargetState(acceptance.report.outcome);

  if (currentState === targetState) {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
      effectId,
      status: "TRANSITION_NO_CHANGE",
      state: currentState
    });
  }

  if (!isAllowedTransition(currentState, acceptance.report.outcome, targetState)) {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
      effectId,
      status: "TRANSITION_REJECTED",
      state: currentState,
      reason: "INVALID_SEQUENCE"
    });
  }

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_STATE_TRANSITION_7M_VERSION,
    effectId,
    status: "TRANSITION_APPLIED",
    previousState: currentState,
    nextState: targetState
  });
}

function outcomeTargetState(outcome: EmbodiedPresentationOutcomeKind): RuntimeEmbodiedEffectState {
  switch (outcome) {
    case "STARTED":
      return "STARTED";
    case "COMPLETED":
      return "COMPLETED";
    case "REJECTED":
      return "REJECTED";
    case "FAILED":
      return "FAILED";
    case "INTERRUPTED":
      return "INTERRUPTED";
  }
}

function isAllowedTransition(
  currentState: RuntimeEmbodiedEffectState,
  outcome: EmbodiedPresentationOutcomeKind,
  targetState: RuntimeEmbodiedEffectState
): boolean {
  if (currentState === "ADMITTED") {
    return (
      outcome === "STARTED" ||
      outcome === "REJECTED" ||
      outcome === "FAILED" ||
      outcome === "INTERRUPTED"
    );
  }
  if (currentState === "STARTED") {
    return targetState === "COMPLETED" || targetState === "FAILED" || targetState === "INTERRUPTED";
  }
  return false;
}

function isRuntimeEmbodiedEffectState(input: unknown): input is RuntimeEmbodiedEffectState {
  return (
    typeof input === "string" &&
    (RUNTIME_EMBODIED_EFFECT_STATES as readonly string[]).includes(input)
  );
}

function expectObject(input: unknown): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runtime embodied effect state transition input must be an object.");
  }
  return input as UnknownObject;
}

function assertAllowedKeys(value: Record<string, unknown>): void {
  const allowed = new Set([
    "version",
    "report",
    "currentEffectId",
    "admittedEffectId",
    "currentState"
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime embodied effect state transition input contains unknown field: ${unknown.sort().join(", ")}.`
    );
  }
}
