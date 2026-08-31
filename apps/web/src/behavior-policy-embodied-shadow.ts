import {
  createBehaviorPolicyController,
  type BehaviorPolicyController,
  type BehaviorPolicyControllerOptions
} from "./behavior-policy-controller.js";
import { getBehaviorIntentRef, type BehaviorIntentRef } from "./behavior-policy.js";
import {
  projectLifecycleGazeToEmbodiedBehavior,
  type EmbodiedBehaviorCanonicalizer
} from "./embodied-lifecycle-gaze-projection.js";
import { projectInterruptAcknowledgementToEmbodiedBehavior } from "./embodied-interrupt-reaction-projection.js";

export type BehaviorPolicyEmbodiedShadowOptions<TResult> = {
  readonly controller: BehaviorPolicyControllerOptions;
  readonly canonicalize: EmbodiedBehaviorCanonicalizer<TResult>;
  readonly observe: (projection: TResult) => void;
};

function sameIntentRef(left: BehaviorIntentRef, right: BehaviorIntentRef): boolean {
  return left.intentId === right.intentId && left.createdAtMs === right.createdAtMs;
}

/**
 * Decorates the existing P5 behavior-policy controller with a read-only Phase-7
 * shadow projection. The wrapped controller remains the sole policy and gaze
 * execution authority; this seam only observes its already-arbitrated active
 * semantic instance after updatePresence returns.
 */
export function createBehaviorPolicyControllerWithEmbodiedShadow<TResult>(
  options: BehaviorPolicyEmbodiedShadowOptions<TResult>
): BehaviorPolicyController {
  const controller = createBehaviorPolicyController(options.controller);
  let lastAttemptedRef: BehaviorIntentRef | null = null;
  let disposed = false;

  function attemptActiveProjection(): void {
    if (disposed) return;

    const active = controller.getState().active;
    if (active.kind === "none") return;

    const ref = getBehaviorIntentRef(active);
    if (lastAttemptedRef !== null && sameIntentRef(lastAttemptedRef, ref)) return;

    // Fence before canonicalization/observation so one semantic instance can
    // never spin or retry merely because a shadow consumer rejects or throws.
    lastAttemptedRef = Object.freeze({ ...ref });

    const projection =
      projectLifecycleGazeToEmbodiedBehavior(active, options.canonicalize) ??
      projectInterruptAcknowledgementToEmbodiedBehavior(active, options.canonicalize);
    if (projection === null) return;

    try {
      options.observe(projection);
    } catch {
      // Shadow observation is diagnostic/migration-only. It cannot change the
      // already-applied P5 policy state, gaze execution, or timer lifecycle.
    }
  }

  return {
    updatePresence(next) {
      controller.updatePresence(next);
      attemptActiveProjection();
    },
    updateVisibility(nextVisible) {
      controller.updateVisibility(nextVisible);
    },
    getState() {
      return controller.getState();
    },
    getPreviousPresence() {
      return controller.getPreviousPresence();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lastAttemptedRef = null;
      controller.dispose();
    }
  };
}
