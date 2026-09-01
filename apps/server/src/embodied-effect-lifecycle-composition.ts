import type { EventBus } from "@companion/event-bus";
import {
  RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
  RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION,
  advanceRuntimeEmbodiedEffectRecord,
  publishRuntimeEmbodiedEffectEvent,
  type RuntimeEmbodiedEffectEventPublicationResult,
  type RuntimeEmbodiedEffectRecord,
  type RuntimeEmbodiedEffectRecordAdvancementDecision
} from "@companion/core";
import type {
  EmbodiedPresentationOutcomeReport,
  RuntimeEvent
} from "@companion/protocol";

export type ServerEmbodiedEffectLifecycleResult = Readonly<{
  advancement: RuntimeEmbodiedEffectRecordAdvancementDecision;
  publication: RuntimeEmbodiedEffectEventPublicationResult;
}>;

/**
 * Apply one Presentation outcome at the server Runtime composition boundary.
 *
 * The existing 7U reducer remains the sole lifecycle acceptance/state/event
 * construction authority, including its 7L/7H stale-effect fence. The existing
 * 7R adapter remains the sole EventBus publication and Runtime trace-binding
 * authority. This seam only composes those two already-canonical decisions so a
 * caller cannot accidentally publish a Presentation report directly.
 *
 * A trace anchor is optional only because canonical 7U NO_EVENT decisions are
 * intentionally publication-free. Any applied transition still requires 7R to
 * validate a distinct existing RuntimeEvent trace anchor before EventBus I/O.
 *
 * This function does not invoke Presentation, retain an active-effect store,
 * allocate effect identity, re-run admission, execute/cancel/retry, map semantic
 * intent to a device/clip, persist state, or create Memory/P8 truth.
 */
export async function applyServerEmbodiedPresentationOutcome(
  record: RuntimeEmbodiedEffectRecord,
  report: EmbodiedPresentationOutcomeReport,
  eventBus: Pick<EventBus, "publish">,
  traceAnchor?: RuntimeEvent
): Promise<ServerEmbodiedEffectLifecycleResult> {
  const advancement = advanceRuntimeEmbodiedEffectRecord({
    version: RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION,
    record,
    report
  });

  const publication = await publishRuntimeEmbodiedEffectEvent(
    {
      version: RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
      decision: advancement.decision,
      ...(traceAnchor === undefined ? {} : { traceAnchor })
    },
    eventBus
  );

  return Object.freeze({ advancement, publication });
}
