import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, readText, type FakeNode } from "./test-dom.js";
const mock = vi.hoisted(() => ({
  listen: vi.fn(),
  read: vi.fn(),
  importZip: vi.fn(),
  remove: vi.fn()
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mock.listen })
}));
vi.mock("./tauri-window.js", () => ({ isTauriRuntime: () => true, invokeDesktop: mock.read }));
vi.mock("./api/client.js", () => ({
  apiClient: {
    getLive2DModels: async () => ({ models: [], activeId: null }),
    importLive2DZip: mock.importZip
  }
}));
import { ProductLive2DModels } from "./product-live2d-models.js";
let root: Root | undefined;
let dom: ReturnType<typeof installFakeDom> | undefined;
let drop: (event: unknown) => Promise<void>;
function nodes(node: FakeNode): FakeNode[] {
  return [node, ...node.childNodes.flatMap(nodes)];
}
function props(node: FakeNode): any {
  return (node as any)[Object.keys(node).find((k) => k.startsWith("__reactProps$"))!];
}
afterEach(async () => {
  await act(async () => root?.unmount());
  dom?.restore();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function mount() {
  dom = installFakeDom();
  Object.assign(window, { devicePixelRatio: 2 });
  mock.listen.mockImplementation(async (handler) => {
    drop = handler;
    return mock.remove;
  });
  mock.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  vi.stubGlobal(
    "FileReader",
    class {
      result = "data:application/zip;base64,AQID";
      onload?: () => void;
      readAsDataURL() {
        this.onload?.();
      }
    }
  );
  await act(async () => {
    root = createRoot(dom!.container as unknown as Element);
    root.render(<ProductLive2DModels />);
  });
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  const zone = nodes(dom.container).find(
    (n) => n.attributes["data-testid"] === "live2d-zip-dropzone"
  )!;
  Object.assign(zone, {
    getBoundingClientRect: () => ({ left: 100, right: 300, top: 100, bottom: 200 })
  });
  return dom.container;
}
const event = (paths = ["/home/user/桌面/Lumi.zip"], x = 400) => ({
  payload: { type: "drop", paths, position: { x, y: 300 } }
});
it("converts a native drop into the picker selection and uses the existing importer", async () => {
  const node = await mount();
  await act(async () => drop(event()));
  expect(mock.read).toHaveBeenCalledWith("read_dropped_archive", {
    path: "/home/user/桌面/Lumi.zip"
  });
  expect(readText(node)).toContain("Lumi.zip");
  const button = nodes(node).find((n) => n.tagName === "BUTTON" && readText(n) === "Import ZIP")!;
  expect(props(button).disabled).toBe(false);
  await act(async () => props(button).onClick());
  expect(mock.importZip).toHaveBeenCalledOnce();
  expect(mock.importZip).toHaveBeenCalledWith({ name: "Lumi", archiveBase64: "AQID" });
  expect(readText(node)).toContain("Model ZIP installed and selected.");
  await act(async () => root!.unmount());
  root = undefined;
  expect(mock.remove).toHaveBeenCalledOnce();
});
it("ignores drops outside the zone and rejects multiple files without reading them", async () => {
  const node = await mount();
  await act(async () => drop(event(undefined, 10)));
  expect(mock.read).not.toHaveBeenCalled();
  await act(async () => drop(event(["a.zip", "b.zip"])));
  expect(mock.read).not.toHaveBeenCalled();
  expect(readText(node)).toContain("Choose one Live2D ZIP at a time.");
});
it("shows a native read failure and releases selection controls", async () => {
  const node = await mount();
  mock.read.mockRejectedValue(new Error("File disappeared"));
  await act(async () => drop(event()));
  expect(readText(node)).toContain("File disappeared");
  const picker = nodes(node).find((n) => n.tagName === "BUTTON" && readText(n) === "Choose ZIP")!;
  expect(props(picker).disabled).toBe(false);
  expect(mock.importZip).not.toHaveBeenCalled();
});
