import { describe, expect, it } from "vitest";
import { COGNITION_6A_VERSION } from "./index.js";
import { COGNITION_6N_VERSION } from "./capability-observation.js";
import {
  COGNITION_6P_VERSION,
  createCognitionPostCapabilityReasoningTask
} from "./post-capability-task.js";

function validTask() {
  return {
    version: COGNITION_6A_VERSION,
    escalation: {
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "verify the claim"
    },
    problem: "Determine whether the claim is supported by the authorized evidence."
  };
}

function validObservation() {
  return {
    version: COGNITION_6N_VERSION,
    capabilityRef: "capability://opaque/read-authorized-text",
    status: "SUCCESS",
    content: "The authorized evidence states the relevant fact."
  };
}

describe("Cognition 6P post-capability reasoning task", () => {
  it("binds and freezes a validated 6A task with a validated 6N observation", () => {
    const result = createCognitionPostCapabilityReasoningTask({
      version: COGNITION_6P_VERSION,
      task: validTask(),
      observation: validObservation()
    });

    expect(result).toEqual({
      version: COGNITION_6P_VERSION,
      task: validTask(),
      observation: validObservation()
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.task)).toBe(true);
    expect(Object.isFrozen(result.task.escalation)).toBe(true);
    expect(Object.isFrozen(result.observation)).toBe(true);
  });

  it("accepts unavailable/error observations without inventing evidence content", () => {
    for (const status of ["UNAVAILABLE", "ERROR"] as const) {
      const result = createCognitionPostCapabilityReasoningTask({
        version: COGNITION_6P_VERSION,
        task: validTask(),
        observation: {
          version: COGNITION_6N_VERSION,
          capabilityRef: "capability://opaque/read-authorized-text",
          status
        }
      });
      expect(result.observation).toEqual({
        version: COGNITION_6N_VERSION,
        capabilityRef: "capability://opaque/read-authorized-text",
        status
      });
    }
  });

  it("reuses the existing 6A task validator instead of accepting malformed tasks", () => {
    for (const task of [
      { ...validTask(), problem: "" },
      { ...validTask(), provider: "deepseek" },
      {
        ...validTask(),
        escalation: { ...validTask().escalation, toolName: "read_text_file" }
      }
    ]) {
      expect(() =>
        createCognitionPostCapabilityReasoningTask({
          version: COGNITION_6P_VERSION,
          task,
          observation: validObservation()
        })
      ).toThrow();
    }
  });

  it("reuses the 6N observation validator", () => {
    expect(() =>
      createCognitionPostCapabilityReasoningTask({
        version: COGNITION_6P_VERSION,
        task: validTask(),
        observation: { ...validObservation(), toolName: "read_text_file" }
      })
    ).toThrow(/unknown field/);
  });

  it("rejects Runtime/provider/execution fields at the 6P wrapper", () => {
    for (const extra of [
      { capabilityRoundsUsed: 1 },
      { policyAllowsCapability: true },
      { provider: "deepseek" },
      { toolName: "read_text_file" },
      { path: "/runtime/authorized/file" },
      { signal: "abort" }
    ]) {
      expect(() =>
        createCognitionPostCapabilityReasoningTask({
          version: COGNITION_6P_VERSION,
          task: validTask(),
          observation: validObservation(),
          ...extra
        })
      ).toThrow(/unknown field/);
    }
  });

  it("fails closed on an unknown version", () => {
    expect(() =>
      createCognitionPostCapabilityReasoningTask({
        version: "future",
        task: validTask(),
        observation: validObservation()
      })
    ).toThrow(/version/);
  });
});
