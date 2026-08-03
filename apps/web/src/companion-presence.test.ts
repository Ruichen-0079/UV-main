import { describe, expect, it } from "vitest";
import { reduceCompanionPresence } from "./companion-presence.js";

describe("reduceCompanionPresence", () => {
  it("follows generation state and queue state transitions", () => {
    let presence = reduceCompanionPresence("idle", { type: "generation", state: "thinking" });
    expect(presence).toBe("thinking");

    presence = reduceCompanionPresence(presence, { type: "queue", state: "synthesizing" });
    expect(presence).toBe("thinking");

    presence = reduceCompanionPresence(presence, { type: "queue", state: "playing" });
    expect(presence).toBe("speaking");

    presence = reduceCompanionPresence(presence, { type: "generation", state: "idle" });
    expect(presence).toBe("speaking");

    presence = reduceCompanionPresence(presence, { type: "queue", state: "idle" });
    expect(presence).toBe("idle");
  });

  it("maps stopped and error queue states", () => {
    expect(reduceCompanionPresence("thinking", { type: "queue", state: "stopped" })).toBe(
      "interrupted"
    );
    expect(reduceCompanionPresence("interrupted", { type: "queue", state: "error" })).toBe("idle");
  });

  it("maps interrupted generation state", () => {
    expect(reduceCompanionPresence("thinking", { type: "generation", state: "interrupted" })).toBe(
      "interrupted"
    );
  });
});
