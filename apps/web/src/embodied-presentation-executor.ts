import {
  createEmbodiedPresentationOutcomeReport,
  createEmbodiedPresentationRequest,
  type EmbodiedPresentationOutcomeReport,
  type EmbodiedPresentationRequest,
  type EmbodiedGazeTarget
} from "@companion/protocol";
import type { SuppliedGazeTarget } from "./companion-gaze.js";

export type EmbodiedPresentationExecutorActions = Readonly<{
  setGazeTarget: (target: SuppliedGazeTarget | null) => void;
}>;

/**
 * Execute one already-admitted request at the existing Presentation boundary.
 *
 * This is intentionally a small device adapter: it validates transport input,
 * maps only the existing gaze vocabulary, preserves SILENCE, and reports an
 * unsupported expression truthfully. It owns no Runtime lifecycle, admission,
 * identity allocation, publication, or idle-animation semantics.
 */
export function executeEmbodiedPresentationRequest(
  input: unknown,
  actions: EmbodiedPresentationExecutorActions
): EmbodiedPresentationOutcomeReport {
  const request = createEmbodiedPresentationRequest(input);
  if (typeof actions?.setGazeTarget !== "function") {
    return outcome(request, "REJECTED");
  }

  switch (request.behavior.behavior.kind) {
    case "SILENCE":
      return outcome(request, "COMPLETED");
    case "GAZE":
      actions.setGazeTarget(
        gazeTarget(request.behavior.behavior.target, request.behavior.behavior.strength)
      );
      return outcome(request, "COMPLETED");
    case "EXPRESSION":
      return outcome(request, "REJECTED");
  }
}

function outcome(
  request: EmbodiedPresentationRequest,
  value: EmbodiedPresentationOutcomeReport["outcome"]
): EmbodiedPresentationOutcomeReport {
  return createEmbodiedPresentationOutcomeReport({
    version: "embodied-presentation-outcome-7k.v1",
    effectId: request.effectId,
    outcome: value
  });
}

function gazeTarget(target: EmbodiedGazeTarget, strength: 0 | 1 | 2): SuppliedGazeTarget | null {
  if (target === "recenter") return null;
  const points = {
    user: { x: 0, y: 0.05 },
    "away-left": { x: -0.65, y: 0.05 },
    "away-right": { x: 0.65, y: 0.05 },
    "down-thoughtful": { x: 0, y: -0.24 }
  } as const;
  const point = points[target];
  const scale = strength === 0 ? 0.5 : strength === 1 ? 0.75 : 1;
  return { x: point.x * scale, y: point.y * scale, strength };
}
