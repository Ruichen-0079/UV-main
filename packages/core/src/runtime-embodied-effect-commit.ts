import {
  RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
  admitRuntimeEmbodiedEffect
} from "./runtime-embodied-effect-admission.js";
import {
  RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
  decideRuntimeEmbodiedEffectCallbackFence
} from "./runtime-embodied-effect-fence.js";

export const RUNTIME_EMBODIED_EFFECT_COMMIT_7J_VERSION =
  "runtime-embodied-effect-commit-7j.v1" as const;

export type RuntimeEmbodiedEffectCommitAuthorization = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_COMMIT_7J_VERSION;
  effectId: string;
  status: "COMMIT_AUTHORIZED" | "COMMIT_REJECTED";
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  effectId?: unknown;
  policyAllowsEmbodiedEffect?: unknown;
  currentEffectId?: unknown;
  callbackEffectId?: unknown;
};

/**
 * Decide whether one asynchronous embodied-effect callback may commit a side
 * effect at the current Runtime boundary.
 *
 * This pure composition deliberately reuses 7I admission and 7H stale-callback
 * fencing. Authorization requires all three identities to agree: the admitted
 * effect, the callback's originating effect, and Runtime's current effect.
 * A policy veto, stale callback, missing current effect, or cross-effect
 * admission reuse therefore collapses to COMMIT_REJECTED.
 *
 * No callback payload crosses this seam. It does not invoke callbacks, mutate
 * active state, cancel, publish lifecycle events, render a device, persist, or
 * claim that a side effect occurred.
 */
export function decideRuntimeEmbodiedEffectCommitAuthorization(
  input: unknown
): RuntimeEmbodiedEffectCommitAuthorization {
  const value = expectObject(input);
  assertAllowedKeys(value);

  if (value.version !== RUNTIME_EMBODIED_EFFECT_COMMIT_7J_VERSION) {
    throw new Error(
      `Runtime embodied effect commit version must be ${RUNTIME_EMBODIED_EFFECT_COMMIT_7J_VERSION}.`
    );
  }

  const admission = admitRuntimeEmbodiedEffect({
    version: RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
    effectId: value.effectId,
    policyAllowsEmbodiedEffect: value.policyAllowsEmbodiedEffect
  });
  const fence = decideRuntimeEmbodiedEffectCallbackFence({
    version: RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
    currentEffectId: value.currentEffectId,
    callbackEffectId: value.callbackEffectId
  });

  const authorized =
    admission.status === "ADMITTED" &&
    fence.status === "CURRENT" &&
    admission.effectId === value.callbackEffectId;

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_COMMIT_7J_VERSION,
    effectId: admission.effectId,
    status: authorized ? "COMMIT_AUTHORIZED" : "COMMIT_REJECTED"
  });
}

function expectObject(input: unknown): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runtime embodied effect commit input must be an object.");
  }
  return input as UnknownObject;
}

function assertAllowedKeys(value: Record<string, unknown>): void {
  const allowed = new Set([
    "version",
    "effectId",
    "policyAllowsEmbodiedEffect",
    "currentEffectId",
    "callbackEffectId"
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime embodied effect commit input contains unknown field: ${unknown.sort().join(", ")}.`
    );
  }
}
