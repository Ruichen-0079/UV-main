import type { SpeechQueueState } from "./speech-queue.js";

/**
 * Minimal cross-window bus for the YUVI desktop split.
 *
 * The main window owns chat input and the text stream; the companion window
 * exclusively owns Lumi, the speech queue, audio playback and the Web Audio
 * analyser. Messages travel main -> companion (speech commands) and
 * companion -> main (speech status).
 *
 * Transport: BroadcastChannel works across same-origin browser tabs and
 * across Tauri v2 windows, which share one WebView2 environment and origin.
 * No Tauri IPC permissions are required for this prototype.
 */

export type CompanionBusRole = "main" | "companion";

export type CompanionGenerationState = "listening" | "thinking" | "idle" | "interrupted";

export type CompanionBusMessage =
  | { kind: "user-gesture" }
  | { kind: "start-generation"; requestId: string; sessionId: string }
  | { kind: "voice-enabled"; enabled: boolean }
  | { kind: "speak"; requestId: string; sequence: number; text: string; language: string }
  | { kind: "speech-end"; requestId: string }
  | { kind: "stop-speech"; requestId: string }
  | { kind: "generation-state"; requestId: string; state: CompanionGenerationState }
  | { kind: "companion-ready" }
  | { kind: "speech-status"; requestId: string; state: SpeechQueueState };

type WireMessage = { from: CompanionBusRole; message: CompanionBusMessage };

const busChannelName = "yuvi-companion-bus-v1";

const knownKinds = new Set<string>([
  "user-gesture",
  "start-generation",
  "voice-enabled",
  "speak",
  "speech-end",
  "stop-speech",
  "generation-state",
  "companion-ready",
  "speech-status"
]);

export class CompanionBus {
  private readonly channel: BroadcastChannel | null;
  private readonly listeners = new Set<(message: CompanionBusMessage) => void>();
  private readonly onWireMessage: (event: MessageEvent<WireMessage>) => void;

  constructor(private readonly role: CompanionBusRole) {
    this.channel =
      typeof BroadcastChannel === "function" ? new BroadcastChannel(busChannelName) : null;
    this.onWireMessage = (event) => {
      const payload = event.data;
      if (!isWireMessage(payload)) return;
      if (payload.from === this.role) return;
      const listeners = Array.from(this.listeners);
      for (const listener of listeners) listener(payload.message);
    };
    this.channel?.addEventListener("message", this.onWireMessage);
  }

  post(message: CompanionBusMessage): void {
    this.channel?.postMessage({ from: this.role, message } satisfies WireMessage);
  }

  subscribe(listener: (message: CompanionBusMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.channel?.removeEventListener("message", this.onWireMessage);
    this.channel?.close();
    this.listeners.clear();
  }
}

export function isCompanionBusMessage(value: unknown): value is CompanionBusMessage {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !knownKinds.has(kind)) return false;
  const message = value as Record<string, unknown>;
  switch (kind) {
    case "user-gesture":
    case "companion-ready":
      return Object.keys(message).every((key) => key === "kind");
    case "voice-enabled":
      return typeof message["enabled"] === "boolean";
    case "start-generation":
      return isNonEmptyString(message["requestId"]) && isNonEmptyString(message["sessionId"]);
    case "speak":
      return (
        isNonEmptyString(message["requestId"]) &&
        isNonNegativeInteger(message["sequence"]) &&
        typeof message["text"] === "string" &&
        typeof message["language"] === "string"
      );
    case "speech-end":
    case "stop-speech":
      return isNonEmptyString(message["requestId"]);
    case "generation-state":
      return isNonEmptyString(message["requestId"]) && isGenerationState(message["state"]);
    case "speech-status":
      return isNonEmptyString(message["requestId"]) && isSpeechQueueState(message["state"]);
  }
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isGenerationState(value: unknown): value is CompanionGenerationState {
  return (
    value === "listening" || value === "thinking" || value === "idle" || value === "interrupted"
  );
}

function isSpeechQueueState(value: unknown): value is SpeechQueueState {
  return (
    value === "idle" ||
    value === "synthesizing" ||
    value === "playing" ||
    value === "stopped" ||
    value === "error"
  );
}

function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WireMessage>;
  if (candidate.from !== "main" && candidate.from !== "companion") return false;
  return isCompanionBusMessage(candidate.message);
}
