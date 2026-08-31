export const RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION =
  "runtime-embodied-effect-fence-7h.v1" as const;

export type RuntimeEmbodiedEffectFenceDecision = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION;
  status: "CURRENT" | "STALE";
}>;

type RuntimeEmbodiedEffectFenceInput = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION;
  /** Runtime's current authoritative effect identity, or null when none is active. */
  currentEffectId: string | null;
  /** Originating effect identity captured by one asynchronous callback. */
  callbackEffectId: string;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  currentEffectId?: unknown;
  callbackEffectId?: unknown;
};

const OPAQUE_EFFECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/**
 * Decide whether one embodied-effect callback still belongs to the Runtime's
 * current effect identity.
 *
 * This is a pure stale-callback fence. It does not store the current effect,
 * cancel anything, admit execution, publish lifecycle events, render a device,
 * or invoke a callback. The composition boundary must supply the authoritative
 * current Runtime effect ID and must only commit callback side effects when the
 * decision is CURRENT.
 */
export function decideRuntimeEmbodiedEffectCallbackFence(
  input: unknown
): RuntimeEmbodiedEffectFenceDecision {
  const value = expectObject(input);
  assertAllowedKeys(value);

  if (value.version !== RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION) {
    throw new Error(
      `Runtime embodied effect fence version must be ${RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION}.`
    );
  }

  if (value.currentEffectId !== null && !isOpaqueEffectId(value.currentEffectId)) {
    throw new Error("Runtime currentEffectId must be null or a valid opaque effect ID.");
  }
  if (!isOpaqueEffectId(value.callbackEffectId)) {
    throw new Error("Runtime callbackEffectId must be a valid opaque effect ID.");
  }

  const normalized: RuntimeEmbodiedEffectFenceInput = Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
    currentEffectId: value.currentEffectId,
    callbackEffectId: value.callbackEffectId
  });

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
    status:
      normalized.currentEffectId !== null &&
      normalized.currentEffectId === normalized.callbackEffectId
        ? "CURRENT"
        : "STALE"
  });
}

function expectObject(input: unknown): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runtime embodied effect fence input must be an object.");
  }
  return input as UnknownObject;
}

function assertAllowedKeys(value: Record<string, unknown>): void {
  const allowed = new Set(["version", "currentEffectId", "callbackEffectId"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime embodied effect fence input contains unknown field: ${unknown.sort().join(", ")}.`
    );
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
