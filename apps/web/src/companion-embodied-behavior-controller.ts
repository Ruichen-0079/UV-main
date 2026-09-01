import {
  createCorrelatedEmbodiedBehavior,
  type CorrelatedEmbodiedBehavior
} from "@companion/protocol";
import { createBehaviorPolicyControllerWithEmbodiedShadow } from "./behavior-policy-embodied-shadow.js";
import type {
  BehaviorPolicyController,
  BehaviorPolicyControllerOptions
} from "./behavior-policy-controller.js";

export type CompanionEmbodiedShadowObserver = (
  projection: CorrelatedEmbodiedBehavior
) => void;

/**
 * Production companion composition for the already-authoritative P5 behavior
 * controller plus its read-only Phase-7 semantic shadow.
 *
 * P5 continues to own arbitration, timers, gaze execution, and interruption.
 * The Protocol canonicalizer only validates the observed 7B projection. This
 * seam allocates no Runtime effect identity, performs no Runtime admission or
 * lifecycle transition, publishes no event, and performs no renderer/device
 * mapping.
 */
export function createCompanionEmbodiedBehaviorController(
  options: BehaviorPolicyControllerOptions,
  observe: CompanionEmbodiedShadowObserver = () => undefined
): BehaviorPolicyController {
  return createBehaviorPolicyControllerWithEmbodiedShadow({
    controller: options,
    canonicalize: createCorrelatedEmbodiedBehavior,
    observe
  });
}
