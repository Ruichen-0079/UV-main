/**
 * Presentation-only transport for Subtitle Surface.
 *
 * Chain: committed assistant text (Main) → projectCommittedAssistantText →
 * this bus → SubtitlePage. Separated from CompanionBus so Subtitle never
 * gains TTS / language / speech-queue authority.
 */

export type SubtitleProjectionMessage =
  | {
      kind: "committed-assistant-text";
      messageId: string;
      requestId?: string;
      /** Already-projected plain text. Empty/whitespace must not be published. */
      text: string;
    }
  | { kind: "clear" };

type WireMessage = { message: SubtitleProjectionMessage };

const CHANNEL = "yuvi-subtitle-projection-v1";

export function publishSubtitleProjection(message: SubtitleProjectionMessage): void {
  if (typeof BroadcastChannel !== "function") return;
  const channel = new BroadcastChannel(CHANNEL);
  try {
    channel.postMessage({ message } satisfies WireMessage);
  } finally {
    channel.close();
  }
}

export function subscribeSubtitleProjection(
  listener: (message: SubtitleProjectionMessage) => void
): () => void {
  if (typeof BroadcastChannel !== "function") {
    return () => undefined;
  }
  const channel = new BroadcastChannel(CHANNEL);
  const onMessage = (event: MessageEvent<WireMessage>) => {
    const payload = event.data;
    if (!payload || typeof payload !== "object") return;
    const message = payload.message;
    if (!isSubtitleProjectionMessage(message)) return;
    listener(message);
  };
  channel.addEventListener("message", onMessage);
  return () => {
    channel.removeEventListener("message", onMessage);
    channel.close();
  };
}

export function isSubtitleProjectionMessage(value: unknown): value is SubtitleProjectionMessage {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "clear") {
    return Object.keys(value as object).every((key) => key === "kind");
  }
  if (kind !== "committed-assistant-text") return false;
  const message = value as Record<string, unknown>;
  if (typeof message["messageId"] !== "string" || message["messageId"].length === 0) return false;
  if (typeof message["text"] !== "string" || message["text"].trim().length === 0) return false;
  if (message["requestId"] !== undefined && typeof message["requestId"] !== "string") return false;
  return true;
}
