import type { EventBus } from "@companion/event-bus";
import { CHARACTER_HARNESS_5D_VERSION } from "@companion/character-harness";
import {
  EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
  createEvent,
  type RuntimeEvent
} from "@companion/protocol";
import { describe, expect, it } from "vitest";
import { composeServerCharacterSoftSmileEmbodiedEffect } from "./character-embodied-soft-smile-composition.js";
import { applyServerEmbodiedPresentationOutcome } from "./embodied-effect-lifecycle-composition.js";

function admittedRecord() {
  const initialized = composeServerCharacterSoftSmileEmbodiedEffect(
    {
      version: CHARACTER_HARNESS_5D_VERSION,
      status: "ACCEPTED",
      proposal: {
        disposition: "RESPOND",
        text: "hello",
        presentation: { intent: "soft-smile" }
      }
    },
    { kind: "turn", reference: "turn-7aa-1" },
    {
      allocateProposalInstance: () => ({
        reference: "character-proposal-7aa-1",
        createdAtMs: 700
      }),
      allocateEffectId: () => "runtime-effect-7aa-1",
      policyAllowsEmbodiedEffect: () => true
    }
  );

  if (initialized?.status !== "RECORD_INITIALIZED") {
    throw new Error("Expected one admitted Character soft-smile effect record.");
  }
  return initialized.record;
}

function report(
  outcome: "STARTED" | "COMPLETED",
  effectId = "runtime-effect-7aa-1"
) {
  return {
    version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
    effectId,
    outcome
  } as const;
}

function traceAnchor(traceId = "runtime-trace-7aa-1") {
  return createEvent(
    "user.message",
    { sessionId: "session-7aa-1", content: "hello" },
    { traceId }
  );
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

describe("server embodied-effect lifecycle composition", () => {
  it("threads the admitted Character soft-smile record through Runtime lifecycle and trace-bound publication", async () => {
    const admitted = admittedRecord();
    const anchor = traceAnchor();
    const { eventBus, published } = recordingEventBus();

    const result = await applyServerEmbodiedPresentationOutcome(
      admitted,
      report("STARTED"),
      eventBus,
      anchor
    );

    expect(result.advancement.status).toBe("RECORD_ADVANCED");
    if (result.advancement.status !== "RECORD_ADVANCED") {
      throw new Error("Expected Runtime record advancement.");
    }
    expect(result.advancement.record.snapshot).toEqual({
      version: "runtime-embodied-effect-state-commit-7o.v1",
      effectId: "runtime-effect-7aa-1",
      state: "STARTED"
    });
    expect(result.publication).toEqual({
      version: "runtime-embodied-effect-event-publication-7r.v1",
      status: "EVENT_PUBLISHED"
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "runtime.embodied.effect",
      traceId: anchor.traceId,
      parentId: anchor.id,
      payload: {
        effectId: "runtime-effect-7aa-1",
        previousState: "ADMITTED",
        state: "STARTED",
        behavior: {
          behavior: {
            kind: "EXPRESSION",
            cause: {
              kind: "character",
              reference: "character-proposal-7aa-1"
            },
            intent: "soft-smile"
          },
          sourceInstance: {
            reference: "character-proposal-7aa-1",
            createdAtMs: 700
          },
          correlation: {
            kind: "turn",
            reference: "turn-7aa-1"
          }
        }
      }
    });
    expect(published[0]?.traceId).not.toBe("turn-7aa-1");
    expect(Object.isFrozen(result)).toBe(true);
    expect(admitted.snapshot.state).toBe("ADMITTED");
  });

  it("keeps stale Presentation reports fenced and publication-free without requiring a trace anchor", async () => {
    const admitted = admittedRecord();
    const { eventBus, published } = recordingEventBus();

    const result = await applyServerEmbodiedPresentationOutcome(
      admitted,
      report("STARTED", "runtime-effect-stale"),
      eventBus
    );

    expect(result.advancement.status).toBe("RECORD_UNCHANGED");
    expect(result.advancement.record.snapshot.state).toBe("ADMITTED");
    expect(result.advancement.decision.status).toBe("NO_EVENT");
    expect(result.publication).toEqual({
      version: "runtime-embodied-effect-event-publication-7r.v1",
      status: "PUBLISH_SKIPPED"
    });
    expect(published).toHaveLength(0);
  });

  it("requires a real Runtime trace anchor before publishing an applied transition", async () => {
    const admitted = admittedRecord();
    const { eventBus, published } = recordingEventBus();

    await expect(
      applyServerEmbodiedPresentationOutcome(
        admitted,
        report("STARTED"),
        eventBus
      )
    ).rejects.toThrow(/trace anchor/);

    expect(published).toHaveLength(0);
    expect(admitted.snapshot.state).toBe("ADMITTED");
  });

  it("propagates EventBus failure without retry or returning an advanced authoritative record", async () => {
    const admitted = admittedRecord();
    let publishCalls = 0;
    const eventBus: Pick<EventBus, "publish"> = {
      async publish(): Promise<void> {
        publishCalls += 1;
        throw new Error("event bus unavailable");
      }
    };

    await expect(
      applyServerEmbodiedPresentationOutcome(
        admitted,
        report("STARTED"),
        eventBus,
        traceAnchor()
      )
    ).rejects.toThrow("event bus unavailable");

    expect(publishCalls).toBe(1);
    expect(admitted.snapshot.state).toBe("ADMITTED");
  });

  it("does not let Presentation inject Runtime trace or publication metadata", async () => {
    const admitted = admittedRecord();
    const { eventBus, published } = recordingEventBus();

    await expect(
      applyServerEmbodiedPresentationOutcome(
        admitted,
        {
          ...report("STARTED"),
          traceId: "turn-7aa-1",
          parentId: "presentation-parent",
          publish: true
        } as never,
        eventBus,
        traceAnchor()
      )
    ).rejects.toThrow(/unrecognized_keys/);

    expect(published).toHaveLength(0);
    expect(admitted.snapshot.state).toBe("ADMITTED");
  });
});
