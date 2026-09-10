import type { LumiModelLifecycle } from "./lumi-live2d.js";

export type Live2DModelSelectionProjection =
  | { kind: "selected"; id: string; name: string }
  | { kind: "none" }
  | { kind: "unavailable" };

export type Live2DRendererStatus = "no_model" | "loading" | "ready" | "failed";

export type CompanionRendererPresentation = {
  status: Live2DRendererStatus;
  activeModelId: string | null;
  activeModelName: string | null;
};

export function deriveCompanionRendererPresentation(
  selection: Live2DModelSelectionProjection | null,
  lifecycle: LumiModelLifecycle
): CompanionRendererPresentation {
  if (selection === null) {
    return { status: "loading", activeModelId: null, activeModelName: null };
  }
  if (selection.kind === "none") {
    return { status: "no_model", activeModelId: null, activeModelName: null };
  }
  if (selection.kind === "unavailable") {
    return { status: "failed", activeModelId: null, activeModelName: null };
  }

  const status: Live2DRendererStatus =
    lifecycle === "ready" ? "ready" : lifecycle === "loading" ? "loading" : "failed";
  return {
    status,
    activeModelId: selection.id,
    activeModelName: selection.name
  };
}

export function isCompanionRendererPresentation(
  value: unknown
): value is CompanionRendererPresentation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CompanionRendererPresentation>;
  return (
    (candidate.status === "no_model" ||
      candidate.status === "loading" ||
      candidate.status === "ready" ||
      candidate.status === "failed") &&
    (candidate.activeModelId === null || typeof candidate.activeModelId === "string") &&
    (candidate.activeModelName === null || typeof candidate.activeModelName === "string")
  );
}

type ProjectionWireMessage =
  | { kind: "request" }
  | { kind: "state"; state: CompanionRendererPresentation };

const channelName = "yuvi-companion-presentation-v1";

export class CompanionPresentationProjectionChannel {
  private readonly channel: BroadcastChannel | null;
  private readonly stateListeners = new Set<(state: CompanionRendererPresentation) => void>();
  private readonly requestListeners = new Set<() => void>();
  private readonly onMessage = (event: MessageEvent<ProjectionWireMessage>): void => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.kind === "request") {
      for (const listener of Array.from(this.requestListeners)) listener();
      return;
    }
    if (message.kind === "state" && isCompanionRendererPresentation(message.state)) {
      for (const listener of Array.from(this.stateListeners)) listener(message.state);
    }
  };

  constructor() {
    this.channel =
      typeof BroadcastChannel === "function" ? new BroadcastChannel(channelName) : null;
    this.channel?.addEventListener("message", this.onMessage);
  }

  postState(state: CompanionRendererPresentation): void {
    this.channel?.postMessage({ kind: "state", state } satisfies ProjectionWireMessage);
  }

  requestState(): void {
    this.channel?.postMessage({ kind: "request" } satisfies ProjectionWireMessage);
  }

  subscribeState(listener: (state: CompanionRendererPresentation) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  subscribeRequests(listener: () => void): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  close(): void {
    this.channel?.removeEventListener("message", this.onMessage);
    this.channel?.close();
    this.stateListeners.clear();
    this.requestListeners.clear();
  }
}
