import { z } from "zod";
import { EmbodiedOpaqueReferenceSchema } from "./embodied-behavior.js";

export const EMBODIED_PRESENTATION_OUTCOME_7K_VERSION =
  "embodied-presentation-outcome-7k.v1" as const;

/** Device-neutral observations only; these are never Runtime lifecycle states. */
export const EmbodiedPresentationOutcomeKindSchema = z.enum([
  "STARTED",
  "COMPLETED",
  "REJECTED",
  "FAILED",
  "INTERRUPTED"
]);

export type EmbodiedPresentationOutcomeKind = z.infer<
  typeof EmbodiedPresentationOutcomeKindSchema
>;

export const EmbodiedPresentationOutcomeReportSchema = z
  .object({
    version: z.literal(EMBODIED_PRESENTATION_OUTCOME_7K_VERSION),
    /** Correlates this observation to a Runtime-owned effect identity only. */
    effectId: EmbodiedOpaqueReferenceSchema,
    outcome: EmbodiedPresentationOutcomeKindSchema
  })
  .strict();

export type EmbodiedPresentationOutcomeReport = z.infer<
  typeof EmbodiedPresentationOutcomeReportSchema
>;

/**
 * Canonicalize one Presentation-side observation about an embodied effect.
 *
 * This report is deliberately non-authoritative. In particular, COMPLETED means
 * only that Presentation observed its own rendering operation complete; it does
 * not complete the Runtime effect, publish a canonical lifecycle event, prove
 * user-visible success, or create Memory/P8 truth. Runtime acceptance and any
 * authoritative state transition remain a separate later boundary.
 *
 * Device/provider details and raw render payloads stay outside this stable
 * contract so presentation implementations can be replaced without changing
 * Runtime semantics.
 */
export function createEmbodiedPresentationOutcomeReport(
  input: unknown
): EmbodiedPresentationOutcomeReport {
  return Object.freeze(EmbodiedPresentationOutcomeReportSchema.parse(input));
}
