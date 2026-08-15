import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanionPage } from "./companion-page.js";

const mockState = vi.hoisted(() => ({
  buses: [] as any[],
  queues: [] as any[]
}));

vi.mock("./companion-bus.js", () => {
  class MockCompanionBus {
    private readonly listeners = new Set<(message: any) => void>();
    readonly posted: any[] = [];

    constructor(public readonly role: string) {
      mockState.buses.push(this);
    }

    post(message: any): void {
      this.posted.push(message);
    }

    subscribe(listener: (message: any) => void): () => void {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(message: any): void {
      for (const listener of this.listeners) listener(message);
    }

    close(): void {
      this.listeners.clear();
    }
  }

  return { CompanionBus: MockCompanionBus };
});

vi.mock("./companion-voice-sync.js", () => ({
  createCompanionReadyAnnouncer: () => ({
    start: () => undefined,
    markSynced: () => undefined,
    stop: () => undefined
  })
}));

vi.mock("./lumi-canvas.js", async () => {
  const react = await import("react");
  const LumiCanvas = react.forwardRef((props: { requestedPresence: string }, ref) => {
    react.useImperativeHandle(ref, () => ({
      handlePlaybackEvent: () => undefined,
      resumeAudio: () => undefined,
      setFraming: () => undefined,
      setPresence: () => undefined,
      setPresenceAnimation: () => undefined,
      load: async () => undefined,
      runMouthCalibration: async () => undefined,
      resize: () => undefined,
      dispose: () => undefined,
      getPresence: () => props.requestedPresence,
      getFramingDiagnostics: () => null,
      getDebugInfo: () => ({ instanceId: 0, generation: 0 })
    }));
    return react.createElement("div", { "aria-label": "Lumi avatar" }, "Lumi avatar");
  });
  return { LumiCanvas };
});

vi.mock("./speech-queue.js", () => {
  class MockSpeechPlaybackQueue {
    readonly callbacks: any;
    cancelCalls = 0;

    constructor(_synthesize: any, _play: any, callbacks: any) {
      this.callbacks = callbacks;
      mockState.queues.push(this);
    }

    enqueue(): void {}

    finish(): void {
      this.callbacks.onState?.("idle");
    }

    cancel(): void {
      this.cancelCalls += 1;
      this.callbacks.onPlaybackEvent?.({
        type: "playbackStopped",
        audio: {},
        sequence: 0
      });
      this.callbacks.onState?.("stopped");
    }

    emitPlayback(type: "playbackStarted" | "playbackEnded"): void {
      this.callbacks.onPlaybackEvent?.({ type, audio: {}, sequence: 0 });
    }
  }

  return {
    SpeechPlaybackQueue: MockSpeechPlaybackQueue,
    createBrowserSpeechPlayer: () => () => Promise.resolve()
  };
});

vi.mock("./tauri-window.js", () => ({
  isTauriRuntime: () =>
    Boolean(
      (globalThis as { window?: { __TAURI_INTERNALS__?: unknown } }).window?.__TAURI_INTERNALS__
    ),
  preloadTauriWindowApi: async () => undefined,
  startWindowResizeDragging: async () => undefined
}));

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
  appendChild(node: FakeNode): FakeNode;
  insertBefore(node: FakeNode, before: FakeNode | null): FakeNode;
  removeChild(node: FakeNode): FakeNode;
  setAttribute(name: string, value: unknown): void;
  removeAttribute(name: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  textContent: string;
  namespaceURI: string;
};

type FakeDocument = {
  nodeType: 9;
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
      textContent: nodeValue ?? "",
      namespaceURI: "http://www.w3.org/1999/xhtml"
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
  return node.childNodes.map(readText).join("");
}

async function mountCompanionPage(): Promise<{
  root: Root;
  container: FakeNode;
  restore(): void;
}> {
  const dom = installFakeDom();
  let root!: Root;
  await act(async () => {
    root = createRoot(dom.container as unknown as Element);
    root.render(createElement(CompanionPage));
    await Promise.resolve();
  });
  return { root, ...dom };
}

async function emitBus(bus: any, message: any): Promise<void> {
  await act(async () => {
    bus.emit(message);
    await Promise.resolve();
  });
}

async function emitPlayback(queue: any, type: "playbackStarted" | "playbackEnded"): Promise<void> {
  await act(async () => {
    queue.emitPlayback(type);
    await Promise.resolve();
  });
}

afterEach(() => {
  mockState.buses.length = 0;
  mockState.queues.length = 0;
  delete (globalThis as { window?: unknown }).window;
});

describe("CompanionPage Tauri chrome", () => {
  it("renders without crashing and without Tauri chrome in a plain browser", () => {
    expect(() => renderToStaticMarkup(<CompanionPage />)).not.toThrow();
    const markup = renderToStaticMarkup(<CompanionPage />);
    expect(markup).toContain("Lumi avatar");
    expect(markup).not.toContain("data-tauri-drag-region");
    expect(markup).not.toContain("Resize window");
  });

  it("renders the drag bar and resize handle only inside Tauri", () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    const markup = renderToStaticMarkup(<CompanionPage />);
    expect(markup).toContain("data-tauri-drag-region");
    expect(markup).toContain('aria-label="Resize window"');
  });
});

describe("CompanionPage generation interruption admission", () => {
  it("ignores a terminal interruption without cancelling post-generation speech", async () => {
    const mounted = await mountCompanionPage();
    try {
      const bus = mockState.buses.at(-1);
      await emitBus(bus, { kind: "start-generation", requestId: "turn-a", sessionId: "session" });
      const queue = mockState.queues.at(-1);
      await emitPlayback(queue, "playbackStarted");
      await emitBus(bus, { kind: "generation-state", requestId: "turn-a", state: "idle" });

      await emitBus(bus, { kind: "generation-state", requestId: "turn-a", state: "interrupted" });

      expect(queue.cancelCalls).toBe(0);
      expect(readText(mounted.container)).toContain("speaking");

      await emitPlayback(queue, "playbackEnded");
      expect(readText(mounted.container)).toContain("idle");
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });

  it("still cancels resources for an active interruption", async () => {
    const mounted = await mountCompanionPage();
    try {
      const bus = mockState.buses.at(-1);
      await emitBus(bus, { kind: "start-generation", requestId: "turn-a", sessionId: "session" });
      const queue = mockState.queues.at(-1);

      await emitBus(bus, { kind: "generation-state", requestId: "turn-a", state: "interrupted" });

      expect(queue.cancelCalls).toBe(1);
      expect(readText(mounted.container)).toContain("interrupted");
    } finally {
      await act(async () => mounted.root.unmount());
      mounted.restore();
    }
  });
});
