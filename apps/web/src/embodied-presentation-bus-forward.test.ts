import { describe, expect, it, vi } from "vitest";
import { EMBODIED_PRESENTATION_REQUEST_7AD_VERSION } from "@companion/protocol";
import { forwardEmbodiedPresentationRequest } from "./embodied-presentation-bus-forward.js";

function validPayload() {
  return {
    version: EMBODIED_PRESENTATION_REQUEST_7AD_VERSION,
    effectId: "runtime-effect:main-forward:1",
    behavior: {
      version: "embodied-behavior-7b.v1" as const,
      behavior: {
        version: "embodied-behavior-7a.v1" as const,
        kind: "EXPRESSION" as const,
        cause: {
          kind: "character" as const,
          reference: "character-decision:main-forward:1"
        },
        intent: "soft-smile" as const
      },
      sourceInstance: {
        reference: "character-proposal:main-forward:1",
        createdAtMs: 1000
      },
      correlation: {
        kind: "turn" as const,
        reference: "turn:main-forward:1"
      }
    }
  };
}

describe("Main/product embodied Presentation bus forward", () => {
  it("posts a canonical CompanionBus request for soft-smile Presentation events", () => {
    const post = vi.fn();
    forwardEmbodiedPresentationRequest(
      {
        type: "runtime.embodied.presentation.request",
        payload: validPayload()
      },
      post
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toEqual({
      kind: "embodied-presentation-request",
      request: validPayload()
    });
  });

  it("ignores unrelated Runtime events", () => {
    const post = vi.fn();
    forwardEmbodiedPresentationRequest(
      {
        type: "runtime.turn.completed",
        payload: validPayload()
      },
      post
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("fail-closes on malformed Presentation payloads", () => {
    const post = vi.fn();
    expect(() =>
      forwardEmbodiedPresentationRequest(
        {
          type: "runtime.embodied.presentation.request",
          payload: { version: "not-a-request", renderer: "live2d" }
        },
        post
      )
    ).not.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});
