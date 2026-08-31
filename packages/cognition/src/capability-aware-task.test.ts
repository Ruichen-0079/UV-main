import { describe, expect, it } from "vitest";
import { COGNITION_6A_VERSION, COGNITION_6G_VERSION } from "./index.js";
import {
  COGNITION_6U_VERSION,
  createCognitionCapabilityAwareReasoningTask
} from "./capability-aware-task.js";

function reasoningTask() {
  return {
    version: COGNITION_6A_VERSION,
    escalation: {
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "verify claim"
    },
    problem: "Determine whether the claim is supported."
  } as const;
}

function capabilities() {
  return {
    version: COGNITION_6G_VERSION,
    capabilities: [
      {
        capabilityRef: "capability://opaque/read-authorized-text",
        description: "Read one currently authorized text resource without modifying it."
      }
    ]
  } as const;
}

describe("Cognition 6U capability-aware reasoning task", () => {
  it("binds one revalidated 6A task to the current revalidated 6G capability descriptions", () => {
    const result = createCognitionCapabilityAwareReasoningTask({
      version: COGNITION_6U_VERSION,
      task: reasoningTask(),
      capabilities: capabilities()
    });

    expect(result).toEqual({
      version: COGNITION_6U_VERSION,
      task: reasoningTask(),
      capabilities: capabilities()
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.task)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
    expect(Object.isFrozen(result.capabilities.capabilities)).toBe(true);
    expect(Object.isFrozen(result.capabilities.capabilities[0])).toBe(true);
  });

  it("allows an empty current inventory without changing the original no-capability task semantics", () => {
    const result = createCognitionCapabilityAwareReasoningTask({
      version: COGNITION_6U_VERSION,
      task: reasoningTask(),
      capabilities: {
        version: COGNITION_6G_VERSION,
        capabilities: []
      }
    });

    expect(result.task.problem).toBe("Determine whether the claim is supported.");
    expect(result.capabilities.capabilities).toEqual([]);
  });

  it("reuses 6A and 6G validation instead of creating parallel task or inventory rules", () => {
    expect(() =>
      createCognitionCapabilityAwareReasoningTask({
        version: COGNITION_6U_VERSION,
        task: { ...reasoningTask(), provider: "deepinfra" },
        capabilities: capabilities()
      })
    ).toThrow(/unknown field/);

    expect(() =>
      createCognitionCapabilityAwareReasoningTask({
        version: COGNITION_6U_VERSION,
        task: reasoningTask(),
        capabilities: {
          version: COGNITION_6G_VERSION,
          capabilities: [
            {
              capabilityRef: "duplicate",
              description: "one"
            },
            {
              capabilityRef: "duplicate",
              description: "two"
            }
          ]
        }
      })
    ).toThrow(/unique/);
  });

  it("rejects provider, model, tool, MCP, execution, and Runtime-state metadata at the 6U envelope", () => {
    for (const extra of [
      { provider: "deepinfra" },
      { model: "reasoning-model" },
      { toolName: "read_text_file" },
      { mcpServer: "filesystem" },
      { arguments: { path: "/tmp/file" } },
      { capabilityRoundsUsed: 0 },
      { runtimeAuthorizedPath: "/tmp/file" }
    ]) {
      expect(() =>
        createCognitionCapabilityAwareReasoningTask({
          version: COGNITION_6U_VERSION,
          task: reasoningTask(),
          capabilities: capabilities(),
          ...extra
        })
      ).toThrow(/unknown field/);
    }
  });

  it("rejects unknown versions and malformed envelope fields fail closed", () => {
    for (const invalid of [
      {
        version: "cognition-6t.v1",
        task: reasoningTask(),
        capabilities: capabilities()
      },
      {
        version: COGNITION_6U_VERSION,
        task: reasoningTask()
      },
      {
        version: COGNITION_6U_VERSION,
        task: reasoningTask(),
        capabilities: null
      }
    ]) {
      expect(() => createCognitionCapabilityAwareReasoningTask(invalid)).toThrow();
    }
  });
});
