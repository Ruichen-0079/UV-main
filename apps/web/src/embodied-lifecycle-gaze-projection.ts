import type { BehaviorSemanticIntent } from "./behavior-policy.js";

type LifecycleGazeIntent = Extract<BehaviorSemanticIntent, { readonly kind: "gaze" }> & {
  readonly scope: "turn";
  readonly epoch: string;
  readonly source: "lifecycle";
  readonly reason: "thinking" | "speech-active";
  readonly priority: "P1";
};

export type EmbodiedBehaviorCanonicalizer<TResult> = (input: unknown) => TResult;

const LIFECYCLE_GAZE_KEYS = [
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

const GAZE_PAYLOAD_KEYS = ["target", "strength"] as const;

/**
 * Mechanical Phase-7 projection of the two already-proven turn-scoped P5
 * lifecycle gaze intents. The injected canonicalizer remains the 7A/7B
 * validation authority; this seam does not admit, schedule, render, publish,
 * or otherwise execute an embodied effect.
 */
export function projectLifecycleGazeToEmbodiedBehavior<TResult>(
  input: unknown,
  canonicalize: EmbodiedBehaviorCanonicalizer<TResult>
): TResult | null {
  if (!isLifecycleGazeIntent(input)) return null;

  try {
    return canonicalize({
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "GAZE",
        cause: {
          kind: "lifecycle",
          reference: input.epoch
        },
        target: input.payload.target,
        strength: input.payload.strength
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
    // Existing P5 identities remain opaque caller-owned values. Any 7A/7B
    // protocol rejection fails closed; the projector never rewrites identity.
    return null;
  }
}

function isLifecycleGazeIntent(input: unknown): input is LifecycleGazeIntent {
  if (!isRecord(input) || !hasExactKeys(input, LIFECYCLE_GAZE_KEYS)) return false;
  if (
    input["kind"] !== "gaze" ||
    input["scope"] !== "turn" ||
    input["source"] !== "lifecycle" ||
    input["priority"] !== "P1" ||
    !isNonEmptyString(input["intentId"]) ||
    !isNonEmptyString(input["epoch"]) ||
    !isFiniteNonNegative(input["createdAtMs"]) ||
    !isFiniteNonNegative(input["expiresAtMs"]) ||
    input["expiresAtMs"] <= input["createdAtMs"] ||
    !isRecord(input["payload"]) ||
    !hasExactKeys(input["payload"], GAZE_PAYLOAD_KEYS)
  ) {
    return false;
  }

  const payload = input["payload"];
  if (!isSemanticStrength(payload["strength"])) return false;

  if (input["reason"] === "thinking") {
    return payload["target"] === "down-thoughtful";
  }
  if (input["reason"] === "speech-active") {
    return payload["target"] === "user";
  }
  return false;
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

function isSemanticStrength(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}
