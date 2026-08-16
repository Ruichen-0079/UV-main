import { describe, expect, it } from "vitest";
import { adaptSemanticGaze } from "./semantic-gaze-adapter.js";

describe("adaptSemanticGaze", () => {
  it.each([
    ["user", 0, 0, 0.08],
    ["away-left", 0, -0.6, 0.05],
    ["away-right", 0, 0.6, 0.05],
    ["down-thoughtful", 0, 0, -0.24],
    ["recenter", 0, 0, 0]
  ] as const)("maps %s to deterministic finite geometry", (target, _strength, x, y) => {
    const output = adaptSemanticGaze(target, 1);
    expect(output).toEqual({ x, y, strength: 0.5 });
    expect(output).not.toBeNull();
    expect(Number.isFinite(output?.x)).toBe(true);
    expect(Number.isFinite(output?.y)).toBe(true);
    expect(output?.x).toBeGreaterThanOrEqual(-1);
    expect(output?.x).toBeLessThanOrEqual(1);
    expect(output?.y).toBeGreaterThanOrEqual(-1);
    expect(output?.y).toBeLessThanOrEqual(1);
  });

  it("returns null for the semantic none target", () => {
    expect(adaptSemanticGaze("none", 1)).toBeNull();
  });

  it("maps semantic strength conservatively into the execution range", () => {
    expect(adaptSemanticGaze("user", 0)?.strength).toBe(0.25);
    expect(adaptSemanticGaze("user", 1)?.strength).toBe(0.5);
    expect(adaptSemanticGaze("user", 2)?.strength).toBe(0.75);
  });

  it("does not produce a target for an adversarial strength", () => {
    expect(adaptSemanticGaze("user", Number.NaN as never)).toBeNull();
    expect(adaptSemanticGaze("user", 3 as never)).toBeNull();
  });

  it("is deterministic and does not mutate its inputs", () => {
    const first = adaptSemanticGaze("away-left", 2);
    const second = adaptSemanticGaze("away-left", 2);
    expect(second).toEqual(first);
  });
});
