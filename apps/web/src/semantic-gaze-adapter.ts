import { GAZE_REGION_RANGES, type SuppliedGazeTarget } from "./companion-gaze.js";
import type { BehaviorSemanticStrength, SemanticGazeTarget } from "./behavior-policy.js";

const EXECUTION_STRENGTH: Record<BehaviorSemanticStrength, number> = {
  0: 0.25,
  1: 0.5,
  2: 0.75
};

function midpoint(range: readonly [number, number]): number {
  return (range[0] + range[1]) / 2;
}

function semanticPoint(target: Exclude<SemanticGazeTarget, "none">): { x: number; y: number } {
  switch (target) {
    case "user":
      return { x: midpoint(GAZE_REGION_RANGES.center.x), y: 0.08 };
    case "away-left":
      return {
        x: midpoint(GAZE_REGION_RANGES.left.x),
        y: midpoint(GAZE_REGION_RANGES.left.y)
      };
    case "away-right":
      return {
        x: midpoint(GAZE_REGION_RANGES.right.x),
        y: midpoint(GAZE_REGION_RANGES.right.y)
      };
    case "down-thoughtful":
      return {
        x: midpoint(GAZE_REGION_RANGES.lower.x),
        y: midpoint(GAZE_REGION_RANGES.lower.y)
      };
    case "recenter":
      return { x: 0, y: 0 };
  }
}

/**
 * Convert a semantic target into the existing P5 supplied-target vocabulary.
 * This function owns geometry only; it does not interpolate, schedule, or
 * choose targets.
 */
export function adaptSemanticGaze(
  target: SemanticGazeTarget,
  strength: BehaviorSemanticStrength
): SuppliedGazeTarget | null {
  if (target === "none") return null;
  if (strength !== 0 && strength !== 1 && strength !== 2) return null;

  const point = semanticPoint(target);
  return {
    x: Number.isFinite(point.x) ? point.x : 0,
    y: Number.isFinite(point.y) ? point.y : 0,
    strength: EXECUTION_STRENGTH[strength]
  };
}
