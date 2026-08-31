import type { EventBus } from "@companion/event-bus";
import {
  EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
  type RuntimeEvent
} from "@companion/protocol";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
  publishRuntimeEmbodiedEffectEvent
} from "./runtime-embodied-effect-event-publication.js";
import {
  RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION,
  constructRuntimeEmbodiedEffectRuntimeEvent
} from "./runtime-embodied-effect-runtime-event.js";
import { RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION } from "./runtime-embodied-effect-state-commit.js";

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

function identity() {
  return {
    version: "runtime-embodied-effect-identity-7g.v1",
    effectId: "runtime-effect:7g:1",
    behavior: behavior()
  };
}

function snapshot(state: "ADMITTED" | "STARTED") {
  return {
    version: RUNTIME_EMBODIED_EFFECT_STATE_COMMIT_7O_VERSION,
    effectId: "runtime-effect:7g:1",
    state
  };
}

function report(outcome: "STARTED" | "COMPLETED") {
  return {
    version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
    effectId: "runtime-effect:7g:1",
    outcome
  };
}

function constructedDecision() {
  return constructRuntimeEmbodiedEffectRuntimeEvent({
    version: RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION,
    identity: identity(),
    snapshot: snapshot("ADMITTED"),
    report: report("STARTED")
  });
}

function noEventDecision() {
  return constructRuntimeEmbodiedEffectRuntimeEvent({
    version: RUNTIME_EMBODIED_EFFECT_RUNTIME_EVENT_7Q_VERSION,
    identity: identity(),
    snapshot: snapshot("STARTED"),
    report: report("STARTED")
  });
}

function publicationInput(decision: unknown) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
    decision
  };
}

function recordingEventBus() {
  const published: RuntimeEvent[] = [];
  const eventBus: Pick<EventBus, "publish"> = {
    async publish<TEvent extends RuntimeEvent>(event: TEvent): Promise<void> {
      published.push(event);
    }
  };
  return { eventBus, published };
}

describe("Phase 7R Runtime embodied-effect EventBus publication", () => {
  it("publishes exactly one canonical 7Q event after cross-contract revalidation", async () => {
    const { eventBus, published } = recordingEventBus();
    const decision = constructedDecision();
    expect(decision.status).toBe("EVENT_CONSTRUCTED");

    const result = await publishRuntimeEmbodiedEffectEvent(
      publicationInput(decision),
      eventBus
    );

    expect(result).toEqual({
      version: RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
      status: "EVENT_PUBLISHED"
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(published).toHaveLength(1);

    const event = published[0];
    expect(event).toMatchObject({
      type: "runtime.embodied.effect",
      traceId: "turn-1",
      payload: {
        version: "runtime-embodied-effect-event-7n.v1",
        effectId: "runtime-effect:7g:1",
        previousState: "ADMITTED",
        state: "STARTED",
        behavior: behavior()
      }
    });
    expect(Object.isFrozen(event)).toBe(true);
    const payload = event?.payload as Record<string, unknown> | undefined;
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it("publishes nothing for canonical 7Q NO_EVENT", async () => {
    const { eventBus, published } = recordingEventBus();
    const result = await publishRuntimeEmbodiedEffectEvent(
      publicationInput(noEventDecision()),
      eventBus
    );

    expect(result.status).toBe("PUBLISH_SKIPPED");
    expect(published).toHaveLength(0);
  });

  it("fails closed before publication when snapshot, transition, payload, or trace facts disagree", async () => {
    const canonical = constructedDecision();
    expect(canonical.status).toBe("EVENT_CONSTRUCTED");
    if (canonical.status !== "EVENT_CONSTRUCTED") return;

    const cases = [
      {
        ...canonical,
        snapshot: { ...canonical.snapshot, state: "COMPLETED" }
      },
      {
        ...canonical,
        transition: { ...canonical.transition, nextState: "FAILED" }
      },
      {
        ...canonical,
        event: {
          ...canonical.event,
          traceId: "caller-trace"
        }
      },
      {
        ...canonical,
        event: {
          ...canonical.event,
          payload: {
            ...canonical.event.payload,
            behavior: { ...canonical.event.payload.behavior, provider: "renderer" }
          }
        }
      }
    ];

    for (const tampered of cases) {
      const { eventBus, published } = recordingEventBus();
      await expect(
        publishRuntimeEmbodiedEffectEvent(publicationInput(tampered), eventBus)
      ).rejects.toThrow();
      expect(published).toHaveLength(0);
    }
  });

  it("fails closed on wrong event type or future transition version before publication", async () => {
    const canonical = constructedDecision();
    expect(canonical.status).toBe("EVENT_CONSTRUCTED");
    if (canonical.status !== "EVENT_CONSTRUCTED") return;

    for (const tampered of [
      {
        ...canonical,
        event: { ...canonical.event, type: "runtime.error" }
      },
      {
        ...canonical,
        transition: {
          ...canonical.transition,
          version: "runtime-embodied-effect-state-transition-future.v9"
        }
      }
    ]) {
      const { eventBus, published } = recordingEventBus();
      await expect(
        publishRuntimeEmbodiedEffectEvent(publicationInput(tampered), eventBus)
      ).rejects.toThrow();
      expect(published).toHaveLength(0);
    }
  });

  it("propagates EventBus failure after one publish attempt and never retries", async () => {
    const failure = new Error("event bus unavailable");
    let calls = 0;
    const eventBus: Pick<EventBus, "publish"> = {
      async publish<TEvent extends RuntimeEvent>(_event: TEvent): Promise<void> {
        calls += 1;
        throw failure;
      }
    };

    await expect(
      publishRuntimeEmbodiedEffectEvent(publicationInput(constructedDecision()), eventBus)
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it("rejects malformed 7R/7Q envelopes and NO_EVENT decisions that smuggle an event", async () => {
    const { eventBus, published } = recordingEventBus();

    await expect(
      publishRuntimeEmbodiedEffectEvent(
        {
          version: "runtime-embodied-effect-event-publication-future.v9",
          decision: noEventDecision()
        },
        eventBus
      )
    ).rejects.toThrow(/version/);

    const noEvent = noEventDecision();
    expect(noEvent.status).toBe("NO_EVENT");
    await expect(
      publishRuntimeEmbodiedEffectEvent(
        publicationInput({ ...noEvent, event: { type: "runtime.embodied.effect" } }),
        eventBus
      )
    ).rejects.toThrow();

    await expect(
      publishRuntimeEmbodiedEffectEvent(
        publicationInput({ ...noEvent, version: "runtime-embodied-effect-runtime-event-future.v9" }),
        eventBus
      )
    ).rejects.toThrow(/7Q/);

    expect(published).toHaveLength(0);
  });

  it("does not accept publication policy, persistence, Presentation, or execution authority", async () => {
    for (const extra of [
      { retry: true },
      { persist: true },
      { device: "live2d" },
      { provider: "renderer" },
      { memoryTruth: true },
      { presentationAuthority: true }
    ]) {
      const { eventBus, published } = recordingEventBus();
      await expect(
        publishRuntimeEmbodiedEffectEvent(
          {
            version: RUNTIME_EMBODIED_EFFECT_EVENT_PUBLICATION_7R_VERSION,
            decision: constructedDecision(),
            ...extra
          },
          eventBus
        )
      ).rejects.toThrow(/unknown field/);
      expect(published).toHaveLength(0);
    }
  });
});
