import { describe, expect, it } from "vitest";
import {
  EMBODIED_PRESENTATION_REQUEST_7AD_VERSION,
  EmbodiedPresentationRequestSchema,
  createEmbodiedPresentationRequest
} from "./embodied-presentation-request.js";

function request() {
  return {
    version: EMBODIED_PRESENTATION_REQUEST_7AD_VERSION,
    effectId: "runtime-effect:7ad:1",
    behavior: {
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "EXPRESSION",
        cause: {
          kind: "character",
          reference: "character-decision:7ad:1"
        },
        intent: "soft-smile"
      },
      sourceInstance: {
        reference: "character-proposal:7ad:1",
        createdAtMs: 1000
      },
      correlation: {
        kind: "turn",
        reference: "turn:7ad:1"
      }
    }
  } as const;
}

describe("Phase 7AD embodied Presentation request", () => {
  it("canonicalizes device-neutral execution identity plus 7B semantics", () => {
    const value = createEmbodiedPresentationRequest(request());

    expect(value).toEqual(request());
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.behavior)).toBe(true);
    expect(Object.isFrozen(value.behavior.behavior)).toBe(true);
    expect(Object.isFrozen(value.behavior.sourceInstance)).toBe(true);
    expect(Object.isFrozen(value.behavior.correlation)).toBe(true);
  });

  it.each(["", " leading-space", "runtime/effect/1", "x".repeat(201)])(
    "rejects invalid Runtime effect identity %j",
    (effectId) => {
      expect(
        EmbodiedPresentationRequestSchema.safeParse({ ...request(), effectId }).success
      ).toBe(false);
    }
  );

  it.each([
    "character-decision:7ad:1",
    "character-proposal:7ad:1",
    "turn:7ad:1"
  ])("rejects effectId aliasing semantic reference %s", (effectId) => {
    expect(
      EmbodiedPresentationRequestSchema.safeParse({ ...request(), effectId }).success
    ).toBe(false);
  });

  it("does not let transport shape claim Runtime admission or lifecycle authority", () => {
    for (const extra of [
      { admitted: true },
      { runtimeState: "ADMITTED" },
      { traceId: "runtime-trace:7ad:1" },
      { eventId: "runtime-event:7ad:1" },
      { publish: true },
      { authoritative: true }
    ]) {
      expect(
        EmbodiedPresentationRequestSchema.safeParse({ ...request(), ...extra }).success
      ).toBe(false);
    }
  });

  it("does not expose renderer, device, provider, clip, or raw execution payload", () => {
    for (const extra of [
      { device: "live2d" },
      { renderer: "cubism" },
      { provider: "temporary-renderer" },
      { clip: "smile.motion3.json" },
      { payload: { parameter: "ParamMouthForm" } }
    ]) {
      expect(
        EmbodiedPresentationRequestSchema.safeParse({ ...request(), ...extra }).success
      ).toBe(false);
    }
  });

  it("fails closed on future versions and non-canonical 7B behavior", () => {
    expect(
      EmbodiedPresentationRequestSchema.safeParse({
        ...request(),
        version: "embodied-presentation-request-future.v9"
      }).success
    ).toBe(false);
    expect(
      EmbodiedPresentationRequestSchema.safeParse({
        ...request(),
        behavior: {
          ...request().behavior,
          traceId: "not-allowed"
        }
      }).success
    ).toBe(false);
  });
});
