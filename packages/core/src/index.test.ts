import { type ChatStreamEvent, type ChatProvider } from "@companion/providers";

function createExactStreamingChatProvider(name: string, events: ChatStreamEvent[]): ChatProvider {
  const completed = events.find((event) => event.type === "completed");
  return {
    name,
    async healthCheck() {
      return {
        provider: name,
        status: "healthy" as const,
        checkedAt: new Date().toISOString()
      };
    },
    async generateReply() {
      return completed?.type === "completed"
        ? completed.output
        : { message: { role: "assistant", content: "" } };
    },
    async *streamReply(): AsyncIterable<ChatStreamEvent> {
      yield* events;
    }
  };
}
