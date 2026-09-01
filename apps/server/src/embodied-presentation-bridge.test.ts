import { describe, expect, it, vi } from "vitest";
import { EmbodiedPresentationBridge } from "./embodied-presentation-bridge.js";

const request = {
  version: "embodied-presentation-request-7ad.v1" as const,
  effectId: "runtime-effect:1",
  behavior: {
    version: "embodied-behavior-7b.v1" as const,
    behavior: {
      version: "embodied-behavior-7a.v1" as const,
      kind: "SILENCE" as const,
      cause: { kind: "character" as const, reference: "character-proposal:1" }
    },
    sourceInstance: { reference: "character-proposal:1", createdAtMs: 1 },
    correlation: { kind: "turn" as const, reference: "turn:1" }
  }
};

const traceAnchor = {
  id: "reply:1",
  type: "agent.reply" as const,
  timestamp: "2026-09-01T00:00:00.000Z",
  traceId: "trace:1",
  payload: { content: "hello" }
};

describe("EmbodiedPresentationBridge", () => {
  it("publishes a Runtime request and resolves only its matching report", async () => {
    const publish = vi.fn(async (_event: unknown) => undefined);
    const bridge = new EmbodiedPresentationBridge({ publish });
    const pending = bridge.present(request, traceAnchor);

    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      type: "runtime.embodied.presentation.request",
      traceId: "trace:1",
      parentId: "reply:1",
      payload: request
    });
    expect(
      bridge.resolve({
        version: "embodied-presentation-outcome-7k.v1",
        effectId: "runtime-effect:other",
        outcome: "COMPLETED"
      })
    ).toBe(false);
    expect(
      bridge.resolve({
        version: "embodied-presentation-outcome-7k.v1",
        effectId: request.effectId,
        outcome: "STARTED"
      })
    ).toBe(true);
    await expect(pending).resolves.toMatchObject({
      effectId: request.effectId,
      outcome: "STARTED"
    });
  });

  it("fails closed when no Presentation surface returns an outcome", async () => {
    vi.useFakeTimers();
    const bridge = new EmbodiedPresentationBridge({ publish: async () => undefined });
    const pending = bridge.present(request, traceAnchor);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toMatchObject({ effectId: request.effectId, outcome: "FAILED" });
    bridge.close();
    vi.useRealTimers();
  });
});
