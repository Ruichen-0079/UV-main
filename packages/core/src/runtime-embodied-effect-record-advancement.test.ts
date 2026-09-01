import { EMBODIED_PRESENTATION_OUTCOME_7K_VERSION } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import {
  RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION,
  advanceRuntimeEmbodiedEffectRecord
} from "./runtime-embodied-effect-record-advancement.js";
import {
  RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
  initializeRuntimeEmbodiedEffectRecord,
  type RuntimeEmbodiedEffectRecord
} from "./runtime-embodied-effect-record-initialization.js";

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

function initialRecord(): RuntimeEmbodiedEffectRecord {
  const initialized = initializeRuntimeEmbodiedEffectRecord({
    version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
    identity: {
      version: "runtime-embodied-effect-identity-7g.v1",
      effectId: "runtime-effect:7g:1",
      behavior: behavior()
    },
    policyAllowsEmbodiedEffect: true
  });
  if (initialized.status !== "RECORD_INITIALIZED") {
    throw new Error("Expected admitted test record.");
  }
  return initialized.record;
}

function report(outcome: "STARTED" | "COMPLETED", effectId = "runtime-effect:7g:1") {
  return {
    version: EMBODIED_PRESENTATION_OUTCOME_7K_VERSION,
    effectId,
    outcome
  };
}

function input(record: unknown, outcomeReport: unknown, extra: Record<string, unknown> = {}) {
  return {
    version: RUNTIME_EMBODIED_EFFECT_RECORD_ADVANCEMENT_7U_VERSION,
    record,
    report: outcomeReport,
    ...extra
  };
}

describe("Phase 7U Runtime embodied-effect record advancement", () => {
  it("threads one immutable record through STARTED then COMPLETED without promoting semantic correlation to trace", () => {
    const admitted = initialRecord();
    const started = advanceRuntimeEmbodiedEffectRecord(input(admitted, report("STARTED")));

    expect(started.status).toBe("RECORD_ADVANCED");
    if (started.status !== "RECORD_ADVANCED") return;
    expect(started.record.snapshot).toEqual({
      version: "runtime-embodied-effect-state-commit-7o.v1",
      effectId: "runtime-effect:7g:1",
      state: "STARTED"
    });
    expect(started.decision).toMatchObject({
      status: "EVENT_CONSTRUCTED",
      event: {
        type: "runtime.embodied.effect",
        payload: {
          effectId: "runtime-effect:7g:1",
          previousState: "ADMITTED",
          state: "STARTED",
          behavior: { correlation: { kind: "turn", reference: "turn-1" } }
        }
      }
    });
    expect(started.decision.event.traceId).toBe(started.decision.event.id);
    expect(started.decision.event.traceId).not.toBe("turn-1");
    expect(started.decision.event).not.toHaveProperty("parentId");

    const completed = advanceRuntimeEmbodiedEffectRecord(
      input(started.record, report("COMPLETED"))
    );
    expect(completed.status).toBe("RECORD_ADVANCED");
    if (completed.status !== "RECORD_ADVANCED") return;
    expect(completed.record.snapshot.state).toBe("COMPLETED");
    expect(completed.decision.event.payload).toMatchObject({
      effectId: "runtime-effect:7g:1",
      previousState: "STARTED",
      state: "COMPLETED"
    });
    expect(completed.decision.event.traceId).toBe(completed.decision.event.id);
    expect(completed.decision.event.traceId).not.toBe("turn-1");

    expect(admitted.snapshot.state).toBe("ADMITTED");
    expect(started.record.snapshot.state).toBe("STARTED");
    expect(Object.isFrozen(started.record)).toBe(true);
    expect(Object.isFrozen(completed.record)).toBe(true);
  });

  it("keeps the record unchanged for duplicate and stale reports", () => {
    const started = advanceRuntimeEmbodiedEffectRecord(
      input(initialRecord(), report("STARTED"))
    );
    expect(started.status).toBe("RECORD_ADVANCED");
    if (started.status !== "RECORD_ADVANCED") return;

    const duplicate = advanceRuntimeEmbodiedEffectRecord(
      input(started.record, report("STARTED"))
    );
    expect(duplicate.status).toBe("RECORD_UNCHANGED");
    expect(duplicate.record.snapshot.state).toBe("STARTED");
    expect(duplicate.decision.status).toBe("NO_EVENT");
    expect(duplicate.decision).not.toHaveProperty("event");

    const stale = advanceRuntimeEmbodiedEffectRecord(
      input(started.record, report("COMPLETED", "runtime-effect:7g:stale"))
    );
    expect(stale.status).toBe("RECORD_UNCHANGED");
    expect(stale.record.snapshot.state).toBe("STARTED");
    expect(stale.decision.status).toBe("NO_EVENT");
  });

  it("fails closed when record identity and canonical snapshot disagree", () => {
    const canonical = initialRecord();
    const mismatchedRecord = {
      ...canonical,
      snapshot: {
        ...canonical.snapshot,
        effectId: "runtime-effect:7g:other"
      }
    };

    expect(() =>
      advanceRuntimeEmbodiedEffectRecord(
        input(mismatchedRecord, report("STARTED", "runtime-effect:7g:stale"))
      )
    ).toThrow(/identity and snapshot effectId must match/);
  });

  it("reuses strict 7G and 7O canonicalization for record internals", () => {
    const canonical = initialRecord();

    expect(() =>
      advanceRuntimeEmbodiedEffectRecord(
        input(
          {
            ...canonical,
            identity: { ...canonical.identity, device: "live2d" }
          },
          report("STARTED")
        )
      )
    ).toThrow(/unknown field/);

    expect(() =>
      advanceRuntimeEmbodiedEffectRecord(
        input(
          {
            ...canonical,
            snapshot: { ...canonical.snapshot, provider: "renderer" }
          },
          report("STARTED")
        )
      )
    ).toThrow(/unknown field/);

    expect(() =>
      advanceRuntimeEmbodiedEffectRecord(
        input(
          { ...canonical, version: "runtime-embodied-effect-record-future.v9" },
          report("STARTED")
        )
      )
    ).toThrow(/7T/);
  });

  it("does not accept holder, publication, Presentation, persistence, or retry authority", () => {
    for (const extra of [
      { eventBus: "runtime" },
      { publish: true },
      { store: true },
      { manager: true },
      { retry: true },
      { device: "live2d" },
      { persist: true },
      { memoryTruth: true }
    ]) {
      expect(() =>
        advanceRuntimeEmbodiedEffectRecord(input(initialRecord(), report("STARTED"), extra))
      ).toThrow(/unknown field/);
    }
  });
});
