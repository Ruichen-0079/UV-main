import {
  createCorrelatedEmbodiedBehavior,
  createEmbodiedPresentationOutcomeReport,
  createEvent,
  type EmbodiedPresentationRequest,
  type RuntimeEvent
} from "@companion/protocol";
import type { EventBus } from "@companion/event-bus";
import { describe, expect, it, vi } from "vitest";
import { allocateRuntimeEmbodiedEffectIdentity } from "./runtime-embodied-effect-identity.js";
import { initializeRuntimeEmbodiedEffectRecord } from "./runtime-embodied-effect-record-initialization.js";
import { executeRuntimeEmbodiedPresentation } from "./runtime-embodied-presentation-execution.js";

function decision(policyAllowsEmbodiedEffect: boolean) {
  const behavior = createCorrelatedEmbodiedBehavior({
    version: "embodied-behavior-7b.v1",
    behavior: {
      version: "embodied-behavior-7a.v1",
      kind: "GAZE",
      cause: { kind: "attention", reference: "cause:7ak:1" },
      target: "user",
      strength: 1
    },
    sourceInstance: { reference: "source:7ak:1", createdAtMs: 1 },
    correlation: { kind: "turn", reference: "turn:7ak:1" }
  });
  return initializeRuntimeEmbodiedEffectRecord({
    version: "runtime-embodied-effect-record-initialization-7t.v1",
    identity: allocateRuntimeEmbodiedEffectIdentity(behavior, () => "runtime-effect:7ak:1"),
    policyAllowsEmbodiedEffect
  });
}

function anchor() {
  return createEvent("user.message", { sessionId: "session:7ak", content: "hello" });
}

describe("Runtime embodied Presentation execution", () => {
  it("invokes Presentation only after admission and publishes the applied STARTED lifecycle", async () => {
    const present = vi.fn(async (request: EmbodiedPresentationRequest) =>
      createEmbodiedPresentationOutcomeReport({
        version: "embodied-presentation-outcome-7k.v1",
        effectId: request.effectId,
        outcome: "STARTED"
      })
    );
    const published: RuntimeEvent[] = [];
    const traceAnchor = anchor();
    const result = await executeRuntimeEmbodiedPresentation(
      decision(true) as Extract<ReturnType<typeof decision>, { status: "RECORD_INITIALIZED" }>,
      traceAnchor,
      present,
      {
        publish: async <TEvent extends RuntimeEvent>(event: TEvent): Promise<void> => {
          published.push(event);
        }
      } satisfies Pick<EventBus, "publish">
    );

    expect(result.status).toBe("OUTCOME_APPLIED");
    expect(present).toHaveBeenCalledOnce();
    if (result.status !== "OUTCOME_APPLIED") throw new Error("Expected applied outcome.");
    expect(result.advancement.record.snapshot.state).toBe("STARTED");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "runtime.embodied.effect",
      traceId: traceAnchor.traceId,
      parentId: traceAnchor.id,
      payload: { state: "STARTED" }
    });
  });

  it("does not invoke Presentation for rejected admission", async () => {
    const present = vi.fn();
    const result = await executeRuntimeEmbodiedPresentation(decision(false), anchor(), present, {
      publish: async () => undefined
    });
    expect(result).toMatchObject({
      status: "REQUEST_NOT_DISPATCHED",
      reason: "EFFECT_NOT_ADMITTED"
    });
    expect(present).not.toHaveBeenCalled();
  });
});
