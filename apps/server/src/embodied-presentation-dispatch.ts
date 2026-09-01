import {
  projectRuntimeEmbodiedEffectAdmissionToPresentationRequest,
  type RuntimeEmbodiedEffectRecordInitializationDecision
} from "@companion/core";
import type { EmbodiedPresentationRequest } from "@companion/protocol";

export const SERVER_EMBODIED_PRESENTATION_DISPATCH_7AG_VERSION =
  "server-embodied-presentation-dispatch-7ag.v1" as const;

export type ServerEmbodiedPresentationDispatchResult = Readonly<
  | {
      version: typeof SERVER_EMBODIED_PRESENTATION_DISPATCH_7AG_VERSION;
      status: "REQUEST_DISPATCHED";
      request: EmbodiedPresentationRequest;
    }
  | {
      version: typeof SERVER_EMBODIED_PRESENTATION_DISPATCH_7AG_VERSION;
      status: "REQUEST_NOT_DISPATCHED";
      effectId: string;
      reason: "EFFECT_NOT_ADMITTED";
    }
>;

/**
 * Deliver one already-admitted Runtime effect to the Presentation transport.
 *
 * 7AE remains the only request projector and Runtime admission remains
 * upstream. The dispatcher receives no device/provider data and owns no
 * lifecycle, cancellation, retry, publication, or outcome authority.
 */
export function dispatchServerEmbodiedPresentationRequest(
  decision: RuntimeEmbodiedEffectRecordInitializationDecision,
  dispatch: (request: EmbodiedPresentationRequest) => void
): ServerEmbodiedPresentationDispatchResult {
  if (typeof dispatch !== "function") {
    throw new Error("Server embodied Presentation dispatcher must be a function.");
  }

  const projection = projectRuntimeEmbodiedEffectAdmissionToPresentationRequest(decision);
  if (projection.status === "REQUEST_NOT_CREATED") {
    return Object.freeze({
      version: SERVER_EMBODIED_PRESENTATION_DISPATCH_7AG_VERSION,
      status: "REQUEST_NOT_DISPATCHED",
      effectId: projection.effectId,
      reason: projection.reason
    });
  }

  dispatch(projection.request);
  return Object.freeze({
    version: SERVER_EMBODIED_PRESENTATION_DISPATCH_7AG_VERSION,
    status: "REQUEST_DISPATCHED",
    request: projection.request
  });
}
