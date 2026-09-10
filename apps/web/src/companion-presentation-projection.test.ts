import { describe, expect, it } from "vitest";
import {
  deriveCompanionRendererPresentation,
  isCompanionRendererPresentation
} from "./companion-presentation-projection.js";

describe("Companion renderer presentation projection", () => {
  it("never turns model selection into renderer readiness", () => {
    expect(
      deriveCompanionRendererPresentation(
        { kind: "selected", id: "hiyori", name: "Hiyori Momose" },
        "loading"
      )
    ).toEqual({
      status: "loading",
      activeModelId: "hiyori",
      activeModelName: "Hiyori Momose"
    });
    expect(
      deriveCompanionRendererPresentation(
        { kind: "selected", id: "hiyori", name: "Hiyori Momose" },
        "ready"
      ).status
    ).toBe("ready");
    expect(
      deriveCompanionRendererPresentation(
        { kind: "selected", id: "hiyori", name: "Hiyori Momose" },
        "failed"
      ).status
    ).toBe("failed");
  });

  it("projects explicit no-model and unavailable states without fake readiness", () => {
    expect(deriveCompanionRendererPresentation({ kind: "none" }, "failed")).toEqual({
      status: "no_model",
      activeModelId: null,
      activeModelName: null
    });
    expect(deriveCompanionRendererPresentation({ kind: "unavailable" }, "ready")).toEqual({
      status: "failed",
      activeModelId: null,
      activeModelName: null
    });
    expect(deriveCompanionRendererPresentation(null, "loading").status).toBe("loading");
  });

  it("rejects malformed cross-window state", () => {
    expect(
      isCompanionRendererPresentation({
        status: "ready",
        activeModelId: "hiyori",
        activeModelName: "Hiyori Momose"
      })
    ).toBe(true);
    expect(isCompanionRendererPresentation({ status: "ready" })).toBe(false);
    expect(
      isCompanionRendererPresentation({
        status: "working",
        activeModelId: null,
        activeModelName: null
      })
    ).toBe(false);
  });
});
