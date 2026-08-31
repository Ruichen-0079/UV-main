import type { BehaviorSemanticIntent } from "./behavior-policy.js";

type InterruptAcknowledgementIntent = Extract<
  BehaviorSemanticIntent,
  { readonly kind: "reaction" }
> & {
  readonly scope: "turn";
  readonly epoch: string;
  readonly source: "user-interaction";
  readonly reason: "interrupt-acknowledgement";
  readonly priority: "P2";
  readonly payload: {
    readonly reaction: "acknowledge-interrupt";
    readonly intensity: 1;
  };
};

export type EmbodiedReactionCanonicalizer<TResult> = (input: unknown) => TResult;

const INTERRUPT_REACTION_KEYS = [
  "intentId",
  "source",
  "reason",
  "priority",
  "createdAtMs",
  "expiresAtMs",
  "scope",
  "epoch",
  "kind",
  "payload"
] as const;

const REACTION_PAYLOAD_KEYS = ["reaction", "intensity"] as const;

/**
 * Mechanical Phase-7 projection of the already-proven P5 interrupt
 * acknowledgement reaction. The current producer is intentionally exact:
 * turn-scoped, user-interaction sourced, P2, and intensity 1. Other reaction
 * shapes fail closed rather than losing semantics through the 7A EXPRESSION
 * vocabulary, which currently carries no independent intensity field.
 *
 * The injected canonicalizer remains the 7A/7B validation authority. This
 * seam does not admit, schedule, render, publish, or execute an effect.
 */
export function projectInterruptAcknowledgementToEmbodiedBehavior<TResult>(
  input: unknown,
  canonicalize: EmbodiedReactionCanonicalizer<TResult>
): TResult | null {
  if (!isInterruptAcknowledgementIntent(input)) return null;

  try {
    return canonicalize({
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "EXPRESSION",
        cause: {
          kind: "user-interaction",
          reference: input.epoch
        },
        intent: "acknowledge-interrupt"
      },
      sourceInstance: {
        reference: input.intentId,
        createdAtMs: input.createdAtMs
      },
      correlation: {
        kind: "turn",
        reference: input.epoch
      }
    });
  } catch {
    return null;
  }
}

function isInterruptAcknowledgementIntent(input: unknown): input is InterruptAcknowledgementIntent {
  if (!isRecord(input) || !hasExactKeys(input, INTERRUPT_REACTION_KEYS)) return false;
  if (
    input["kind"] !== "reaction" ||
    input["scope"] !== "turn" ||
    input["source"] !== "user-interaction" ||
    input["reason"] !== "interrupt-acknowledgement" ||
    input["priority"] !== "P2" ||
    !isNonEmptyString(input["intentId"]) ||
    !isNonEmptyString(input["epoch"]) ||
    !isFiniteNonNegative(input["createdAtMs"]) ||
    !isFiniteNonNegative(input["expiresAtMs"]) ||
    input["expiresAtMs"] <= input["createdAtMs"] ||
    !isRecord(input["payload"]) ||
    !hasExactKeys(input["payload"], REACTION_PAYLOAD_KEYS)
  ) {
    return false;
  }

  return (
    input["payload"]["reaction"] === "acknowledge-interrupt" &&
    input["payload"]["intensity"] === 1
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expected.length) return false;
  const allowed = new Set(expected);
  return keys.every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
