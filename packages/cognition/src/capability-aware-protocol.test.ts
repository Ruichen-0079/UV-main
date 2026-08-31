import { describe, expect, it } from "vitest";
import { COGNITION_6A_VERSION, COGNITION_6G_VERSION } from "./index.js";
import {
  COGNITION_6U_VERSION,
  COGNITION_6W_VERSION,
  createCognitionCapabilityAwareProtocolReasoningInput,
  interpretCognitionCapabilityAwareReasoningOutput
} from "./capability-aware-task.js";

function task() {
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
    capabilities: inventory()
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

function output(answer: string, finishReason: "stop" | "length" | "tool_call" | "content_filter" | "unknown" = "stop") {
  return {
    reasoning: "",
    answer,
    finishReason,
    metadata: { provider: "must-not-leak" }
  } as const;
}

describe("Cognition 6W capability-aware backend protocol", () => {
  it("adds an explicit COMPLETE / REQUEST_CAPABILITY protocol without concrete execution metadata", () => {
    const result = createCognitionCapabilityAwareProtocolReasoningInput(task());

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]!.content).toBe("Determine whether the claim is supported.");
    expect(result.messages[1]!.content).toContain("capability://opaque/read-authorized-text");
    expect(result.messages[2]!.content).toContain("COMPLETE");
    expect(result.messages[2]!.content).toContain("REQUEST_CAPABILITY");
    expect(result.messages[2]!.content).toContain("Do not output CONTINUE_REASONING");

    const wire = JSON.stringify(result);
    for (const forbidden of [
      "read_text_file",
      "filesystem",
      "runtimeAuthorizedPath",
      "inputSchema",
      "capabilityRoundsUsed"
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(Object.isFrozen(result.messages[2])).toBe(true);
  });

  it("normalizes a COMPLETE response through the existing 6A result authority", () => {
    const disposition = interpretCognitionCapabilityAwareReasoningOutput(
      output("COMPLETE\nThe claim is supported by the available evidence."),
      inventory()
    );

    expect(disposition).toMatchObject({
      version: COGNITION_6W_VERSION,
      kind: "COMPLETE",
      result: {
        status: "SUCCESS",
        answer: "The claim is supported by the available evidence."
      }
    });
    expect(JSON.stringify(disposition)).not.toContain("must-not-leak");
    expect(Object.isFrozen(disposition)).toBe(true);
  });

  it("preserves only a truncated COMPLETE body as PARTIAL", () => {
    const disposition = interpretCognitionCapabilityAwareReasoningOutput(
      output("COMPLETE\nPartial but semantically usable answer", "length"),
      inventory()
    );

    expect(disposition).toMatchObject({
      version: COGNITION_6W_VERSION,
      kind: "COMPLETE",
      result: {
        status: "PARTIAL",
        answer: "Partial but semantically usable answer"
      }
    });
  });

  it("turns a valid REQUEST_CAPABILITY into the existing inventory-bound 6H request", () => {
    const disposition = interpretCognitionCapabilityAwareReasoningOutput(
      output(
        [
          "REQUEST_CAPABILITY",
          JSON.stringify({
            capabilityRef: "capability://opaque/read-authorized-text",
            request: "Read the currently authorized evidence needed to verify the claim."
          })
        ].join("\n")
      ),
      inventory()
    );

    expect(disposition).toEqual({
      version: COGNITION_6W_VERSION,
      kind: "REQUEST_CAPABILITY",
      request: {
        version: "cognition-6h.v1",
        kind: "REQUEST_CAPABILITY",
        capabilityRef: "capability://opaque/read-authorized-text",
        request: "Read the currently authorized evidence needed to verify the claim."
      }
    });
    expect(Object.isFrozen(disposition)).toBe(true);
    expect(Object.isFrozen(disposition.kind === "REQUEST_CAPABILITY" ? disposition.request : null)).toBe(true);
  });

  it("fails closed when the model invents a capability ref or adds execution fields", () => {
    for (const payload of [
      {
        capabilityRef: "capability://opaque/not-current",
        request: "Use an unavailable capability."
      },
      {
        capabilityRef: "capability://opaque/read-authorized-text",
        request: "Read evidence.",
        toolName: "read_text_file"
      }
    ]) {
      const disposition = interpretCognitionCapabilityAwareReasoningOutput(
        output(`REQUEST_CAPABILITY\n${JSON.stringify(payload)}`),
        inventory()
      );
      expect(disposition).toMatchObject({
        version: COGNITION_6W_VERSION,
        kind: "COMPLETE",
        result: { status: "ERROR" }
      });
      expect(JSON.stringify(disposition)).not.toContain("read_text_file");
    }
  });

  it("fails closed on malformed, unsupported, or truncated capability control wire", () => {
    for (const backendOutput of [
      output("REQUEST_CAPABILITY\n{not-json}"),
      output("CONTINUE_REASONING\nkeep going"),
      output("Some ordinary answer without the protocol marker."),
      output('REQUEST_CAPABILITY\n{"capabilityRef":"capability://opaque/read', "length")
    ]) {
      const disposition = interpretCognitionCapabilityAwareReasoningOutput(
        backendOutput,
        inventory()
      );
      expect(disposition).toMatchObject({
        version: COGNITION_6W_VERSION,
        kind: "COMPLETE",
        result: { status: "ERROR" }
      });
      expect(JSON.stringify(disposition)).not.toContain("not-json");
    }
  });

  it("rejects REQUEST_CAPABILITY when the current inventory is empty", () => {
    const disposition = interpretCognitionCapabilityAwareReasoningOutput(
      output(
        'REQUEST_CAPABILITY\n{"capabilityRef":"capability://opaque/read-authorized-text","request":"Read it."}'
      ),
      { version: COGNITION_6G_VERSION, capabilities: [] }
    );

    expect(disposition).toMatchObject({
      version: COGNITION_6W_VERSION,
      kind: "COMPLETE",
      result: { status: "ERROR" }
    });
  });

  it("preserves provider termination semantics without treating tool_call as capability authority", () => {
    expect(
      interpretCognitionCapabilityAwareReasoningOutput(
        output("ignored", "content_filter"),
        inventory()
      )
    ).toMatchObject({ kind: "COMPLETE", result: { status: "UNSAFE_TO_ANSWER" } });

    for (const finishReason of ["tool_call", "unknown"] as const) {
      expect(
        interpretCognitionCapabilityAwareReasoningOutput(output("ignored", finishReason), inventory())
      ).toMatchObject({ kind: "COMPLETE", result: { status: "ERROR" } });
    }
  });

  it("treats provider-normalization violations as infrastructure errors rather than model wire errors", () => {
    expect(() =>
      interpretCognitionCapabilityAwareReasoningOutput(
        {
          reasoning: "raw hidden reasoning must already be discarded",
          answer: "COMPLETE\nanswer",
          finishReason: "stop"
        },
        inventory()
      )
    ).toThrow(/provider-normalized/);

    expect(() =>
      interpretCognitionCapabilityAwareReasoningOutput(
        {
          reasoning: "",
          answer: "COMPLETE\nanswer",
          finishReason: "vendor-specific"
        },
        inventory()
      )
    ).toThrow(/finishReason/);
  });

  it("revalidates caller-owned inventory before interpreting model output", () => {
    expect(() =>
      interpretCognitionCapabilityAwareReasoningOutput(output("COMPLETE\nanswer"), {
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
      })
    ).toThrow(/unique/);
  });
});
