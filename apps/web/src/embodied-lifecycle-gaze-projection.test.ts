import { describe, expect, it, vi } from "vitest";
import { projectLifecycleGazeToEmbodiedBehavior } from "./embodied-lifecycle-gaze-projection.js";

function thinkingIntent() {
  return {
    intentId: "companion-page:3:9:thinking",
    source: "lifecycle",
    reason: "thinking",
    priority: "P1",
    createdAtMs: 1250.5,
    expiresAtMs: 2150.5,
    scope: "turn",
    epoch: "request-42",
    kind: "gaze",
    payload: { target: "down-thoughtful", strength: 2 }
  } as const;
}

describe("Phase 7C lifecycle gaze projection", () => {
  it("projects thinking into the exact 7A/7B canonicalizer input without changing P5 identity", () => {
    const canonicalize = vi.fn((input: unknown) => Object.freeze({ accepted: input }));
    const result = projectLifecycleGazeToEmbodiedBehavior(thinkingIntent(), canonicalize);

    expect(canonicalize).toHaveBeenCalledTimes(1);
    expect(canonicalize).toHaveBeenCalledWith({
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "GAZE",
        cause: { kind: "lifecycle", reference: "request-42" },
        target: "down-thoughtful",
        strength: 2
      },
      sourceInstance: {
        reference: "companion-page:3:9:thinking",
        createdAtMs: 1250.5
      },
      correlation: { kind: "turn", reference: "request-42" }
    });
    expect(result).not.toBeNull();
  });

  it("projects speech-active only to the existing user gaze", () => {
    const canonicalize = vi.fn((input: unknown) => input);

    projectLifecycleGazeToEmbodiedBehavior(
      {
        ...thinkingIntent(),
        intentId: "companion-page:3:10:speech-active",
        reason: "speech-active",
        payload: { target: "user", strength: 1 }
      },
      canonicalize
    );

    expect(canonicalize).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: expect.objectContaining({ kind: "GAZE", target: "user", strength: 1 }),
        sourceInstance: expect.objectContaining({
          reference: "companion-page:3:10:speech-active"
        })
      })
    );
  });

  it.each([
    { ...thinkingIntent(), scope: "session", sessionId: "session-1" },
    { ...thinkingIntent(), source: "user-interaction" },
    { ...thinkingIntent(), kind: "reaction" },
    { ...thinkingIntent(), kind: "proactive" },
    { ...thinkingIntent(), priority: "P2" },
    { ...thinkingIntent(), reason: "speech-active" },
    { ...thinkingIntent(), payload: { target: "none", strength: 1 } },
    { ...thinkingIntent(), payload: { target: "down-thoughtful", strength: 3 } },
    { ...thinkingIntent(), createdAtMs: -1 },
    { ...thinkingIntent(), expiresAtMs: 1250.5 }
  ])("fails closed before canonicalization for non-projectable input %#", (input) => {
    const canonicalize = vi.fn((value: unknown) => value);

    expect(projectLifecycleGazeToEmbodiedBehavior(input, canonicalize)).toBeNull();
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it("fails closed when the authoritative 7A/7B canonicalizer rejects an opaque identity", () => {
    const canonicalize = vi.fn(() => {
      throw new Error("bounded protocol rejected identity");
    });

    expect(projectLifecycleGazeToEmbodiedBehavior(thinkingIntent(), canonicalize)).toBeNull();
    expect(canonicalize).toHaveBeenCalledTimes(1);
  });

  it("rejects hidden execution metadata instead of forwarding it", () => {
    for (const extra of [
      { requestId: "runtime-request-1" },
      { effectId: "runtime-effect-1" },
      { idempotencyKey: "runtime-1" },
      { provider: "temporary-model" },
      { device: "live2d" }
    ]) {
      const canonicalize = vi.fn((value: unknown) => value);
      expect(
        projectLifecycleGazeToEmbodiedBehavior({ ...thinkingIntent(), ...extra }, canonicalize)
      ).toBeNull();
      expect(canonicalize).not.toHaveBeenCalled();
    }
  });
});
