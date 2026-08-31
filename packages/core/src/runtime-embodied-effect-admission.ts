export const RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION =
  "runtime-embodied-effect-admission-7i.v1" as const;

export const RUNTIME_EMBODIED_EFFECT_ADMISSION_REJECTION_REASONS = ["POLICY_DENIED"] as const;

export type RuntimeEmbodiedEffectAdmissionRejectionReason =
  (typeof RUNTIME_EMBODIED_EFFECT_ADMISSION_REJECTION_REASONS)[number];

export type RuntimeEmbodiedEffectAdmissionDecision =
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION;
      effectId: string;
      status: "ADMITTED";
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION;
      effectId: string;
      status: "REJECTED";
      reason: RuntimeEmbodiedEffectAdmissionRejectionReason;
    }>;

type RuntimeEmbodiedEffectAdmissionInput = Readonly<{
  version: typeof RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION;
  /** Runtime-owned effect identity allocated by the 7G composition path. */
  effectId: string;
  /** Current Runtime policy verdict supplied by the composition boundary. */
  policyAllowsEmbodiedEffect: boolean;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  effectId?: unknown;
  policyAllowsEmbodiedEffect?: unknown;
};

const OPAQUE_EFFECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/**
 * Bind one Runtime policy verdict to one already-allocated embodied effect ID.
 *
 * Core deliberately receives no Character proposal, semantic behavior payload,
 * device capability, provider metadata, consent DTO, or presentation details.
 * Their authorities remain at the composition/policy boundaries. This pure
 * decision only applies the supplied Runtime veto and preserves the exact
 * effect identity so an admission result cannot be reused for another effect.
 *
 * It does not allocate identity, store current state, execute, cancel, publish,
 * persist, or render anything.
 */
export function admitRuntimeEmbodiedEffect(input: unknown): RuntimeEmbodiedEffectAdmissionDecision {
  const value = expectObject(input);
  assertAllowedKeys(value);

  if (value.version !== RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION) {
    throw new Error(
      `Runtime embodied effect admission version must be ${RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION}.`
    );
  }
  if (!isOpaqueEffectId(value.effectId)) {
    throw new Error("Runtime embodied effect admission effectId must be a valid opaque effect ID.");
  }
  if (typeof value.policyAllowsEmbodiedEffect !== "boolean") {
    throw new Error("Runtime policyAllowsEmbodiedEffect must be boolean.");
  }

  const normalized: RuntimeEmbodiedEffectAdmissionInput = Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
    effectId: value.effectId,
    policyAllowsEmbodiedEffect: value.policyAllowsEmbodiedEffect
  });

  if (!normalized.policyAllowsEmbodiedEffect) {
    return Object.freeze({
      version: RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
      effectId: normalized.effectId,
      status: "REJECTED",
      reason: "POLICY_DENIED"
    });
  }

  return Object.freeze({
    version: RUNTIME_EMBODIED_EFFECT_ADMISSION_7I_VERSION,
    effectId: normalized.effectId,
    status: "ADMITTED"
  });
}

function expectObject(input: unknown): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runtime embodied effect admission input must be an object.");
  }
  return input as UnknownObject;
}

function assertAllowedKeys(value: Record<string, unknown>): void {
  const allowed = new Set(["version", "effectId", "policyAllowsEmbodiedEffect"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime embodied effect admission input contains unknown field: ${unknown.sort().join(", ")}.`
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
