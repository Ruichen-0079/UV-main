import { describe, expect, it } from "vitest";
import { COGNITION_6A_VERSION, COGNITION_6G_VERSION, COGNITION_6H_VERSION } from "./index.js";
import { COGNITION_6U_VERSION } from "./capability-aware-task.js";
import {
  COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER,
  COGNITION_6W_V2_VERSION,
  createCognitionCapabilityAwareControlFailureDisposition,
  createCognitionCapabilityAwareControlReasoningInput,
  interpretCognitionCapabilityAwareControlReasoningOutput
} from "./capability-aware-control.js";

function task(capabilities = inventory()) {
  return {
    version: COGNITION_6U_VERSION,
    task: {
      version: COGNITION_6A_VERSION,
      escalation: {
        version: "character-harness-5g.v1",
        kind: "NEED_COGNITION",
        focus: "verify claim"
      },
      problem: "Determine whether the claim is supported."
    },
    capabilities
  } as const;
}

function inventory() {
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

function output(
  answer: string,
  finishReason: "stop" | "length" | "tool_call" | "content_filter" | "unknown" = "stop"
) {
  return {
    reasoning: "",
    answer,
    finishReason,
    metadata: { provider: "must-not-leak" }
  } as const;
}

function requestFrame(payload: unknown, newline = "\n") {
  return `${COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER}${newline}${JSON.stringify(payload)}`;
}

function validRequest() {
  return {
    version: COGNITION_6H_VERSION,
    kind: "REQUEST_CAPABILITY",
    capabilityRef: "capability://opaque/read-authorized-text",
    request: "Read the currently authorized evidence needed to verify the claim."
  } as const;
}

describe("Cognition 6W v2 compatible control wire", () => {
  it("preserves the 6V projection and adds only a minimal request-control message", () => {
    const result = createCognitionCapabilityAwareControlReasoningInput(task());

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]!.content).toBe("Determine whether the claim is supported.");
    expect(result.messages[1]!.content).toContain("capability://opaque/read-authorized-text");
    expect(result.messages[2]!.content).toContain("Return the final answer normally");
    expect(result.messages[2]!.content).toContain(COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER);
    expect(result.messages[2]!.content).toContain('"kind":"REQUEST_CAPABILITY"');
    expect(result.messages[2]!.content).toContain("Do not output CONTINUE_REASONING");
    expect(JSON.stringify(result)).not.toContain("read_text_file");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
  });

  it("does not advertise the request marker for an empty current inventory", () => {
    const result = createCognitionCapabilityAwareControlReasoningInput(
      task({ version: COGNITION_6G_VERSION, capabilities: [] } as const)
    );

    expect(result.messages[2]!.content).toContain("No capability request is currently available");
    expect(result.messages[2]!.content).not.toContain(COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER);
  });

  it("keeps an ordinary provider answer on the existing final-answer path", () => {
    for (const answer of [
      "The claim is supported by the available evidence.",
      JSON.stringify(validRequest())
    ]) {
      const disposition = interpretCognitionCapabilityAwareControlReasoningOutput(
        output(answer),
        inventory()
      );
      expect(disposition).toMatchObject({
        version: COGNITION_6W_V2_VERSION,
        kind: "COMPLETE",
        result: { status: "SUCCESS", answer }
      });
      expect(JSON.stringify(disposition)).not.toContain("must-not-leak");
    }
  });

  it("parses only the exact reserved frame into the existing 6H request", () => {
    for (const newline of ["\n", "\r\n"] as const) {
      const disposition = interpretCognitionCapabilityAwareControlReasoningOutput(
        output(requestFrame(validRequest(), newline)),
        inventory()
      );
      expect(disposition).toEqual({
        version: COGNITION_6W_V2_VERSION,
        kind: "REQUEST_CAPABILITY",
        request: validRequest()
      });
      expect(Object.isFrozen(disposition)).toBe(true);
    }
  });

  it("fails closed on smuggled, malformed, unknown, or concrete execution request frames", () => {
    const cases = [
      `I need evidence.\n${requestFrame(validRequest())}`,
      `\`\`\`text\n${requestFrame(validRequest())}\n\`\`\``,
      `${COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER}\n{not-json}`,
      requestFrame({ ...validRequest(), capabilityRef: "capability://opaque/not-current" }),
      requestFrame({ ...validRequest(), toolName: "read_text_file" }),
      requestFrame({ ...validRequest(), arguments: { path: "/tmp/file" } })
    ];

    for (const answer of cases) {
      const disposition = interpretCognitionCapabilityAwareControlReasoningOutput(
        output(answer),
        inventory()
      );
      expect(disposition).toMatchObject({
        version: COGNITION_6W_V2_VERSION,
        kind: "COMPLETE",
        result: { status: "ERROR" }
      });
      expect(JSON.stringify(disposition)).not.toContain("read_text_file");
      expect(JSON.stringify(disposition)).not.toContain("/tmp/file");
    }
  });

  it("keeps an ordinary truncated answer as PARTIAL but rejects truncated control wire", () => {
    expect(
      interpretCognitionCapabilityAwareControlReasoningOutput(
        output("Partial but useful answer", "length"),
        inventory()
      )
    ).toMatchObject({
      kind: "COMPLETE",
      result: { status: "PARTIAL", answer: "Partial but useful answer" }
    });

    expect(
      interpretCognitionCapabilityAwareControlReasoningOutput(
        output(`${COGNITION_6W_V2_CAPABILITY_REQUEST_MARKER}\n{"version":"cognition-6h`, "length"),
        inventory()
      )
    ).toMatchObject({ kind: "COMPLETE", result: { status: "ERROR" } });
  });

  it("rejects capability frames when the current inventory is empty", () => {
    expect(
      interpretCognitionCapabilityAwareControlReasoningOutput(
        output(requestFrame(validRequest())),
        { version: COGNITION_6G_VERSION, capabilities: [] }
      )
    ).toMatchObject({ kind: "COMPLETE", result: { status: "ERROR" } });
  });

  it("preserves existing provider termination semantics without granting tool_call authority", () => {
    expect(
      interpretCognitionCapabilityAwareControlReasoningOutput(
        output("ignored", "content_filter"),
        inventory()
      )
    ).toMatchObject({ kind: "COMPLETE", result: { status: "UNSAFE_TO_ANSWER" } });

    for (const finishReason of ["tool_call", "unknown"] as const) {
      expect(
        interpretCognitionCapabilityAwareControlReasoningOutput(
          output("ignored", finishReason),
          inventory()
        )
      ).toMatchObject({ kind: "COMPLETE", result: { status: "ERROR" } });
    }
  });

  it("provides the canonical Runtime failure adapter for 6X", () => {
    for (const status of ["UNAVAILABLE", "CANCELLED", "ERROR"] as const) {
      expect(createCognitionCapabilityAwareControlFailureDisposition({ status })).toMatchObject({
        version: COGNITION_6W_V2_VERSION,
        kind: "COMPLETE",
        result: { status }
      });
    }
    expect(() =>
      createCognitionCapabilityAwareControlFailureDisposition({
        status: "ERROR",
        provider: "should-not-pass"
      })
    ).toThrow();
  });

  it("keeps provider-boundary violations distinct from malformed model control wire", () => {
    expect(() =>
      interpretCognitionCapabilityAwareControlReasoningOutput(
        { reasoning: "raw hidden reasoning", answer: "answer", finishReason: "stop" },
        inventory()
      )
    ).toThrow(/provider-normalized/);

    expect(() =>
      interpretCognitionCapabilityAwareControlReasoningOutput(
        { reasoning: "", answer: "answer", finishReason: "vendor-specific" },
        inventory()
      )
    ).toThrow(/finishReason/);
  });

  it("revalidates caller-owned 6U and 6G inputs before serialization or interpretation", () => {
    expect(() =>
      createCognitionCapabilityAwareControlReasoningInput({
        ...task(),
        provider: "should-not-pass"
      })
    ).toThrow(/unknown field/);

    expect(() =>
      interpretCognitionCapabilityAwareControlReasoningOutput(output("answer"), {
        version: COGNITION_6G_VERSION,
        capabilities: [
          { capabilityRef: "duplicate", description: "one" },
          { capabilityRef: "duplicate", description: "two" }
        ]
      })
    ).toThrow(/unique/);
  });
});
