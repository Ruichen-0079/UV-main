import type { EventBus } from "@companion/event-bus";
import type {
  EmbodiedPresentationOutcomeReport,
  EmbodiedPresentationRequest,
  RuntimeEvent
} from "@companion/protocol";
import { projectRuntimeEmbodiedEffectAdmissionToPresentationRequest } from "./runtime-embodied-presentation-request-projection.js";
import type { RuntimeEmbodiedEffectRecordInitializationDecision } from "./runtime-embodied-effect-record-initialization.js";
import {
  RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION,
  advanceRuntimeEmbodiedEffectRecord,
  type RuntimeEmbodiedEffectRecordAdvancementDecision
} from "./runtime-embodied-effect-record-advancement.js";
import {
  RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
  publishRuntimeEmbodiedEffectEvent,
  type RuntimeEmbodiedEffectEventPublicationResult
} from "./runtime-embodied-effect-event-publication.js";

export const RUNTIME_EMBODIED_PRESENTATION_EXECUTION_7AK_VERSION =
  "runtime-embodied-presentation-execution-7ak.v1" as const;

export type RuntimeEmbodiedPresentationExecutionResult = Readonly<
  | {
      version: typeof RUNTIME_EMBODIED_PRESENTATION_EXECUTION_7AK_VERSION;
      status: "REQUEST_NOT_DISPATCHED";
      effectId: string;
      reason: "EFFECT_NOT_ADMITTED";
    }
  | {
      version: typeof RUNTIME_EMBODIED_PRESENTATION_EXECUTION_7AK_VERSION;
      status: "OUTCOME_APPLIED";
      request: EmbodiedPresentationRequest;
      report: EmbodiedPresentationOutcomeReport;
      advancement: RuntimeEmbodiedEffectRecordAdvancementDecision;
      publication: RuntimeEmbodiedEffectEventPublicationResult;
    }
>;

/**
 * Runtime-owned execution composition for one admitted embodied effect.
 *
 * Runtime gates projection, invokes the downstream Presentation port, then
 * accepts the returned observation through the existing immutable lifecycle
 * reducer and canonical publisher. The Presentation port cannot provide an
 * effect ID, lifecycle state, trace, or publication result.
 */
export async function executeRuntimeEmbodiedPresentation(
  decision: RuntimeEmbodiedEffectRecordInitializationDecision,
  traceAnchor: RuntimeEvent,
  present: (
    request: EmbodiedPresentationRequest,
    traceAnchor: RuntimeEvent
  ) => EmbodiedPresentationOutcomeReport | Promise<EmbodiedPresentationOutcomeReport>,
  eventBus: Pick<EventBus, "publish">
): Promise<RuntimeEmbodiedPresentationExecutionResult> {
  if (typeof present !== "function") {
    throw new Error("Runtime embodied Presentation execution requires a Presentation port.");
  }

  const projection = projectRuntimeEmbodiedEffectAdmissionToPresentationRequest(decision);
  if (projection.status === "REQUEST_NOT_CREATED") {
    return Object.freeze({
      version: RUNTIME_EMBODIED_PRESENTATION_EXECUTION_7AK_VERSION,
      status: "REQUEST_NOT_DISPATCHED",
      effectId: projection.effectId,
      reason: projection.reason
    });
  }

  if (decision.status !== "RECORD_INITIALIZED") {
    throw new Error(
      "Runtime embodied Presentation projection produced an invalid admitted decision."
    );
  }

  const report = await present(projection.request, traceAnchor);
  const advancement = advanceRuntimeEmbodiedEffectRecord({
    version: RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION,
    record: decision.record,
    report
  });
  const publication = await publishRuntimeEmbodiedEffectEvent(
    {
      version: RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
      decision: advancement.decision,
      traceAnchor
    },
    eventBus
  );

  return Object.freeze({
    version: RUNTIME_EMBODIED_PRESENTATION_EXECUTION_7AK_VERSION,
    status: "OUTCOME_APPLIED",
    request: projection.request,
    report,
    advancement,
    publication
  });
}
