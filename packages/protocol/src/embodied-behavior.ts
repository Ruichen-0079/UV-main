import { z } from "zod";

export const EMBODIED_BEHAVIOR_7A_VERSION = "embodied-behavior-7a.v1" as const;

/**
 * Semantic causal categories only. Concrete providers, devices, tools, paths,
 * animation clips, and Runtime lifecycle state are deliberately outside this
 * first Phase-7 presentation contract.
 */
export const EmbodiedBehaviorCauseKindSchema = z.enum([
  "user-interaction",
  "lifecycle",
  "character",
  "attention",
  "continuity",
  "situation",
  "perception",
  "cognition"
]);

export type EmbodiedBehaviorCauseKind = z.infer<typeof EmbodiedBehaviorCauseKindSchema>;

const OpaqueCausalReferenceSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/);

export const EmbodiedBehaviorCauseSchema = z
  .object({
    kind: EmbodiedBehaviorCauseKindSchema,
    /** Opaque lookup/audit identity only; never raw private context or payload text. */
    reference: OpaqueCausalReferenceSchema
  })
  .strict();

export type EmbodiedBehaviorCause = z.infer<typeof EmbodiedBehaviorCauseSchema>;

/** Reuses the already-proven device-neutral P5 semantic gaze vocabulary. */
export const EmbodiedGazeTargetSchema = z.enum([
  "user",
  "away-left",
  "away-right",
  "down-thoughtful",
  "recenter"
]);

export type EmbodiedGazeTarget = z.infer<typeof EmbodiedGazeTargetSchema>;

export const EmbodiedBehaviorStrengthSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2)
]);

export type EmbodiedBehaviorStrength = z.infer<typeof EmbodiedBehaviorStrengthSchema>;

const ExpressionIntentSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const BaseEnvelopeFields = {
  version: z.literal(EMBODIED_BEHAVIOR_7A_VERSION),
  cause: EmbodiedBehaviorCauseSchema
} as const;

export const EmbodiedBehaviorEnvelopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...BaseEnvelopeFields,
      kind: z.literal("SILENCE")
    })
    .strict(),
  z
    .object({
      ...BaseEnvelopeFields,
      kind: z.literal("GAZE"),
      target: EmbodiedGazeTargetSchema,
      strength: EmbodiedBehaviorStrengthSchema
    })
    .strict(),
  z
    .object({
      ...BaseEnvelopeFields,
      kind: z.literal("EXPRESSION"),
      /** Device-neutral semantic token, not a concrete animation/motion clip name. */
      intent: ExpressionIntentSchema
    })
    .strict()
]);

export type EmbodiedBehaviorEnvelope = z.infer<typeof EmbodiedBehaviorEnvelopeSchema>;

/**
 * Canonicalize one semantic embodied-behavior request.
 *
 * This is intentionally not a Runtime event or an execution-admission record.
 * Phase 7B may project already-authoritative P5/P6 lifecycle identity around
 * this semantic envelope without changing the 7A meaning.
 *
 * Random idle fallback is intentionally absent: only causally grounded semantic
 * behavior may enter this contract.
 */
export function createEmbodiedBehaviorEnvelope(input: unknown): EmbodiedBehaviorEnvelope {
  const parsed = EmbodiedBehaviorEnvelopeSchema.parse(input);
  return Object.freeze({
    ...parsed,
    cause: Object.freeze({ ...parsed.cause })
  });
}
