import { EMBODIED_PRESENTATION_OUTCOME_7K_VERSION } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION,
  constructRuntimeEmbodiedEffectRuntimeEvent
} from "./runtime-embodied-effect-runtime-event.js";
import { RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION } from "./runtime-embodied-effect-state-commit.js";

function behavior(
  correlationKind: "turn" | "session" | "decision" = "turn",
  correlationReference = "turn-1"
) {
  return {
    version: "embodied-behavior-7b.v1",
    behavior: {
      version: "embodied-behavior-7a.v1",
      kind: "EXPRESSION",
      cause: { kind: "user-interaction", reference: "turn-1" },
      intent: "acknowledge-interrupt"
    },
    sourceInstance: { reference: "intent-1", createdAtMs: 100 },
    correlation: { kind: correlationKind, reference: correlationReference }
  };
}

function identity(
  effectId = "runtime-effect:7g:1",
  correlatedBehavior: ReturnType<typeof behavior> = behavior()
) {
  return {
    version: "runtime-embodied-effect-identity-7g.v1",
    effectId,
    behavior: correlatedBehavior
  };
}

function snapshot(
  state: "ADMITTED" | "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED"
) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
    effectId: "runtime-effect:7g:1",
    state
  };
}

function report(
  outcome: "STARTED" | "COMPLETED" | "REJECTED" | "FAILED" | "INTERRUPTED",
  effectId = "runtime-effect:7g:1"
) {
  return {
    version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
    effectId,
    outcome
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION,
    identity: identity(),
    snapshot: snapshot("ADMITTED"),
    report: report("STARTED"),
    ...overrides
  };
}

describe("Phase 7Q Runtime embodied-effect RuntimeEvent construction", () => {
  it("constructs one canonical self-traced RuntimeEvent only after a committed state update", () => {
    const decision = constructRuntimeEmbodiedEffectRuntimeEvent(input());

    expect(decision.status).toBe("EVENT_CONSTRUCTED");
    if (decision.status !== "EVENT_CONSTRUCTED") return;

    expect(decision.snapshot).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
      effectId: "runtime-effect:7g:1",
      state: "STARTED"
    });
    expect(decision.transition).toMatchObject({
      status: "TRANSITION_APPLIED",
      previousState: "ADMITTED",
      nextState: "STARTED"
    });
    expect(decision.event.type).toBe("runtime.embodied.effect");
    expect(decision.event.traceId).toBe(decision.event.id);
    expect(decision.event.traceId).not.toBe("turn-1");
    expect(decision.event).not.toHaveProperty("parentId");
    expect(decision.event.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(decision.event.timestamp))).toBe(false);
    expect(decision.event.payload).toEqual({
      version: "runtime-embodied-effect-event-7n.v1",
      effectId: "runtime-effect:7g:1",
      previousState: "ADMITTED",
      state: "STARTED",
      behavior: behavior()
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.event)).toBe(true);
    expect(Object.isFrozen(decision.event.payload)).toBe(true);
  });

  it("keeps turn, session, and decision correlation payload-only until Runtime trace binding", () => {
    for (const [kind, reference] of [
      ["turn", "turn-1"],
      ["session", "session-1"],
      ["decision", "decision-1"]
    ] as const) {
      const correlatedBehavior = behavior(kind, reference);
      const decision = constructRuntimeEmbodiedEffectRuntimeEvent(
        input({ identity: identity("runtime-effect:7g:1", correlatedBehavior) })
      );

      expect(decision.status).toBe("EVENT_CONSTRUCTED");
      if (decision.status !== "EVENT_CONSTRUCTED") continue;
      expect(decision.event.traceId).toBe(decision.event.id);
      expect(decision.event.traceId).not.toBe(reference);
      expect(decision.event.payload.behavior.correlation).toEqual({ kind, reference });
      expect(decision.event).not.toHaveProperty("parentId");
    }
  });

  it("returns NO_EVENT for a duplicate observation without constructing an event", () => {
    const decision = constructRuntimeEmbodiedEffectRuntimeEvent(
      input({ snapshot: snapshot("STARTED"), report: report("STARTED") })
    );

    expect(decision).toMatchObject({
      status: "NO_EVENT",
      snapshot: { state: "STARTED" },
      transition: { status: "TRANSITION_NO_CHANGE", state: "STARTED" }
    });
    expect(decision).not.toHaveProperty("event");
  });

  it("returns NO_EVENT for stale and invalid-sequence reports without escalating identity mismatch", () => {
    const stale = constructRuntimeEmbodiedEffectRuntimeEvent(
      input({
        snapshot: snapshot("STARTED"),
        report: report("COMPLETED", "runtime-effect:7g:2")
      })
    );
    expect(stale).toMatchObject({
      status: "NO_EVENT",
      snapshot: { effectId: "runtime-effect:7g:1", state: "STARTED" },
      transition: { status: "TRANSITION_REJECTED", reason: "OBSERVATION_NOT_ACCEPTED" }
    });

    const invalid = constructRuntimeEmbodiedEffectRuntimeEvent(
      input({ snapshot: snapshot("ADMITTED"), report: report("COMPLETED") })
    );
    expect(invalid).toMatchObject({
      status: "NO_EVENT",
      snapshot: { state: "ADMITTED" },
      transition: { status: "TRANSITION_REJECTED", reason: "INVALID_SEQUENCE" }
    });
  });

  it("fails closed when an applied transition uses a mismatched 7G identity", () => {
    expect(() =>
      constructRuntimeEmbodiedEffectRuntimeEvent(
        input({ identity: identity("runtime-effect:7g:2") })
      )
    ).toThrow(/match/);
  });

  it("does not accept caller-owned event metadata, publication, or execution authority", () => {
    for (const extra of [
      { eventId: "event-1" },
      { timestamp: "2026-09-01T00:00:00Z" },
      { traceId: "caller-trace" },
      { parentId: "event-parent" },
      { publish: true },
      { eventBus: "runtime" },
      { device: "live2d" },
      { provider: "temporary-renderer" },
      { memoryTruth: true }
    ]) {
      expect(() =>
        constructRuntimeEmbodiedEffectRuntimeEvent(input(extra))
      ).toThrow(/unknown field/);
    }
  });

  it("fails closed on malformed snapshot/report/identity or future version", () => {
    expect(() =>
      constructRuntimeEmbodiedEffectRuntimeEvent(
        input({ snapshot: { ...snapshot("ADMITTED"), state: "RUNNING" } })
      )
    ).toThrow();
    expect(() =>
      constructRuntimeEmbodiedEffectRuntimeEvent(
        input({ report: { ...report("STARTED"), device: "live2d" } })
      )
    ).toThrow();
    expect(() =>
      constructRuntimeEmbodiedEffectRuntimeEvent(
        input({ identity: { ...identity(), provider: "renderer" } })
      )
    ).toThrow();
    expect(() =>
      constructRuntimeEmbodiedEffectRuntimeEvent(
        input({ version: "runtime-embodied-effect-runtime-event-future.v9" })
      )
    ).toThrow(/version/);
  });
});
