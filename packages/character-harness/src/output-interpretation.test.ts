import { describe, expect, it } from "vitest";
import {
  CHARACTER_HARNESS_5B_VERSION,
  interpretCharacterHarnessOutput
} from "./index.js";

describe("Character Harness 5B output interpretation", () => {
  it.each([
    {
      input: { disposition: "RESPOND", text: "A bounded character response." },
      disposition: "RESPOND"
    },
    { input: { disposition: "SILENCE" }, disposition: "SILENCE" },
    { input: { disposition: "TERMINATE" }, disposition: "TERMINATE" },
    {
      input: { disposition: "NEED_COGNITION", focus: "Needs reliable verification." },
      disposition: "NEED_COGNITION"
    }
  ] as const)("accepts $disposition as a first-class Character meaning", ({ input, disposition }) => {
    const result = interpretCharacterHarnessOutput(input);

    expect(result.version).toBe(CHARACTER_HARNESS_5B_VERSION);
    expect(result.status).toBe("ACCEPTED");
    if (result.status === "ACCEPTED") {
      expect(result.proposal.disposition).toBe(disposition);
    }
  });

  it("preserves presentation intent as a semantic request without claiming execution", () => {
    const result = interpretCharacterHarnessOutput({
      disposition: "RESPOND",
      text: "Hi.",
      presentation: { intent: "soft-smile" }
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5B_VERSION,
      status: "ACCEPTED",
      proposal: {
        disposition: "RESPOND",
        text: "Hi.",
        presentation: { intent: "soft-smile" }
      }
    });
  });

  it("fails closed on direct Character capability requests", () => {
    const result = interpretCharacterHarnessOutput({
      disposition: "REQUEST_CAPABILITY",
      capability: "shell"
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5B_VERSION,
      status: "MALFORMED",
      reason: "INVALID_CHARACTER_PROPOSAL"
    });
  });

  it("fails closed when NEED_COGNITION smuggles concrete tool routing", () => {
    expect(
      interpretCharacterHarnessOutput({
        disposition: "NEED_COGNITION",
        focus: "Needs external information.",
        toolName: "browser.search"
      })
    ).toEqual({
      version: CHARACTER_HARNESS_5B_VERSION,
      status: "MALFORMED",
      reason: "INVALID_CHARACTER_PROPOSAL"
    });
  });

  it("does not allow SILENCE or TERMINATE to smuggle user-visible text", () => {
    for (const disposition of ["SILENCE", "TERMINATE"] as const) {
      expect(
        interpretCharacterHarnessOutput({ disposition, text: "This must not be emitted." })
      ).toMatchObject({ status: "MALFORMED" });
    }
  });

  it("rejects empty responses and provider/runtime metadata", () => {
    for (const input of [
      { disposition: "RESPOND", text: "" },
      { disposition: "RESPOND", text: "Hello", provider: "local-model" },
      { disposition: "RESPOND", text: "Hello", runtimeEffectId: "effect-1" },
      { disposition: "RESPOND", text: "Hello", rawChainOfThought: "hidden" }
    ]) {
      expect(interpretCharacterHarnessOutput(input)).toMatchObject({ status: "MALFORMED" });
    }
  });

  it("does not echo malformed model/provider payloads into diagnostics", () => {
    const secret = "raw-provider-payload-must-not-survive";
    const result = interpretCharacterHarnessOutput({
      disposition: "RESPOND",
      text: "Hello",
      providerPayload: secret
    });

    expect(result.status).toBe("MALFORMED");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("providerPayload");
  });

  it("returns immutable accepted and malformed interpretations", () => {
    const accepted = interpretCharacterHarnessOutput({
      disposition: "RESPOND",
      text: "Stable response."
    });
    const malformed = interpretCharacterHarnessOutput({ disposition: "UNKNOWN_ACTION" });

    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(malformed)).toBe(true);
    if (accepted.status === "ACCEPTED") {
      expect(Object.isFrozen(accepted.proposal)).toBe(true);
    }
  });
});
