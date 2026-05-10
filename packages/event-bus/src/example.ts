import { createEvent, type RuntimeEvent, type UserMessageEvent } from "@companion/protocol";
import { InMemoryEventBus } from "./index.js";

type AgentReplyPayload = {
  sessionId: string;
  content: string;
};

export async function runUserMessageToAgentReplyExample(): Promise<RuntimeEvent<"agent.reply", AgentReplyPayload>> {
  const bus = new InMemoryEventBus({ development: true });
  let reply: RuntimeEvent<"agent.reply", AgentReplyPayload> | undefined;

  bus.subscribe<UserMessageEvent>("user.message", async (event) => {
    const agentReply = createEvent(
      "agent.reply",
      {
        sessionId: event.payload.sessionId,
        content: `Echo: ${event.payload.content}`
      },
      {
        traceId: event.traceId,
        parentId: event.id
      }
    );

    await bus.publish(agentReply);
  });

  bus.subscribe<RuntimeEvent<"agent.reply", AgentReplyPayload>>("agent.*", (event) => {
    reply = event;
  });

  await bus.publish(createEvent("user.message", {
    sessionId: "example-session",
    content: "hello"
  }));

  if (!reply) {
    throw new Error("Expected agent.reply event to be published.");
  }

  return reply;
}
