import { z } from "zod";
import {
  EmbodiedBehaviorEnvelopeSchema,
  EmbodiedOpaqueReferenceSchema,
  createEmbodiedBehaviorEnvelope,
  type EmbodiedBehaviorEnvelope
} from "./embodied-behavior.js";

export const EMBODIED_BEHAVIOR_7B_VERSION = "embodied-behavior-7b.v1" as const;

/**
 * Identity of the already-admitted semantic presentation-policy instance.
 * This is correlation only, not a Runtime effect identity or admission token.
 */
export const EmbodiedBehaviorSourceInstanceSchema = z
  .object({
    reference: EmbodiedOpaqueReferenceSchema,
    createdAtMs: z.number().finite().nonnegative()
  })
  .strict();

export type EmbodiedBehaviorSourceInstance = z.infer<
  typeof EmbodiedBehaviorSourceInstanceSchema
>;

/**
 * Current P5/P6 correlation vocabulary only. Resource generations are not yet
 * authoritative, so resource correlation is intentionally absent.
 */
export const EmbodiedBehaviorCorrelationKindSchema = z.enum(["turn", "session", "decision"]);

export type EmbodiedBehaviorCorrelationKind = z.infer<
  typeof EmbodiedBehaviorCorrelationKindSchema
>;

export const EmbodiedBehaviorCorrelationSchema = z
  .object({
    kind: EmbodiedBehaviorCorrelationKindSchema,
    reference: EmbodiedOpaqueReferenceSchema
  })
  .strict();

export type EmbodiedBehaviorCorrelation = z.infer<typeof EmbodiedBehaviorCorrelationSchema>;

export const CorrelatedEmbodiedBehaviorSchema = z
  .object({
    version: z.literal(EMBODIED_BEHAVIOR_7B_VERSION),
    behavior: EmbodiedBehaviorEnvelopeSchema,
    sourceInstance: EmbodiedBehaviorSourceInstanceSchema,
    correlation: EmbodiedBehaviorCorrelationSchema
  })
  .strict();

export type CorrelatedEmbodiedBehavior = Readonly<{
  version: typeof EMBODIED_BEHAVIOR_7B_VERSION;
  behavior: EmbodiedBehaviorEnvelope;
  sourceInstance: EmbodiedBehaviorSourceInstance;
  correlation: EmbodiedBehaviorCorrelation;
}>;

/**
 * Correlate one canonical 7A semantic behavior with identities that already
 * exist in the P5/P6 presentation path.
 *
 * Cause, semantic-instance identity, and turn/session/decision correlation are
 * deliberately separate meanings. This seam does not create Runtime effect
 * identity, idempotency, admission, publication, or device execution authority.
 */
export function createCorrelatedEmbodiedBehavior(input: unknown): CorrelatedEmbodiedBehavior {
  const parsed = CorrelatedEmbodiedBehaviorSchema.parse(input);
  return Object.freeze({
    version: EMBODIED_BEHAVIOR_7B_VERSION,
    behavior: createEmbodiedBehaviorEnvelope(parsed.behavior),
    sourceInstance: Object.freeze({ ...parsed.sourceInstance }),
    correlation: Object.freeze({ ...parsed.correlation })
  });
}
