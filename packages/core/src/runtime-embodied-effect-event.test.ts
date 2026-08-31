import { EMBODIED_PRESENTATION_OUTCOME_7K_VERSION } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
  decideRuntimeEmbodiedEffectEvent
} from "./runtime-embodied-effect-event.js";

function behavior() {
  return {
    version: "embodied-behavior-7b.v1",
    behavior: {
      version: "embodied-behavior-7a.v1",
      kind: "EXPRESSION",
      cause: { kind: "user-interaction", reference: "turn-1" },
      intent: "acknowledge-interrupt"
    },
    sourceInstance: { reference: "intent-1", createdAtMs: 100 },
    correlation: { kind: "turn", reference: "turn-1" }
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    version: "runtime-embodied-effect-identity-7g.v1",
    effectId: "runtime-effect:7g:1",
    behavior: behavior(),
    ...overrides
  };
}

function report(outcome: "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED") {
  return {
    version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
    effectId: "runtime-effect:7g:1",
    outcome
  };
}

function eventInput(
  currentState: "ADMITTED" | "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED",
  outcome: "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED",
  overrides: Record<string, unknown> = {}
) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
    identity: identity(),
    report: report(outcome),
    currentEffectId: "runtime-effect:7g:1",
    admittedEffectId: "runtime-effect:7g:1",
    currentState,
    ...overrides
  };
}

describe("Phase 7N Runtime embodied effect canonical event decision", () => {
  it("prepares a canonical event payload only for an applied authoritative transition", () => {
    const decision = decideRuntimeEmbodiedEffectEvent(eventInput("ADMITTED", "STARTED"));

    expect(decision).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
      status: "EVENT_READY",
      payload: {
        version: RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
        effectId: "runtime-effect:7g:1",
        previousState: "ADMITTED",
        state: "STARTED",
        behavior: behavior()
      }
    });
    expect(Object.isFrozen(decision)).toBe(true);
    if (decision.status === "EVENT_READY") {
      expect(Object.isFrozen(decision.payload)).toBe(true);
      expect(Object.isFrozen(decision.payload.behavior)).toBe(true);
    }
  });

  it("preserves safe cause, source-instance, and correlation semantics from 7G", () => {
    const decision = decideRuntimeEmbodiedEffectEvent(eventInput("STARTED", "COMPLETED"));
    expect(decision.status).toBe("EVENT_READY");
    if (decision.status === "EVENT_READY") {
      expect(decision.payload.behavior.behavior.cause).toEqual({
        kind: "user-interaction",
        reference: "turn-1"
      });
      expect(decision.payload.behavior.sourceInstance.reference).toBe("intent-1");
      expect(decision.payload.behavior.correlation).toEqual({ kind: "turn", reference: "turn-1" });
    }
  });

  it("emits NO_EVENT for idempotent duplicate observations", () => {
    expect(decideRuntimeEmbodiedEffectEvent(eventInput("STARTED", "STARTED"))).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_EVENT_7N_VERSION,
      status: "NO_EVENT",
      effectId: "runtime-effect:7g:1"
    });
  });

  it("emits NO_EVENT for stale, unadmitted, or invalid-sequence observations", () => {
    expect(
      decideRuntimeEmbodiedEffectEvent(
        eventInput("ADMITTED", "STARTED", { currentEffectId: "runtime-effect:7g:2" })
      ).status
    ).toBe("NO_EVENT");
    expect(
      decideRuntimeEmbodiedEffectEvent(
        eventInput("ADMITTED", "STARTED", { admittedEffectId: null })
      ).status
    ).toBe("NO_EVENT");
    expect(decideRuntimeEmbodiedEffectEvent(eventInput("ADMITTED", "COMPLETED")).status).toBe(
      "NO_EVENT"
    );
  });

  it("fails closed when 7G identity and 7M transition refer to different effects", () => {
    expect(() =>
      decideRuntimeEmbodiedEffectEvent(
        eventInput("ADMITTED", "STARTED", {
          identity: identity({ effectId: "runtime-effect:7g:2" })
        })
      )
    ).toThrow(/match/);
  });

  it("fully revalidates the correlated behavior before preparing an event", () => {
    expect(() =>
      decideRuntimeEmbodiedEffectEvent(
        eventInput("ADMITTED", "STARTED", {
          identity: identity({
            behavior: {
              ...behavior(),
              device: "live2d"
            }
          })
        })
      )
    ).toThrow();
  });

  it("keeps Runtime effect identity distinct from semantic references", () => {
    expect(() =>
      decideRuntimeEmbodiedEffectEvent(
        eventInput("ADMITTED", "STARTED", {
          identity: identity({ effectId: "turn-1" }),
          report: { ...report("STARTED"), effectId: "turn-1" },
          currentEffectId: "turn-1",
          admittedEffectId: "turn-1"
        })
      )
    ).toThrow(/distinct/);
  });

  it("does not create publication, transport, device, provider, persistence, or Character authority", () => {
    for (const extra of [
      { eventId: "event-1" },
      { timestamp: "2026-08-31T00:00:00Z" },
      { publish: true },
      { eventBus: "runtime" },
      { device: "live2d" },
      { provider: "temporary-renderer" },
      { payload: { motion: "smile.motion3.json" } },
      { memoryTruth: true },
      { characterProposal: { presentation: { intent: "soft-smile" } } }
    ]) {
      expect(() =>
        decideRuntimeEmbodiedEffectEvent(eventInput("ADMITTED", "STARTED", extra))
      ).toThrow(/unknown field/);
    }
  });

  it("fails closed on missing or future 7N version", () => {
    const { version: _version, ...withoutVersion } = eventInput("ADMITTED", "STARTED");
    expect(() => decideRuntimeEmbodiedEffectEvent(withoutVersion)).toThrow(/version/);
    expect(() =>
      decideRuntimeEmbodiedEffectEvent(
        eventInput("ADMITTED", "STARTED", {
          version: "runtime-embodied-effect-event-future.v9"
        })
      )
    ).toThrow(/version/);
  });
});
