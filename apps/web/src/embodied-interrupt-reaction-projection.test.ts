import { describe, expect, it, vi } from "vitest";
import { projectInterruptAcknowledgementToEmbodiedBehavior } from "./embodied-interrupt-reaction-projection.js";

function interruptIntent() {
  return {
    intentId: "behavior-controller:4:12:interrupt-acknowledgement",
    source: "user-interaction",
    reason: "interrupt-acknowledgement",
    priority: "P2",
    createdAtMs: 2200,
    expiresAtMs: 2850,
    scope: "turn",
    epoch: "request-73",
    kind: "reaction",
    payload: { reaction: "acknowledge-interrupt", intensity: 1 }
  } as const;
}

describe("Phase 7E interrupt acknowledgement projection", () => {
  it("projects the exact P5 interrupt producer into a turn-correlated 7A EXPRESSION input", () => {
    const canonicalize = vi.fn((input: unknown) => Object.freeze({ accepted: input }));
    const result = projectInterruptAcknowledgementToEmbodiedBehavior(
      interruptIntent(),
      canonicalize
    );

    expect(canonicalize).toHaveBeenCalledTimes(1);
    expect(canonicalize).toHaveBeenCalledWith({
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "EXPRESSION",
        cause: { kind: "user-interaction", reference: "request-73" },
        intent: "acknowledge-interrupt"
      },
      sourceInstance: {
        reference: "behavior-controller:4:12:interrupt-acknowledgement",
        createdAtMs: 2200
      },
      correlation: { kind: "turn", reference: "request-73" }
    });
    expect(result).not.toBeNull();
  });

  it.each([
    { ...interruptIntent(), scope: "session", sessionId: "session-1" },
    { ...interruptIntent(), source: "lifecycle" },
    { ...interruptIntent(), reason: "lifecycle-reaction" },
    { ...interruptIntent(), priority: "P1" },
    { ...interruptIntent(), kind: "gaze" },
    {
      ...interruptIntent(),
      payload: { reaction: "engage-user", intensity: 1 }
    },
    {
      ...interruptIntent(),
      payload: { reaction: "acknowledge-interrupt", intensity: 0 }
    },
    {
      ...interruptIntent(),
      payload: { reaction: "acknowledge-interrupt", intensity: 2 }
    },
    { ...interruptIntent(), createdAtMs: -1 },
    { ...interruptIntent(), expiresAtMs: 2200 }
  ])("fails closed before canonicalization for non-projectable input %#", (input) => {
    const canonicalize = vi.fn((value: unknown) => value);

    expect(projectInterruptAcknowledgementToEmbodiedBehavior(input, canonicalize)).toBeNull();
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("fails closed when the authoritative canonicalizer rejects the projected identity", () => {
    const canonicalize = vi.fn(() => {
      throw new Error("bounded protocol rejected projection");
    });

    expect(
      projectInterruptAcknowledgementToEmbodiedBehavior(interruptIntent(), canonicalize)
    ).toBeNull();
    expect(canonicalize).toHaveBeenCalledTimes(1);
  });

  it("rejects hidden execution metadata instead of forwarding it", () => {
    for (const extra of [
      { requestId: "runtime-request-2" },
      { effectId: "runtime-effect-2" },
      { idempotencyKey: "runtime-2" },
      { provider: "temporary-model" },
      { device: "live2d" }
    ]) {
      const canonicalize = vi.fn((value: unknown) => value);
      expect(
        projectInterruptAcknowledgementToEmbodiedBehavior(
          { ...interruptIntent(), ...extra },
          canonicalize
        )
      ).toBeNull();
      expect(canonicalize).not.toHaveBeenCalled();
    }
  });
});
