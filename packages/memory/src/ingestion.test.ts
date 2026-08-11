import { describe, expect, it } from "vitest";
import { MemoryIngestionPolicy } from "./ingestion.js";

const base = {
  scope: "user:user-a|character:alice",
  sessionId: "session-1",
  subjectUserId: "user-a",
  personaId: "alice",
  userMessageId: "user-message-1",
  assistantMessageId: "assistant-message-1",
  traceId: "trace-1",
  observedAt: "2026-08-11T00:00:00.000Z"
};

describe("MemoryIngestionPolicy", () => {
  it("creates a factual user event without authority state", async () => {
    const result = await new MemoryIngestionPolicy().build({
      ...base,
      userMessage: "我喜欢蓝色。",
      assistantMessage: "好的。"
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "fact",
      content: "我喜欢蓝色。",
      assertion: { source: "user", verification: "unverified" }
    });
    expect(result.events[0]?.metadata).not.toHaveProperty("trust");
    expect(result.events[0]?.metadata).not.toHaveProperty("closeness");
    expect(result.events[0]?.metadata).not.toHaveProperty("relationship");
  });

  it("blocks assistant interpretation and self-memory pollution", async () => {
    const result = await new MemoryIngestionPolicy().build({
      ...base,
      userMessage: "你好",
      assistantMessage: "我们关系更好了。我现在更信任你。"
    });

    expect(result.events).toEqual([]);
    expect(result.skippedReason).toBe("no-factual-memory");
  });

  it("attributes relationship-duration statements as user claims", async () => {
    const result = await new MemoryIngestionPolicy().build({
      ...base,
      userMessage: "我们认识三年了。",
      assistantMessage: "我会记住这是你的说法。"
    });

    expect(result.events).toMatchObject([
      {
        kind: "user_claim",
        content: "用户称双方认识三年了。",
        assertion: { source: "user", verification: "unverified" }
      }
    ]);
  });

  it("keeps explicit remember as one user claim event", async () => {
    const result = await new MemoryIngestionPolicy().build({
      ...base,
      userMessage: "请记住：我喜欢咖啡。",
      assistantMessage: "好的，我会记住。"
    });

    expect(result.turnKind).toBe("explicit_remember");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "user_claim",
      content: "用户喜欢咖啡。",
      assertion: { source: "user", verification: "unverified" },
      metadata: { explicit: true, memoryType: "user_claim" }
    });
  });

  it("does not write ordinary conversational turns", async () => {
    const result = await new MemoryIngestionPolicy().build({
      ...base,
      userMessage: "今天感觉怎么样？",
      assistantMessage: "一切正常。"
    });

    expect(result.events).toEqual([]);
  });
});
