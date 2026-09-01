import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
  initializeRuntimeEmbodiedEffectRecord,
  type RuntimeEmbodiedEffectRecordInitializationDecision
} from "./runtime-embodied-effect-record-initialization.js";
import {
  RUNTIME_EMBODIED_PRESENTATION_REQUEST_PROJECTION_7AE_VERSION,
  projectRuntimeEmbodiedEffectAdmissionToPresentationRequest
} from "./runtime-embodied-presentation-request-projection.js";

function behavior() {
  return {
    version: "embodied-behavior-7b.v1",
    behavior: {
      version: "embodied-behavior-7a.v1",
      kind: "EXPRESSION",
      cause: { kind: "character", reference: "character-decision:7ae:1" },
      intent: "soft-smile"
    },
    sourceInstance: { reference: "character-proposal:7ae:1", createdAtMs: 1000 },
    correlation: { kind: "turn", reference: "turn:7ae:1" }
  };
}

function initialize(policyAllowsEmbodiedEffect: boolean) {
  return initializeRuntimeEmbodiedEffectRecord({
    version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
    identity: {
      version: "runtime-embodied-effect-identity-7g.v1",
      effectId: "runtime-effect:7ae:1",
      behavior: behavior()
    },
    policyAllowsEmbodiedEffect
  });
}

describe("Phase 7AE Runtime embodied Presentation request projection", () => {
  it("projects only an admitted 7T record into canonical 7AD transport", () => {
    const decision = initialize(true);
    const result = projectRuntimeEmbodiedEffectAdmissionToPresentationRequest(decision);

    expect(result).toEqual({
      version: RUNTIME_EMBODIED_PRESENTATION_REQUEST_PROJECTION_7AE_VERSION,
      status: "REQUEST_CREATED",
      request: {
        version: "embodied-presentation-request-7ad.v1",
        effectId: "runtime-effect:7ae:1",
        behavior: behavior()
      }
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== "REQUEST_CREATED") return;
    expect(Object.isFrozen(result.request)).toBe(true);
    expect(Object.isFrozen(result.request.behavior)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("traceId");
    expect(JSON.stringify(result)).not.toContain("device");
    expect(JSON.stringify(result)).not.toContain("provider");
    expect(JSON.stringify(result)).not.toContain("snapshot");
    expect(JSON.stringify(result)).not.toContain("admission");
  });

  it("creates no Presentation request when 7T admission rejected the effect", () => {
    const decision = initialize(false);
    const result = projectRuntimeEmbodiedEffectAdmissionToPresentationRequest(decision);

    expect(result).toEqual({
      version: RUNTIME_EMBODIED_PRESENTATION_REQUEST_PROJECTION_7AE_VERSION,
      status: "REQUEST_NOT_CREATED",
      effectId: "runtime-effect:7ae:1",
      reason: "EFFECT_NOT_ADMITTED"
    });
    expect(result).not.toHaveProperty("request");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("fails closed if an alleged admitted decision no longer has an ADMITTED snapshot", () => {
    const decision = initialize(true);
    expect(decision.status).toBe("RECORD_INITIALIZED");
    if (decision.status !== "RECORD_INITIALIZED") return;

    const forged = {
      ...decision,
      record: {
        ...decision.record,
        snapshot: { ...decision.record.snapshot, state: "STARTED" }
      }
    } as unknown as RuntimeEmbodiedEffectRecordInitializationDecision;

    expect(() => projectRuntimeEmbodiedEffectAdmissionToPresentationRequest(forged)).toThrow(
      /ADMITTED 7O snapshot/
    );
  });

  it("fails closed on effect-ID disagreement across 7T/7S/7O authority chain", () => {
    const decision = initialize(true);
    expect(decision.status).toBe("RECORD_INITIALIZED");
    if (decision.status !== "RECORD_INITIALIZED") return;

    const forged = {
      ...decision,
      record: {
        ...decision.record,
        snapshot: { ...decision.record.snapshot, effectId: "runtime-effect:other" }
      }
    } as unknown as RuntimeEmbodiedEffectRecordInitializationDecision;

    expect(() => projectRuntimeEmbodiedEffectAdmissionToPresentationRequest(forged)).toThrow(
      /identity is inconsistent/
    );
  });

  it("rejects malformed or future 7T decision identity instead of treating 7AD as admission proof", () => {
    expect(() =>
      projectRuntimeEmbodiedEffectAdmissionToPresentationRequest({
        version: "runtime-embodied-effect-record-initialization-future.v9",
        status: "RECORD_INITIALIZED"
      } as unknown as RuntimeEmbodiedEffectRecordInitializationDecision)
    ).toThrow(/canonical 7T decision/);
  });
});
