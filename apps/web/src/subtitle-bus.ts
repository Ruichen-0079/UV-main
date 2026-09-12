import { controlSubtitleWindow } from "./tauri-window.js";

/**
 * Presentation-only transport for Subtitle Surface.
 *
 * Chain: committed assistant text (Companion, with or without playback) →
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
      /** Runtime-selected output language; presentation never re-detects it. */
      language?: string;
    }
  | { kind: "clear" };

type WireMessage = { message: SubtitleProjectionMessage } | { ready: true };

const CHANNEL = "yuvi-subtitle-projection-v1";

let publisher: BroadcastChannel | null = null;
let latest: SubtitleProjectionMessage | null = null;

export function publishSubtitleProjection(message: SubtitleProjectionMessage): void {
  if (typeof BroadcastChannel !== "function") return;
  if (!publisher) {
    publisher = new BroadcastChannel(CHANNEL);
    // Node's test transport must not keep the process alive.
    (publisher as BroadcastChannel & { unref?: () => void }).unref?.();
    publisher.addEventListener("message", (event: MessageEvent<WireMessage>) => {
      if (event.data && "ready" in event.data && event.data.ready && latest) {
        publisher?.postMessage({ message: latest } satisfies WireMessage);
      }
    });
  }
  latest = message;
  publisher.postMessage({ message } satisfies WireMessage);
  if (message.kind === "committed-assistant-text") {
    // The surface is lazy. Its ready handshake replays this projection after
    // mounting, so first text cannot disappear between show() and subscribe().
    void controlSubtitleWindow("show").catch((error: unknown) => {
      console.error("Subtitle window could not be shown", error);
    });
  }
}

export function subscribeSubtitleProjection(
  listener: (message: SubtitleProjectionMessage) => void
): () => void {
  if (typeof BroadcastChannel !== "function") {
    return () => undefined;
  }
  const channel = new BroadcastChannel(CHANNEL);
  let lastMessageId: string | null = null;
  const onMessage = (event: MessageEvent<WireMessage>) => {
    const payload = event.data;
    if (!payload || typeof payload !== "object") return;
    if (!("message" in payload)) return;
    const message = payload.message;
    if (!isSubtitleProjectionMessage(message)) return;
    if (message.kind === "committed-assistant-text") {
      if (message.messageId === lastMessageId) return;
      lastMessageId = message.messageId;
    } else lastMessageId = null;
    listener(message);
  };
  channel.addEventListener("message", onMessage);
  channel.postMessage({ ready: true } satisfies WireMessage);
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
  if (message["language"] !== undefined && typeof message["language"] !== "string") return false;
  return true;
}
