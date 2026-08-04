import { createEvent } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import { shouldForwardEvent } from "./websocket.js";

describe("WebSocket reply compatibility filter", () => {
  it("forwards agent.reply but does not forward assistant.message twice", () => {
    const user = createEvent("user.message", {
      sessionId: "session-1",
      content: "hello"
    });
    const agent = createEvent(
      "agent.reply",
      { sessionId: user.payload.sessionId, content: "hi" },
      { traceId: user.traceId, parentId: user.id }
    );
    const assistant = createEvent(
      "assistant.message",
      { sessionId: user.payload.sessionId, content: "hi" },
      { traceId: user.traceId, parentId: agent.id }
    );

    expect(shouldForwardEvent(agent)).toBe(true);
    expect(shouldForwardEvent(assistant)).toBe(false);
  });
});
