import {
  createCorrelatedEmbodiedBehavior,
  type CorrelatedEmbodiedBehavior
} from "@companion/protocol";

export const RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION =
  "runtime-embodied-effect-identity-7g.v1" as const;

export type RuntimeEmbodiedEffectIdAllocator = () => string;

export type RuntimeEmbodiedEffectIdentity = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION;
  /** Runtime-owned execution identity. This is not a causal or correlation reference. */
  effectId: string;
  /** Revalidated semantic behavior that remains non-executable by itself. */
  behavior: CorrelatedEmbodiedBehavior;
}>;

const OPAQUE_EFFECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/**
 * Allocate one Runtime-owned identity around an already-correlated 7B behavior.
 *
 * The semantic input is fully revalidated before allocation, so a Character,
 * Harness, Presentation, or typed caller cannot smuggle an effect ID or
 * execution/admission fields across the 7B boundary. The allocator is injected
 * by the Runtime composition boundary and is invoked exactly once only after
 * semantic validation succeeds.
 *
 * This seam creates identity only. It does not admit, publish, execute, cancel,
 * persist, choose a presentation device, or claim that an embodied effect
 * occurred. Runtime fencing/admission remain separate later atoms.
 */
export function allocateRuntimeEmbodiedEffectIdentity(
  input: unknown,
  allocateEffectId: RuntimeEmbodiedEffectIdAllocator
): RuntimeEmbodiedEffectIdentity {
  if (typeof allocateEffectId !== "function") {
    throw new Error("Runtime embodied effect ID allocator must be a function.");
  }

  // Canonicalize before invoking any caller-supplied allocator. This snapshots
  // the complete semantic request and keeps allocation side effects from
  // mutating the meaning that receives Runtime identity.
  const behavior = createCorrelatedEmbodiedBehavior(input);
  const effectId = allocateEffectId();

  if (!isOpaqueEffectId(effectId)) {
    throw new Error(
      "Runtime embodied effect ID must be an opaque reference of 1 to 200 characters."
    );
  }

  if (
    effectId === behavior.behavior.cause.reference ||
    effectId === behavior.sourceInstance.reference ||
    effectId === behavior.correlation.reference
  ) {
    throw new Error(
      "Runtime embodied effect ID must be distinct from cause, source-instance, and correlation references."
    );
  }

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_IDENTITY_7G_VERSION,
    effectId,
    behavior
  });
}

function isOpaqueEffectId(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length >= 1 &&
    input.length <= 200 &&
    OPAQUE_EFFECT_ID_PATTERN.test(input)
  );
}
