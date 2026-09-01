import {
  EMBODIED_PRESENTATION_REQUEST_7AD_VERSION,
  createEmbodiedPresentationRequest,
  type EmbodiedPresentationRequest
} from "@companion/protocol";
import {
  RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
  type RuntimeEmbodiedEffectRecordInitializationDecision
} from "./runtime-embodied-effect-record-initialization.js";
import { RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION } from "./runtime-embodied-effect-snapshot-initialization.js";
import { RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION } from "./runtime-embodied-effect-state-commit.js";

export const RUNTIME_EMBODIED_PRESENTATION_REQUEST_PROJECTION_7AE_VERSION =
  "runtime-embodied-presentation-request-projection-7ae.v1" as const;

export type RuntimeEmbodiedPresentationRequestProjection =
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_PRESENTATION_REQUEST_PROJECTION_7AE_VERSION;
      status: "REQUEST_CREATED";
      request: EmbodiedPresentationRequest;
    }>
  | Readonly<{
      version: typeof RUNTIME_EMBODIED_PRESENTATION_REQUEST_PROJECTION_7AE_VERSION;
      status: "REQUEST_NOT_CREATED";
      effectId: string;
      reason: "EFFECT_NOT_ADMITTED";
    }>;

/**
 * Project one existing 7T admission decision into the device-neutral 7AD
 * Presentation request boundary.
 *
 * Admission authority remains entirely upstream in 7I -> 7S -> 7T. A rejected
 * 7T decision cannot produce a request. An admitted decision is checked for the
 * expected ADMITTED snapshot and effect-ID consistency before the canonical 7AD
 * factory is invoked.
 *
 * This seam does not admit or advance an effect, construct Runtime traces,
 * publish lifecycle events, invoke Presentation, select a renderer/device,
 * execute/cancel work, or accept Presentation outcomes.
 */
export function projectRuntimeEmbodiedEffectAdmissionToPresentationRequest(
  input: RuntimeEmbodiedEffectRecordInitializationDecision
): RuntimeEmbodiedPresentationRequestProjection {
  if (
    typeof input !== "object" ||
    input === null ||
    input.version !== RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION
  ) {
    throw new Error("Runtime embodied Presentation projection requires a canonical 7T decision.");
  }

  if (input.status === "RECORD_NOT_CREATED") {
    if (
      input.initialization.version !== RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION ||
      input.initialization.status !== "SNAPSHOT_NOT_CREATED" ||
      input.initialization.admission.status !== "REJECTED" ||
      input.initialization.admission.effectId !== input.effectId
    ) {
      throw new Error("Rejected Runtime embodied effect decision is inconsistent.");
    }

    return Object.freeze({
      version: RUNTIME_EMBODIED_PRESENTATION_REQUEST_PROJECTION_7AE_VERSION,
      status: "REQUEST_NOT_CREATED",
      effectId: input.effectId,
      reason: "EFFECT_NOT_ADMITTED"
    });
  }

  if (input.status !== "RECORD_INITIALIZED") {
    throw new Error("Runtime embodied Presentation projection decision status is invalid.");
  }

  const { record, initialization } = input;
  if (record.version !== RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION) {
    throw new Error("Runtime embodied Presentation projection requires a canonical 7T record.");
  }
  if (
    initialization.version !== RUNTIME_EMBODIED_EFFECT_SNAPSHOT_INITIALIZATION_7S_VERSION ||
    initialization.status !== "SNAPSHOT_INITIALIZED" ||
    initialization.admission.status !== "ADMITTED"
  ) {
    throw new Error("Runtime embodied Presentation projection requires admitted 7S initialization.");
  }
  if (
    record.snapshot.version !== RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION ||
    record.snapshot.state !== "ADMITTED"
  ) {
    throw new Error("Runtime embodied Presentation projection requires an ADMITTED 7O snapshot.");
  }

  const effectId = record.identity.effectId;
  if (
    record.snapshot.effectId !== effectId ||
    initialization.snapshot.effectId !== effectId ||
    initialization.snapshot.state !== "ADMITTED" ||
    initialization.admission.effectId !== effectId
  ) {
    throw new Error("Runtime embodied Presentation projection effect identity is inconsistent.");
  }

  const request = createEmbodiedPresentationRequest({
    version: EMBODIED_PRESENTATION_REQUEST_7AD_VERSION,
    effectId,
    behavior: record.identity.behavior
  });

  return Object.freeze({
    version: RUNTIME_EMBODIED_PRESENTATION_REQUEST_PROJECTION_7AE_VERSION,
    status: "REQUEST_CREATED",
    request
  });
}
