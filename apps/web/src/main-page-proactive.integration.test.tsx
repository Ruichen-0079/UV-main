import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const mockState = vi.hoisted(() => ({
  buses: [] as MockCompanionBus[],
  streamProactiveTurn: vi.fn()
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
    streamProactiveTurn: mockState.streamProactiveTurn
  }
}));

vi.mock("./tauri-window.js", () => ({
  controlCompanionWindow: vi.fn(),
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
  subscribeUserSettingsChanged: vi.fn(() => () => undefined)
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

type FakeNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  nodeValue?: string | null;
  style: Record<string, string>;
  attributes: Record<string, string>;
  namespaceURI: string;
  appendChild(node: FakeNode): FakeNode;
  insertBefore(node: FakeNode, before: FakeNode | null): FakeNode;
  removeChild(node: FakeNode): FakeNode;
  setAttribute(name: string, value: unknown): void;
  removeAttribute(name: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  focus(): void;
  textContent: string;
};

type FakeDocument = {
  nodeType: 9;
  visibilityState: "visible";
  body: FakeNode;
  documentElement: FakeNode;
  activeElement: FakeNode;
  defaultView: Record<string, unknown>;
  createElement(tag: string): FakeNode;
  createElementNS(namespace: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  createComment(text: string): FakeNode;
  addEventListener(): void;
  removeEventListener(): void;
};

function installFakeDom(): { container: FakeNode; restore(): void } {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousActEnvironment = (globalThis as Record<string, unknown>)[
    "IS_REACT_ACT_ENVIRONMENT"
  ];

  const makeNode = (tag: string, nodeType = 1, nodeValue: string | null = null): FakeNode => {
    const node = {
      nodeType,
      nodeName: nodeType === 3 ? "#text" : tag.toUpperCase(),
      tagName: tag.toUpperCase(),
      ownerDocument: undefined as unknown as FakeDocument,
      parentNode: null,
      childNodes: [],
      nodeValue,
      style: {},
      attributes: {},
      namespaceURI: "http://www.w3.org/1999/xhtml",
      appendChild(child: FakeNode) {
        this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
      insertBefore(child: FakeNode, before: FakeNode | null) {
        const index = before === null ? -1 : this.childNodes.indexOf(before);
        if (index < 0) this.childNodes.push(child);
        else this.childNodes.splice(index, 0, child);
        child.parentNode = this;
        return child;
      },
      removeChild(child: FakeNode) {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      setAttribute(name: string, value: unknown) {
        this.attributes[name] = String(value);
      },
      removeAttribute(name: string) {
        delete this.attributes[name];
      },
      addEventListener() {},
      removeEventListener() {},
      focus() {},
      textContent: nodeValue ?? ""
    } satisfies FakeNode;
    return node;
  };

  const windowObject = {
    HTMLIFrameElement: class {},
    HTMLElement: class {},
    SVGElement: class {},
    Element: class {},
    Node: class {},
    Document: class {},
    addEventListener() {},
    removeEventListener() {},
    document: undefined as unknown as FakeDocument
  };
  const documentObject = {
    nodeType: 9,
    visibilityState: "visible" as const,
    body: undefined as unknown as FakeNode,
    documentElement: undefined as unknown as FakeNode,
    activeElement: undefined as unknown as FakeNode,
    defaultView: windowObject,
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_namespace: string, tag: string) => makeNode(tag),
    createTextNode: (text: string) => makeNode("#text", 3, text),
    createComment: (text: string) => makeNode("#comment", 8, text),
    addEventListener() {},
    removeEventListener() {}
  } satisfies FakeDocument;

  documentObject.body = makeNode("body");
  documentObject.documentElement = makeNode("html");
  documentObject.activeElement = documentObject.body;
  for (const node of [documentObject.body, documentObject.documentElement]) {
    node.ownerDocument = documentObject;
  }
  windowObject.document = documentObject;
  globalThis.document = documentObject as unknown as Document;
  globalThis.window = windowObject as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent: "node" }
  });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => undefined;
  (globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

  const container = makeNode("div");
  container.ownerDocument = documentObject;
  return {
    container,
    restore() {
      const globalObject = globalThis as Record<string, unknown>;
      if (previousDocument === undefined) delete globalObject["document"];
      else globalObject["document"] = previousDocument;
      if (previousWindow === undefined) delete globalObject["window"];
      else globalObject["window"] = previousWindow;
      if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
      else delete (globalThis as { navigator?: unknown }).navigator;
      globalThis.requestAnimationFrame = previousRequestAnimationFrame;
      globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
      if (previousActEnvironment === undefined) {
        delete globalObject["IS_REACT_ACT_ENVIRONMENT"];
      } else {
        globalObject["IS_REACT_ACT_ENVIRONMENT"] = previousActEnvironment;
      }
    }
  };
}

function readText(node: FakeNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  return node.childNodes.length > 0 ? node.childNodes.map(readText).join("") : node.textContent;
}

afterEach(() => {
  mockState.buses.length = 0;
  mockState.streamProactiveTurn.mockReset();
});

describe("MainPage proactive CompanionBus bridge", () => {
  it("admits a bus candidate, streams it, and projects one assistant-only reply", async () => {
    const completed = {
      type: "completed" as const,
      content: "proactive reply",
      messageId: "assistant-message",
      sessionId: "default",
      traceId: "trace-proactive",
      provider: "mock"
    };
    mockState.streamProactiveTurn.mockImplementation(async (_request, options) => {
      options.onEvent?.({
        type: "text-delta",
        text: completed.content,
        messageId: completed.messageId,
        sessionId: completed.sessionId,
        traceId: completed.traceId
      });
      return completed;
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

      expect(mockState.streamProactiveTurn).toHaveBeenCalledTimes(1);
      const [request] = mockState.streamProactiveTurn.mock.calls[0] ?? [];
      expect(request).toMatchObject({
        sessionId: "default",
        modality: "text",
        options: { readMemory: true, promptPreview: true }
      });
      expect(request.idempotencyKey).not.toBe("decision-live");
      expect(bus?.posted).toContainEqual({
        kind: "proactive-text-admission-result",
        decisionId: "decision-live",
        decision: "accepted",
        reason: "consent-enabled"
      });
      expect(readText(dom.container)).toContain("proactive reply");
      expect(readText(dom.container)).toContain("assistant");
      expect(readText(dom.container)).not.toContain("user");
    } finally {
      await act(async () => root?.unmount());
      dom.restore();
    }
  });
});
