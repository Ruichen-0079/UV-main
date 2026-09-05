import { describe, expect, it } from "vitest";
import {
  createCharacterDecision,
  createCharacterProactiveProposal,
  createCharacterProposal,
  type CharacterDecision
} from "./index.js";

function decisionWith(
  proactive: unknown,
  reply: unknown = { disposition: "RESPOND", text: "好" },
  addressing: unknown = "DIRECTED_TO_YUVI"
): Record<string, unknown> {
  return { addressing, reply, proactive };
}

describe("Character decision vNext contract", () => {
  it("represents RESPOND with an explicit KEEP proactive proposal", () => {
    const decision = createCharacterDecision(
      decisionWith({ action: "KEEP" }, { disposition: "RESPOND", text: "Natural reply." })
    );

    expect(decision).toEqual({
      addressing: "DIRECTED_TO_YUVI",
      reply: { disposition: "RESPOND", text: "Natural reply." },
      proactive: { action: "KEEP" }
    });
  });

  it("keeps a bounded reply orthogonal to timed suppression, as in a quiet-period request", () => {
    const decision = createCharacterDecision(
      decisionWith(
        { action: "SUPPRESS", scope: { kind: "UNTIL", duration: "PT5M" } },
        { disposition: "RESPOND", text: "好" }
      )
    );

    expect(decision.reply).toEqual({ disposition: "RESPOND", text: "好" });
    expect(decision.proactive).toEqual({
      action: "SUPPRESS",
      scope: { kind: "UNTIL", duration: "PT5M" }
    });
  });

  it.each(["SILENCE", "TERMINATE", "NEED_COGNITION"] as const)(
    "represents %s with KEEP without collapsing to text",
    (disposition) => {
      const reply = { disposition };
      const decision = createCharacterDecision(decisionWith({ action: "KEEP" }, reply));

      expect(decision.reply).toEqual(reply);
      expect(decision.proactive).toEqual({ action: "KEEP" });
    }
  );

  it("represents third-party conversation as NOT_DIRECTED + SILENCE + KEEP", () => {
    const decision = createCharacterDecision(
      decisionWith({ action: "KEEP" }, { disposition: "SILENCE" }, "NOT_DIRECTED")
    );

    expect(decision).toEqual({
      addressing: "NOT_DIRECTED",
      reply: { disposition: "SILENCE" },
      proactive: { action: "KEEP" }
    });
  });

  it("represents AMBIGUOUS addressing explicitly instead of guessing", () => {
    const decision = createCharacterDecision(
      decisionWith({ action: "KEEP" }, { disposition: "SILENCE" }, "AMBIGUOUS")
    );

    expect(decision.addressing).toBe("AMBIGUOUS");
  });

  it("lets an explicit text source project a stable DIRECTED_TO_YUVI constraint", () => {
    const decision = createCharacterDecision(
      decisionWith({ action: "KEEP" }, { disposition: "RESPOND", text: "Typed directly to YUVI." })
    );

    // The trusted transport constraint survives revalidation unchanged.
    expect(createCharacterDecision(decision)).toEqual(decision);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.reply)).toBe(true);
    expect(Object.isFrozen(decision.proactive)).toBe(true);
  });

  it("keeps reply and proactive orthogonal when either varies", () => {
    const replies = [
      { disposition: "RESPOND", text: "Same reply." },
      { disposition: "SILENCE" }
    ] as const;
    const proactives = [
      { action: "KEEP" },
      { action: "CLEAR" },
      { action: "DEFER", horizon: "SHORT" },
      { action: "SUPPRESS", scope: { kind: "UNTIL_ENGAGEMENT" } },
      { action: "SUPPRESS", scope: { kind: "UNTIL_EXPLICIT_RESUME" } },
      { action: "SUPPRESS", scope: { kind: "UNTIL", time: "2026-09-05T22:00:00Z" } }
    ] as const;

    for (const reply of replies) {
      for (const proactive of proactives) {
        const decision = createCharacterDecision(decisionWith(proactive, reply));
        expect(decision.reply).toEqual(reply);
        expect(decision.proactive).toEqual(proactive);
      }
    }
  });

  it("keeps proactive control meaning free of authorization results", () => {
    expect(() =>
      createCharacterProactiveProposal({
        action: "SUPPRESS",
        scope: { kind: "UNTIL_EXPLICIT_RESUME" },
        authorized: true
      })
    ).toThrow(/unknown field/);

    expect(() =>
      createCharacterProactiveProposal({ action: "KEEP", grantedTo: "speaker-1" })
    ).toThrow(/unknown field/);

    expect(() =>
      createCharacterDecision({
        ...decisionWith({ action: "KEEP" }),
        authorization: { principal: "speaker-1", allowed: true }
      })
    ).toThrow(/unknown field/);
  });

  it("keeps NEED_COGNITION coarse and free of provider or tool identity", () => {
    const decision = createCharacterDecision(
      decisionWith(
        { action: "KEEP" },
        { disposition: "NEED_COGNITION", focus: "Serious research is needed." }
      )
    );
    expect(decision.reply).toEqual({
      disposition: "NEED_COGNITION",
      focus: "Serious research is needed."
    });

    expect(() =>
      createCharacterProposal({ disposition: "NEED_COGNITION", provider: "glm" })
    ).toThrow(/unknown field/);
    expect(() =>
      createCharacterProposal({ disposition: "NEED_COGNITION", tool: "search" })
    ).toThrow(/unknown field/);
    expect(() =>
      createCharacterProposal({ disposition: "NEED_COGNITION", model: "glm-5.3" })
    ).toThrow(/unknown field/);
  });

  it("never accepts provider metadata as stable decision semantics", () => {
    for (const leak of ["provider", "model", "providerMetadata", "finalProvider", "device"]) {
      expect(() =>
        createCharacterDecision({ ...decisionWith({ action: "KEEP" }), [leak]: "whatever" })
      ).toThrow(/unknown field/);
    }

    expect(() =>
      createCharacterDecision(
        decisionWith({ action: "KEEP" }, { disposition: "RESPOND", text: "Hi", model: "x" })
      )
    ).toThrow(/unknown field/);
  });

  it("rejects invalid addressing, replies, and proactive proposals", () => {
    expect(() =>
      createCharacterDecision(decisionWith({ action: "KEEP" }, undefined, "MAYBE"))
    ).toThrow(/addressing is invalid/);
    expect(() =>
      createCharacterDecision({ addressing: "DIRECTED_TO_YUVI", proactive: { action: "KEEP" } })
    ).toThrow();
    expect(() =>
      createCharacterDecision({ addressing: "DIRECTED_TO_YUVI", reply: { disposition: "SILENCE" } })
    ).toThrow();
    expect(() =>
      createCharacterDecision(
        decisionWith({ action: "KEEP" }, { disposition: "RESPOND", text: "" })
      )
    ).toThrow(/non-empty string/);
  });

  it("requires DEFER to carry a bounded horizon", () => {
    expect(() => createCharacterProactiveProposal({ action: "DEFER" })).toThrow(
      /horizon is invalid/
    );
    expect(() => createCharacterProactiveProposal({ action: "DEFER", horizon: "FOREVER" })).toThrow(
      /horizon is invalid/
    );
    expect(createCharacterProactiveProposal({ action: "DEFER", horizon: "LONG" })).toEqual({
      action: "DEFER",
      horizon: "LONG"
    });
  });

  it("requires SUPPRESS UNTIL to carry exactly one anchored bound in ISO-8601", () => {
    expect(() => createCharacterProactiveProposal({ action: "SUPPRESS" })).toThrow(
      /suppression scope/
    );
    expect(() =>
      createCharacterProactiveProposal({ action: "SUPPRESS", scope: { kind: "UNTIL" } })
    ).toThrow(/exactly one of time or duration/);
    expect(() =>
      createCharacterProactiveProposal({
        action: "SUPPRESS",
        scope: { kind: "UNTIL", time: "2026-09-05T22:00:00Z", duration: "PT5M" }
      })
    ).toThrow(/exactly one of time or duration/);
    expect(() =>
      createCharacterProactiveProposal({
        action: "SUPPRESS",
        scope: { kind: "UNTIL", duration: "五分钟" }
      })
    ).toThrow(/ISO-8601 duration/);
    expect(() =>
      createCharacterProactiveProposal({
        action: "SUPPRESS",
        scope: { kind: "UNTIL", time: "tonight" }
      })
    ).toThrow(/ISO-8601 instant/);
    expect(() =>
      createCharacterProactiveProposal({
        action: "SUPPRESS",
        scope: { kind: "UNTIL", duration: "PT5M", forever: true }
      })
    ).toThrow(/unknown field/);

    expect(
      createCharacterProactiveProposal({
        action: "SUPPRESS",
        scope: { kind: "UNTIL", time: "2026-09-05T22:00:00+08:00" }
      })
    ).toEqual({ action: "SUPPRESS", scope: { kind: "UNTIL", time: "2026-09-05T22:00:00+08:00" } });
  });

  it("rejects unknown suppression scope kinds and extras on scoped proposals", () => {
    expect(() =>
      createCharacterProactiveProposal({ action: "SUPPRESS", scope: { kind: "UNTIL_SOMEDAY" } })
    ).toThrow(/scope kind is invalid/);
    expect(() =>
      createCharacterProactiveProposal({ action: "KEEP", scope: { kind: "UNTIL" } })
    ).toThrow(/unknown field/);
  });

  it("keeps an already-valid decision idempotent through revalidation", () => {
    const decision: CharacterDecision = createCharacterDecision(
      decisionWith(
        { action: "SUPPRESS", scope: { kind: "UNTIL", duration: "PT30M" } },
        { disposition: "RESPOND", text: "Understood, quiet for a while." }
      )
    );

    expect(createCharacterDecision(decision)).toEqual(decision);
  });
});
