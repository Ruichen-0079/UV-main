export type FakeNode = {
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

export function installFakeDom(): { container: FakeNode; restore(): void } {
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

export function readText(node: FakeNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  return node.childNodes.length > 0 ? node.childNodes.map(readText).join("") : node.textContent;
}
