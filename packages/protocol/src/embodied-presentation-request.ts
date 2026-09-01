import { z } from "zod";
import { EmbodiedOpaqueReferenceSchema } from "./embodied-behavior.js";
import {
  CorrelatedEmbodiedBehaviorSchema,
  createCorrelatedEmbodiedBehavior,
  type CorrelatedEmbodiedBehavior
} from "./embodied-behavior-correlation.js";

export const EMBODIED_PRESENTATION_REQUEST_7AD_VERSION =
  "embodied-presentation-request-7ad.v1" as const;

/**
 * Device-neutral transport shape for one Runtime-identified semantic embodied
 * behavior crossing into Presentation.
 *
 * A value passing this schema is only well formed. It is not proof that Runtime
 * admitted the effect. Runtime remains responsible for emitting this request
 * only from an admitted effect record at a separate composition boundary.
 */
export const EmbodiedPresentationRequestSchema = z
  .object({
    version: z.literal(EMBODIED_PRESENTATION_REQUEST_7AD_VERSION),
    effectId: EmbodiedOpaqueReferenceSchema,
    behavior: CorrelatedEmbodiedBehaviorSchema
  })
  .strict()
  .superRefine((value, context) => {
    const semanticReferences = [
      value.behavior.behavior.cause.reference,
      value.behavior.sourceInstance.reference,
      value.behavior.correlation.reference
    ];
    if (semanticReferences.includes(value.effectId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectId"],
        message:
          "Presentation request effectId must be distinct from cause, source-instance, and correlation references."
      });
    }
  });

export type EmbodiedPresentationRequest = Readonly<{
  version: typeof EMBODIED_PRESENTATION_REQUEST_7AD_VERSION;
  /** Runtime-owned execution identity; transport correlation only at this boundary. */
  effectId: string;
  /** Canonical device-neutral semantic behavior to be realized by Presentation. */
  behavior: CorrelatedEmbodiedBehavior;
}>;

/**
 * Canonicalize one device-neutral Presentation request.
 *
 * This factory deliberately owns no admission, lifecycle, publication,
 * cancellation, renderer selection, device mapping, or outcome authority. It
 * also carries no Runtime trace: semantic correlation remains inside 7B while
 * effectId is the sole execution-identity correlation exposed to Presentation.
 */
export function createEmbodiedPresentationRequest(input: unknown): EmbodiedPresentationRequest {
  const parsed = EmbodiedPresentationRequestSchema.parse(input);
  return Object.freeze({
    version: EMBODIED_PRESENTATION_REQUEST_7AD_VERSION,
    effectId: parsed.effectId,
    behavior: createCorrelatedEmbodiedBehavior(parsed.behavior)
  });
}
