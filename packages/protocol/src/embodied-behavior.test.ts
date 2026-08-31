import { describe, expect, it } from "vitest";
import {
  EMBODIED_BEHAVIOR_7A_VERSION,
  EmbodiedBehaviorEnvelopeSchema,
  createEmbodiedBehaviorEnvelope
} from "./embodied-behavior.js";

describe("Phase 7A embodied behavior envelope", () => {
  it("canonicalizes causally grounded silence without inventing presentation output", () => {
    const envelope = createEmbodiedBehaviorEnvelope({
      version: EMBODIED_BEHAVIOR_7A_VERSION,
      kind: "SILENCE",
      cause: { kind: "character", reference: "proposal:42" }
    });

    expect(envelope).toEqual({
      version: EMBODIED_BEHAVIOR_7A_VERSION,
      kind: "SILENCE",
      cause: { kind: "character", reference: "proposal:42" }
    });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.cause)).toBe(true);
  });

  it("preserves the proven device-neutral gaze target and bounded strength", () => {
    expect(
      createEmbodiedBehaviorEnvelope({
        version: EMBODIED_BEHAVIOR_7A_VERSION,
        kind: "GAZE",
        cause: { kind: "lifecycle", reference: "turn:epoch-7" },
        target: "down-thoughtful",
        strength: 2
      })
    ).toEqual({
      version: EMBODIED_BEHAVIOR_7A_VERSION,
      kind: "GAZE",
      cause: { kind: "lifecycle", reference: "turn:epoch-7" },
      target: "down-thoughtful",
      strength: 2
    });
  });

  it("accepts an opaque device-neutral expression intent", () => {
    expect(
      createEmbodiedBehaviorEnvelope({
        version: EMBODIED_BEHAVIOR_7A_VERSION,
        kind: "EXPRESSION",
        cause: { kind: "user-interaction", reference: "gesture:smile-1" },
        intent: "soft-smile"
      })
    ).toMatchObject({ kind: "EXPRESSION", intent: "soft-smile" });
  });

  it("keeps idle fallback, speech, motion, device, provider, and Runtime execution fields out", () => {
    const invalid = [
      {
        version: EMBODIED_BEHAVIOR_7A_VERSION,
        kind: "GAZE",
        cause: { kind: "idle-policy", reference: "idle:1" },
        target: "user",
        strength: 1
      },
      {
        version: EMBODIED_BEHAVIOR_7A_VERSION,
        kind: "SPEECH",
        cause: { kind: "character", reference: "proposal:1" },
        text: "hello"
      },
      {
        version: EMBODIED_BEHAVIOR_7A_VERSION,
        kind: "EXPRESSION",
        cause: { kind: "character", reference: "proposal:1" },
        intent: "soft-smile",
        animationClip: "Smile.motion3.json"
      },
      {
        version: EMBODIED_BEHAVIOR_7A_VERSION,
        kind: "SILENCE",
        cause: { kind: "character", reference: "proposal:1" },
        effectId: "runtime-effect-1"
      },
      {
        version: EMBODIED_BEHAVIOR_7A_VERSION,
        kind: "EXPRESSION",
        cause: { kind: "character", reference: "proposal:1" },
        intent: "soft-smile",
        provider: "temporary-character-model"
      }
    ];

    for (const value of invalid) {
      expect(EmbodiedBehaviorEnvelopeSchema.safeParse(value).success).toBe(false);
    }
  });

  it("does not admit private-text-like causal references or a synthetic none gaze target", () => {
    expect(
      EmbodiedBehaviorEnvelopeSchema.safeParse({
        version: EMBODIED_BEHAVIOR_7A_VERSION,
        kind: "GAZE",
        cause: { kind: "perception", reference: "/home/user/private/file.txt" },
        target: "user",
        strength: 1
      }).success
    ).toBe(false);

    expect(
      EmbodiedBehaviorEnvelopeSchema.safeParse({
        version: EMBODIED_BEHAVIOR_7A_VERSION,
        kind: "GAZE",
        cause: { kind: "attention", reference: "anchor:1" },
        target: "none",
        strength: 0
      }).success
    ).toBe(false);
  });
});
