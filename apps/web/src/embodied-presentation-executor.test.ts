import { describe, expect, it, vi } from "vitest";
import {
  executeEmbodiedPresentationRequest,
  SOFT_SMILE_MOUTH_FORM
} from "./embodied-presentation-executor.js";

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

const softSmile = {
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

const unknownExpression = {
  ...base,
  behavior: {
    ...base.behavior,
    behavior: {
      version: "embodied-behavior-7a.v1" as const,
      kind: "EXPRESSION" as const,
      cause: { kind: "character" as const, reference: "cause:7af:1" },
      intent: "unknown-expression-intent"
    }
  }
};

function actions(
  overrides: Partial<{
    setGazeTarget: ReturnType<typeof vi.fn>;
    setMouthForm: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    setGazeTarget: overrides.setGazeTarget ?? vi.fn(),
    setMouthForm: overrides.setMouthForm ?? vi.fn()
  };
}

describe("production embodied Presentation executor", () => {
  it("maps an admitted gaze request through the existing gaze action", () => {
    const setGazeTarget = vi.fn();
    const setMouthForm = vi.fn();
    const report = executeEmbodiedPresentationRequest(base, { setGazeTarget, setMouthForm });
    expect(report).toMatchObject({ effectId: base.effectId, outcome: "STARTED" });
    expect(setGazeTarget).toHaveBeenCalledWith({ x: -0.65, y: 0.05, strength: 2 });
    expect(setMouthForm).not.toHaveBeenCalled();
  });

  it("preserves semantic silence without creating a visual action", () => {
    const setGazeTarget = vi.fn();
    const setMouthForm = vi.fn();
    const report = executeEmbodiedPresentationRequest(silence, { setGazeTarget, setMouthForm });
    expect(report.outcome).toBe("STARTED");
    expect(setGazeTarget).not.toHaveBeenCalled();
    expect(setMouthForm).not.toHaveBeenCalled();
  });

  it("maps admitted soft-smile through existing ParamMouthForm device action", () => {
    const setGazeTarget = vi.fn();
    const setMouthForm = vi.fn();
    const report = executeEmbodiedPresentationRequest(softSmile, { setGazeTarget, setMouthForm });
    expect(report).toMatchObject({ effectId: softSmile.effectId, outcome: "STARTED" });
    expect(setMouthForm).toHaveBeenCalledWith(SOFT_SMILE_MOUTH_FORM);
    expect(setGazeTarget).not.toHaveBeenCalled();
  });

  it("rejects unknown expression intents without faking completion", () => {
    const setMouthForm = vi.fn();
    const report = executeEmbodiedPresentationRequest(unknownExpression, actions({ setMouthForm }));
    expect(report.outcome).toBe("REJECTED");
    expect(setMouthForm).not.toHaveBeenCalled();
  });

  it("rejects malformed or identity-smuggling requests", () => {
    expect(() =>
      executeEmbodiedPresentationRequest({ ...base, effectId: "cause:7af:1" }, actions())
    ).toThrow();
    expect(() =>
      executeEmbodiedPresentationRequest({ ...base, device: "live2d" }, actions())
    ).toThrow();
  });
});
