import { describe, expect, it, vi } from "vitest";
import { createInitialCompanionPresence, type CompanionPresenceProjection } from "./companion-presence.js";
import { createBehaviorPolicyControllerWithEmbodiedShadow } from "./behavior-policy-embodied-shadow.js";

function presence(
  activity: CompanionPresenceProjection["activity"],
  speech: CompanionPresenceProjection["speech"] = "inactive"
): CompanionPresenceProjection {
  const base = createInitialCompanionPresence("online");
  return {
    ...base,
    epoch: "request-42",
    lifecycle: "active",
    activity,
    speech,
    capabilities: {
      ...base.capabilities,
      live2d: "available"
    }
  };
}

function createHarness(
  overrides: {
    canonicalize?: (input: unknown) => unknown;
    observe?: (projection: unknown) => void;
  } = {}
) {
  let nowMs = 1000;
  const setGazeTarget = vi.fn();
  const canonicalize = vi.fn(overrides.canonicalize ?? ((input: unknown) => ({ accepted: input })));
  const observe = vi.fn(overrides.observe ?? (() => undefined));
  const controller = createBehaviorPolicyControllerWithEmbodiedShadow({
    controller: {
      sessionId: "session-1",
      controllerId: "shadow-test",
      now: () => nowMs,
      setTimer: (callback) => ({ callback }),
      clearTimer: () => undefined,
      setGazeTarget
    },
    canonicalize,
    observe
  });

  return {
    controller,
    setGazeTarget,
    canonicalize,
    observe,
    setNow(next: number) {
      nowMs = next;
    }
  };
}

describe("Phase 7D behavior-policy embodied shadow", () => {
  it("shadows only the already-arbitrated active thinking lifecycle gaze", () => {
    const harness = createHarness();

    harness.controller.updatePresence(presence("idle"));
    harness.controller.updatePresence(presence("thinking"));

    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      reason: "thinking",
      intentId: "shadow-test:0:0:thinking"
    });
    expect(harness.setGazeTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ strength: 0.5 })
    );
    expect(harness.canonicalize).toHaveBeenCalledTimes(1);
    expect(harness.canonicalize).toHaveBeenCalledWith({
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "GAZE",
        cause: { kind: "lifecycle", reference: "request-42" },
        target: "down-thoughtful",
        strength: 1
      },
      sourceInstance: {
        reference: "shadow-test:0:0:thinking",
        createdAtMs: 1000
      },
      correlation: { kind: "turn", reference: "request-42" }
    });
    expect(harness.observe).toHaveBeenCalledTimes(1);
  });

  it("attempts each active semantic instance at most once", () => {
    const harness = createHarness();

    harness.controller.updatePresence(presence("idle"));
    harness.controller.updatePresence(presence("thinking"));
    harness.controller.updatePresence({
      ...presence("thinking"),
      connectivity: "reconnecting"
    });

    expect(harness.canonicalize).toHaveBeenCalledTimes(1);
    expect(harness.observe).toHaveBeenCalledTimes(1);
  });

  it("shadows a newly admitted speech-active lifecycle gaze as a distinct instance", () => {
    const harness = createHarness();

    harness.controller.updatePresence(presence("idle"));
    harness.controller.updatePresence(presence("thinking"));
    harness.setNow(1100);
    harness.controller.updatePresence(presence("thinking", "active"));

    expect(harness.canonicalize).toHaveBeenCalledTimes(2);
    expect(harness.observe).toHaveBeenCalledTimes(2);
    expect(harness.canonicalize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        behavior: expect.objectContaining({ kind: "GAZE", target: "user", strength: 1 }),
        sourceInstance: {
          reference: "shadow-test:0:1:speech-active",
          createdAtMs: 1100
        }
      })
    );
    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      reason: "speech-active"
    });
  });

  it("does not project a lower-priority lifecycle candidate that never becomes active", () => {
    const harness = createHarness();

    harness.controller.updatePresence(presence("idle"));
    harness.controller.updatePresence(presence("listening"));
    harness.setNow(1050);
    harness.controller.updatePresence(presence("thinking"));

    expect(harness.controller.getState().active).toMatchObject({
      kind: "attention",
      reason: "listening-entry",
      priority: "P0"
    });
    expect(harness.canonicalize).not.toHaveBeenCalled();
    expect(harness.observe).not.toHaveBeenCalled();
  });

  it("keeps existing gaze execution authoritative when canonicalization rejects", () => {
    const harness = createHarness({
      canonicalize: () => {
        throw new Error("shadow protocol rejection");
      }
    });

    harness.controller.updatePresence(presence("idle"));
    expect(() => harness.controller.updatePresence(presence("thinking"))).not.toThrow();

    expect(harness.setGazeTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ strength: 0.5 })
    );
    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      reason: "thinking"
    });
    expect(harness.canonicalize).toHaveBeenCalledTimes(1);
    expect(harness.observe).not.toHaveBeenCalled();

    harness.controller.updatePresence({ ...presence("thinking"), connectivity: "offline" });
    expect(harness.canonicalize).toHaveBeenCalledTimes(1);
  });

  it("isolates observer failure and never retries the same semantic instance", () => {
    const harness = createHarness({
      observe: () => {
        throw new Error("shadow observer unavailable");
      }
    });

    harness.controller.updatePresence(presence("idle"));
    expect(() => harness.controller.updatePresence(presence("thinking"))).not.toThrow();
    expect(harness.observe).toHaveBeenCalledTimes(1);
    expect(harness.controller.getState().active).toMatchObject({
      kind: "gaze",
      reason: "thinking"
    });

    harness.controller.updatePresence({ ...presence("thinking"), connectivity: "reconnecting" });
    expect(harness.observe).toHaveBeenCalledTimes(1);
  });

  it("delegates disposal without creating any new projection authority", () => {
    const harness = createHarness();

    harness.controller.updatePresence(presence("idle"));
    harness.controller.dispose();
    harness.controller.updatePresence(presence("thinking"));

    expect(harness.controller.getState().active).toEqual({ kind: "none" });
    expect(harness.canonicalize).not.toHaveBeenCalled();
    expect(harness.observe).not.toHaveBeenCalled();
    expect(harness.setGazeTarget).toHaveBeenLastCalledWith(null);
  });
});
