import { describe, expect, it } from "vitest";
import { AssistantMessagePayloadSchema, TurnOriginSchema } from "./index.js";

describe("assistant-origin protocol metadata", () => {
  it("accepts the canonical assistant-initiated origin and idempotency metadata", () => {
    expect(TurnOriginSchema.parse("assistant-initiated")).toBe("assistant-initiated");
    expect(
      AssistantMessagePayloadSchema.parse({
        sessionId: "session-1",
        content: "hello",
        turnOrigin: "assistant-initiated",
        idempotencyKey: "decision-1"
      })
    ).toMatchObject({ turnOrigin: "assistant-initiated", idempotencyKey: "decision-1" });
  });
});
