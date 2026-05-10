import { createEvent, type RuntimeEvent, type UserMessageEvent } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import { InMemoryEventBus, matchesEventType } from "./index.js";

describe("matchesEventType", () => {
  it("matches exact, category wildcard, and global wildcard patterns", () => {
    expect(matchesEventType("user.message", "user.message")).toBe(true);
    expect(matchesEventType("user.*", "user.message")).toBe(true);
    expect(matchesEventType("memory.*", "user.message")).toBe(false);
    expect(matchesEventType("*", "vision.completed")).toBe(true);
  });
});

describe("InMemoryEventBus", () => {
  it("publishes events to wildcard subscribers", async () => {
    const bus = new InMemoryEventBus();
    const received: string[] = [];

    bus.subscribe("user.*", (event) => {
      received.push(event.type);
    });

    await bus.publish(createEvent("user.message", {
      sessionId: "test-session",
      content: "hello"
    }));

    expect(received).toEqual(["user.message"]);
  });

  it("supports unsubscribe", async () => {
    const bus = new InMemoryEventBus();
    let count = 0;

    const subscription = bus.subscribe("user.*", () => {
      count += 1;
    });

    subscription.unsubscribe();

    await bus.publish(createEvent("user.message", {
      sessionId: "test-session",
      content: "hello"
    }));

    expect(count).toBe(0);
  });

  it("preserves traceId across follow-up events", async () => {
    const bus = new InMemoryEventBus();
    let reply: RuntimeEvent<"agent.reply", { sessionId: string; content: string }> | undefined;

    bus.subscribe<UserMessageEvent>("user.message", async (event) => {
      await bus.publish(createEvent(
        "agent.reply",
        {
          sessionId: event.payload.sessionId,
          content: "hello back"
        },
        {
          traceId: event.traceId,
          parentId: event.id
        }
      ));
    });

    bus.subscribe<RuntimeEvent<"agent.reply", { sessionId: string; content: string }>>("agent.*", (event) => {
      reply = event;
    });

    const userMessage = createEvent("user.message", {
      sessionId: "test-session",
      content: "hello"
    });

    await bus.publish(userMessage);

    expect(reply?.traceId).toBe(userMessage.traceId);
    expect(reply?.parentId).toBe(userMessage.id);
  });

  it("isolates subscriber failures from other handlers", async () => {
    const bus = new InMemoryEventBus({ development: false });
    const received: string[] = [];

    bus.subscribe("user.*", () => {
      throw new Error("handler failed");
    });
    bus.subscribe("user.*", (event) => {
      received.push(event.type);
    });

    await expect(bus.publish(createEvent("user.message", {
      sessionId: "test-session",
      content: "hello"
    }))).resolves.toBeUndefined();

    expect(received).toEqual(["user.message"]);
  });
});
