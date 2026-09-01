import { describe, expect, it, vi } from "vitest";
import { executeEmbodiedPresentationRequest } from "./embodied-presentation-executor.js";

const base = {
  version: "embodied-presentation-request-7ad.v1" as const,
  effectId: "runtime-effect:7af:1",
  behavior: {
    version: "embodied-behavior-7b.v1" as const,
    behavior: {
      version: "embodied-behavior-7a.v1" as const,
      kind: "GAZE" as const,
      cause: { kind: "attention" as const, reference: "cause:7af:1" },
      target: "away-left" as const,
      strength: 2 as const
    },
    sourceInstance: { reference: "source:7af:1", createdAtMs: 1 },
    correlation: { kind: "turn" as const, reference: "turn:7af:1" }
  }
};

const silence = {
  ...base,
  behavior: {
    ...base.behavior,
    behavior: {
      version: "embodied-behavior-7a.v1" as const,
      kind: "SILENCE" as const,
      cause: { kind: "attention" as const, reference: "cause:7af:1" }
    }
  }
};

const expression = {
  ...base,
  behavior: {
    ...base.behavior,
    behavior: {
      version: "embodied-behavior-7a.v1" as const,
      kind: "EXPRESSION" as const,
      cause: { kind: "character" as const, reference: "cause:7af:1" },
      intent: "soft-smile"
    }
  }
};

describe("production embodied Presentation executor", () => {
  it("maps an admitted gaze request through the existing gaze action", () => {
    const setGazeTarget = vi.fn();
    const report = executeEmbodiedPresentationRequest(base, { setGazeTarget });
    expect(report).toMatchObject({ effectId: base.effectId, outcome: "COMPLETED" });
    expect(setGazeTarget).toHaveBeenCalledWith({ x: -0.65, y: 0.05, strength: 2 });
  });

  it("preserves semantic silence without creating a visual action", () => {
    const setGazeTarget = vi.fn();
    const report = executeEmbodiedPresentationRequest(silence, { setGazeTarget });
    expect(report.outcome).toBe("COMPLETED");
    expect(setGazeTarget).not.toHaveBeenCalled();
  });

  it("does not fake completion for the unavailable expression layer", () => {
    const report = executeEmbodiedPresentationRequest(expression, { setGazeTarget: vi.fn() });
    expect(report.outcome).toBe("REJECTED");
  });

  it("rejects malformed or identity-smuggling requests", () => {
    expect(() =>
      executeEmbodiedPresentationRequest(
        { ...base, effectId: "cause:7af:1" },
        { setGazeTarget: vi.fn() }
      )
    ).toThrow();
    expect(() =>
      executeEmbodiedPresentationRequest({ ...base, device: "live2d" }, { setGazeTarget: vi.fn() })
    ).toThrow();
  });
});
