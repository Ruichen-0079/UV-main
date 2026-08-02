import type { ProviderCallMetadata } from "./api/client.js";

export type ChatMessageStatus = "streaming" | "completed" | "failed" | "cancelled";

export type ChatMessage = {
  id: string;
  requestId?: string;
  role: "user" | "assistant";
  content: string;
  status?: ChatMessageStatus;
  error?: string;
  traceId?: string;
  useMemory?: boolean;
  readMemory?: boolean;
  writeMemory?: boolean;
  voiceOutput?: boolean;
  provider?: ProviderCallMetadata | string;
};

export type ChatMessageAction =
  | { type: "append-turn"; user: ChatMessage; assistant: ChatMessage }
  | { type: "append-delta"; assistantId: string; text: string; traceId: string }
  | {
      type: "complete";
      assistantId: string;
      content: string;
      traceId: string;
      provider: string;
    }
  | { type: "fail"; assistantId: string; error: string }
  | { type: "cancel"; assistantId: string; error: string };

export function reduceChatMessages(
  messages: ChatMessage[],
  action: ChatMessageAction
): ChatMessage[] {
  if (action.type === "append-turn") {
    return [...messages, action.user, action.assistant];
  }

  const target = messages.find(
    (message) => message.id === action.assistantId && message.role === "assistant"
  );
  if (!target) {
    return messages;
  }

  if (action.type === "append-delta") {
    if (target.status !== "streaming") {
      return messages;
    }
    return replaceAssistant(messages, action.assistantId, {
      content: target.content + action.text,
      traceId: action.traceId
    });
  }

  if (action.type === "complete") {
    if (target.status === "completed") {
      return messages;
    }
    if (target.status !== "streaming") {
      return messages;
    }
    return replaceAssistant(messages, action.assistantId, {
      content: action.content,
      traceId: action.traceId,
      provider: action.provider,
      status: "completed"
    });
  }

  if (target.status !== "streaming") {
    return messages;
  }
  return replaceAssistant(messages, action.assistantId, {
    status: action.type === "cancel" ? "cancelled" : "failed",
    error: action.error
  });
}

export function shouldSubmitChatKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

function replaceAssistant(
  messages: ChatMessage[],
  assistantId: string,
  update: Partial<ChatMessage>
): ChatMessage[] {
  return messages.map((message) =>
    message.id === assistantId ? { ...message, ...update } : message
  );
}
