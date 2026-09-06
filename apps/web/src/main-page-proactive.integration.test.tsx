import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const mockState = vi.hoisted(() => ({
  buses: [] as MockCompanionBus[],
  streamProactiveTurn: vi.fn(),
  subscribeProactiveLive: vi.fn()
}));

class MockCompanionBus {
  readonly posted: unknown[] = [];
  private readonly listeners = new Set<(message: unknown) => void>();

  constructor(readonly role: "main" | "companion") {
    mockState.buses.push(this);
  }

  post(message: unknown): void {
    this.posted.push(message);
  }

  subscribe(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) listener(message);
  }

  close(): void {
    this.listeners.clear();
  }
}

vi.mock("./companion-bus.js", () => ({ CompanionBus: MockCompanionBus }));

vi.mock("./api/client.js", () => ({
  ApiError: class ApiError extends Error {},
  apiClient: {
    streamMessage: vi.fn(),
    streamProactiveTurn: mockState.streamProactiveTurn,
    subscribeProactiveLive: mockState.subscribeProactiveLive,
    setProactiveConsent: vi.fn(async () => ({ ok: true, enabled: true })),
    // Main product path now opens a dashboard event stream; keep proactive
    // tests isolated by providing a no-op socket.
    createDashboardWebSocket: () => {
      const listeners = new Map<string, Set<(event: { data?: string }) => void>>();
      return {
        addEventListener(type: string, listener: (event: { data?: string }) => void) {
          const set = listeners.get(type) ?? new Set();
          set.add(listener);
          listeners.set(type, set);
        },
        removeEventListener(type: string, listener: (event: { data?: string }) => void) {
          listeners.get(type)?.delete(listener);
        },
        close() {}
      };
    }
  }
}));

vi.mock("./tauri-window.js", () => ({
  controlCompanionWindow: vi.fn(),
  controlWebUIWindow: vi.fn(),
  isTauriRuntime: () => true
}));

vi.mock("./service-supervisor-client.js", () => ({
  isServiceSupervisorAvailable: () => false,
  subscribeServiceStatusState: vi.fn()
}));

vi.mock("./service-status-panel.js", () => ({ ServiceStatusPanel: () => null }));
vi.mock("./user-settings-panel.js", () => ({ UserSettingsPanel: () => null }));
vi.mock("./voice-output.js", () => ({
  readVoiceOutputPreference: () => true,
  writeVoiceOutputPreference: vi.fn(),
  VOICE_OUTPUT_STORAGE_KEY: "yuvi.main.voiceOutput"
}));

vi.mock("./user-settings-client.js", () => ({
  fetchUserSettings: vi.fn(async () => ({
    loadError: null,
    revision: 1,
    settings: {
      proactive: { enabled: true },
      tts: { enabled: true, mode: "external" }
    }
  })),
  subscribeUserSettingsChanged: vi.fn((_listener: (event: unknown) => void) => () => undefined)
}));

vi.mock("./markdown-message.js", async () => {
  const React = await import("react");
  return {
    ChatMessageContent: ({ content }: { content: string }) =>
      React.createElement("span", null, content)
  };
});

vi.mock("./surface-ui.js", async () => {
  const React = await import("react");
  const Slot = ({ children }: { children?: import("react").ReactNode }) =>
    React.createElement("div", null, children);
  return {
    EmptyState: Slot,
    Field: Slot,
    Notice: Slot,
    Panel: Slot,
    Pill: Slot,
    Toggle: Slot
  };
});

import { installFakeDom, readText } from "./test-dom.js";

afterEach(() => {
  mockState.buses.length = 0;
  mockState.streamProactiveTurn.mockReset();
  mockState.subscribeProactiveLive.mockReset();
});

describe("MainPage proactive CompanionBus bridge", () => {
  it("does not let a companion opportunity start a Runtime proactive attempt", async () => {
    mockState.subscribeProactiveLive.mockImplementation(async () => undefined);

    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement((await import("./main-page.js")).MainPage));
        await Promise.resolve();
        await Promise.resolve();
      });

      const bus = mockState.buses[0];
      expect(bus?.role).toBe("main");
      await act(async () => {
        bus?.emit({
          kind: "proactive-text-request",
          decisionId: "decision-live",
          modality: "text"
        });
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockState.streamProactiveTurn).not.toHaveBeenCalled();
      expect(bus?.posted).toContainEqual({
        kind: "proactive-text-admission-result",
        decisionId: "decision-live",
        decision: "denied",
        reason: "not-eligible"
      });
      expect(readText(dom.container)).not.toContain("proactive reply");
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("projects a Runtime-scheduled assistant-only reply and ignores NO_OP", async () => {
    mockState.subscribeProactiveLive.mockImplementation(async (_sessionId, options) => {
      options.onEvent?.({
        type: "proactive-decision",
        decision: "NO_OP",
        sessionId: "default",
        traceId: "trace-no-op"
      });
      options.onEvent?.({
        type: "proactive-decision",
        decision: "REQUEST_TEXT",
        sessionId: "default",
        traceId: "trace-proactive"
      });
      options.onEvent?.({
        type: "text-delta",
        text: "proactive reply",
        messageId: "assistant-message",
        sessionId: "default",
        traceId: "trace-proactive"
      });
      options.onEvent?.({
        type: "completed",
        content: "proactive reply",
        messageId: "assistant-message",
        sessionId: "default",
        traceId: "trace-proactive",
        provider: "mock"
      });
    });

    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement((await import("./main-page.js")).MainPage));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockState.subscribeProactiveLive).toHaveBeenCalled();
      expect(mockState.streamProactiveTurn).not.toHaveBeenCalled();
      expect(readText(dom.container)).toContain("proactive reply");
      expect(readText(dom.container)).toContain("assistant");
      expect(readText(dom.container)).not.toContain("user");
      expect(readText(dom.container)).not.toContain("trace-no-op");
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });

  it("still subscribes to Runtime-scheduled turns when the local settings toggle is off", async () => {
    const { fetchUserSettings } = await import("./user-settings-client.js");
    vi.mocked(fetchUserSettings).mockResolvedValueOnce({
      loadError: null,
      revision: 1,
      settings: {
        proactive: { enabled: false },
        tts: { enabled: true, mode: "external" }
      }
    } as never);
    mockState.subscribeProactiveLive.mockImplementation(async () => undefined);

    const dom = installFakeDom();
    let root!: Root;
    try {
      await act(async () => {
        root = createRoot(dom.container as unknown as Element);
        root.render(createElement((await import("./main-page.js")).MainPage));
        await Promise.resolve();
        await Promise.resolve();
      });
      const bus = mockState.buses[0];
      await act(async () => {
        bus?.emit({
          kind: "proactive-text-request",
          decisionId: "decision-consent-off",
          modality: "text"
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockState.subscribeProactiveLive).toHaveBeenCalled();
      expect(mockState.streamProactiveTurn).not.toHaveBeenCalled();
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });
});


it("converges Main and Companion TTS after a WebUI settings change", async () => {
  mockState.subscribeProactiveLive.mockImplementation(async () => undefined);
  const { fetchUserSettings, subscribeUserSettingsChanged } = await import("./user-settings-client.js");
  const dom = installFakeDom();
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(dom.container as unknown as Element);
      root.render(createElement((await import("./main-page.js")).MainPage));
    });
    const listener = vi.mocked(subscribeUserSettingsChanged).mock.calls.at(-1)?.[0];
    expect(listener).toBeDefined();
    vi.mocked(fetchUserSettings).mockResolvedValueOnce({
      loadError: null, revision: 2,
      settings: { proactive: { enabled: true }, tts: { enabled: false, mode: "external" } }
    } as Awaited<ReturnType<typeof fetchUserSettings>>);
    await act(async () => {
      listener?.({ revision: 2, changedSections: ["tts"] } as Parameters<NonNullable<typeof listener>>[0]);
    });
    expect(mockState.buses[0]?.posted).toContainEqual({
      kind: "tts-config", config: { enabled: false, mode: "external" }
    });
  } finally {
    await act(async () => root?.unmount());
    dom.restore();
  }
});
