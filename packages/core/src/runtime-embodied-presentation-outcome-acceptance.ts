import {
  EmbodiedOpaqueReferenceSchema,
  createEmbodiedPresentationOutcomeReport,
  type EmbodiedPresentationOutcomeReport
} from "@companion/protocol";
import {
  RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
  decideRuntimeEmbodiedEffectCallbackFence
} from "./runtime-embodied-effect-fence.js";

export const RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION =
  "runtime-embodied-presentation-outcome-acceptance-7l.v1" as const;

export type RuntimeEmbodiedPresentationOutcomeAcceptanceDecision =
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION;
      status: "OBSERVATION_ACCEPTED";
      report: EmbodiedPresentationOutcomeReport;
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION;
      status: "OBSERVATION_IGNORED";
      effectId: string;
    }>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  report?: unknown;
  currentEffectId?: unknown;
  admittedEffectId?: unknown;
};

/**
 * Decide whether one non-authoritative 7K Presentation observation may cross
 * into the Runtime's authoritative effect-state boundary.
 *
 * Acceptance requires the report to belong to both the Runtime's current
 * effect and the effect that the composition boundary knows was admitted.
 * Currentness deliberately reuses the 7H stale-callback fence. The admission
 * input is an already-established Runtime fact, not a fresh policy verdict.
 *
 * Accepted output still contains only the original non-authoritative report.
 * This seam does not translate outcomes into Runtime lifecycle state, publish
 * events, invoke callbacks, render, persist, or create Memory/P8 truth.
 */
export function decideRuntimeEmbodiedPresentationOutcomeAcceptance(
  input: unknown
): RuntimeEmbodiedPresentationOutcomeAcceptanceDecision {
  const value = expectObject(input);
  assertAllowedKeys(value);

  if (value.version !== RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION) {
    throw new Error(
      `Runtime embodied Presentation outcome acceptance version must be ${RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION}.`
    );
  }

  const report = createEmbodiedPresentationOutcomeReport(value.report);
  const fence = decideRuntimeEmbodiedEffectCallbackFence({
    version: RUNTIME_EMBODIED_EFFECT_FENCE_7H_VERSION,
    currentEffectId: value.currentEffectId,
    callbackEffectId: report.effectId
  });
  const admittedEffectId = normalizeNullableEffectId(value.admittedEffectId, "admittedEffectId");

  if (
    fence.status === "CURRENT" &&
    admittedEffectId !== null &&
    admittedEffectId === report.effectId
  ) {
    return Object.freeze({
      version: RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION,
      status: "OBSERVATION_ACCEPTED",
      report
    });
  }

  return Object.freeze({
    version: RUNTIME_EMBODIED_PRESENTATION_OUTCOME_ACCEPTANCE_7L_VERSION,
    status: "OBSERVATION_IGNORED",
    effectId: report.effectId
  });
}

function expectObject(input: unknown): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Runtime embodied Presentation outcome acceptance input must be an object.");
  }
  return input as UnknownObject;
}

function assertAllowedKeys(value: Record<string, unknown>): void {
  const allowed = new Set(["version", "report", "currentEffectId", "admittedEffectId"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Runtime embodied Presentation outcome acceptance input contains unknown field: ${unknown.sort().join(", ")}.`
    );
  }
}

function normalizeNullableEffectId(input: unknown, field: string): string | null {
  if (input === null) return null;
  const parsed = EmbodiedOpaqueReferenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Runtime ${field} must be null or a valid opaque effect ID.`);
  }
  return parsed.data;
}
