import { describe, expect, it, vi } from "vitest";
import {
  createInitialCompanionPresence,
  type CompanionPresenceProjection
} from "./companion-presence.js";
import { createCompanionEmbodiedBehaviorController } from "./companion-embodied-behavior-controller.js";

function presence(
  activity: CompanionPresenceProjection["activity"]
): CompanionPresenceProjection {
  const base = createInitialCompanionPresence("online");
  return {
    ...base,
    epoch: "request-7ab-1",
    lifecycle: "active",
    activity,
    speech: "inactive",
    capabilities: {
      ...base.capabilities,
      live2d: "available"
    }
  };
}

describe("Phase 7AB companion embodied shadow composition", () => {
  it("observes canonical 7B semantics without replacing P5 gaze execution authority", () => {
    const setGazeTarget = vi.fn();
    const observe = vi.fn();
    const controller = createCompanionEmbodiedBehaviorController(
      {
        sessionId: "session-7ab-1",
        controllerId: "7ab-test",
        now: () => 1000,
        setTimer: (callback) => ({ callback }),
        clearTimer: () => undefined,
        setGazeTarget
      },
      observe
    );

    controller.updatePresence(presence("idle"));
    controller.updatePresence(presence("thinking"));

    expect(controller.getState().active).toMatchObject({
      kind: "gaze",
      reason: "thinking",
      intentId: "7ab-test:0:0:thinking"
    });
    expect(setGazeTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ strength: 0.5 })
    );
    expect(observe).toHaveBeenCalledTimes(1);

    const projection = observe.mock.calls[0]?.[0];
    expect(projection).toEqual({
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "GAZE",
        cause: {
          kind: "lifecycle",
          reference: "request-7ab-1"
        },
        target: "down-thoughtful",
        strength: 1
      },
      sourceInstance: {
        reference: "7ab-test:0:0:thinking",
        createdAtMs: 1000
      },
      correlation: {
        kind: "turn",
        reference: "request-7ab-1"
      }
    });
    expect(Object.isFrozen(projection)).toBe(true);
    for (const key of [
      "effectId",
      "traceId",
      "device",
      "provider",
      "motion",
      "admission",
      "publish"
    ]) {
      expect(projection).not.toHaveProperty(key);
    }
  });
});
