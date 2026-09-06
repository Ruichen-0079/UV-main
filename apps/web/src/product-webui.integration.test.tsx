import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, readText, type FakeNode } from "./test-dom.js";

const state = vi.hoisted(() => ({
  update: vi.fn(),
  reload: vi.fn(),
  settings: {} as any
}));
vi.mock("./api/client.js", () => ({
  apiClient: {
    getRuntimeSettings: async () => state.settings,
    getProviderStatus: async () => ({ providers: {}, routes: {} }),
    getEvents: async () => [],
    getHealth: async () => null,
    updateRuntimeSettings: state.update,
    reloadRuntimeSettings: state.reload
  }
}));
vi.mock("./App.js", () => ({ App: () => <div>Developer dashboard</div> }));
vi.mock("./pages/settings-page.js", () => ({ SettingsPage: () => <div>Runtime settings</div> }));
vi.mock("./user-settings-panel.js", () => ({
  UserSettingsPanel: () => <div>Desktop settings</div>
}));

function button(node: FakeNode, label: string): FakeNode | undefined {
  if (node.tagName === "BUTTON" && readText(node) === label) return node;
  for (const child of node.childNodes) {
    const found = button(child, label);
    if (found) return found;
  }
}
function click(node: FakeNode | undefined): void {
  expect(node).toBeDefined();
  const key = Object.keys(node!).find((key) => key.startsWith("__reactProps$"))!;
  const props = (node as unknown as Record<string, { onClick(): void; disabled?: boolean }>)[key]!;
  expect(props.disabled).not.toBe(true);
  props.onClick();
}
let root: Root | undefined;
let dom: ReturnType<typeof installFakeDom> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  dom?.restore();
  vi.clearAllMocks();
});
async function mount(element: JSX.Element) {
  dom = installFakeDom();
  await act(async () => {
    root = createRoot(dom!.container as unknown as Element);
    root.render(<StrictMode>{element}</StrictMode>);
  });
  return dom.container;
}
describe("Product WebUI integration", () => {
  it("keeps current settings and Developer reachable from the product shell", async () => {
    const { ProductWebUI } = await import("./product-webui.js");
    const node = await mount(<ProductWebUI />);
    await act(async () => click(button(node, "Settings")));
    expect(readText(node)).toContain("Runtime settings");
    expect(readText(node)).toContain("Desktop settings");
    await act(async () => click(button(node, "Developer")));
    expect(readText(node)).toContain("Developer dashboard");
    await act(async () => click(button(node, "← Product WebUI")));
    expect(readText(node)).toContain("Daily control surface");
  });
  it.each(["models", "routing"])(
    "finishes %s save and re-enables controls after StrictMode effect replay",
    async (view) => {
      state.settings = {
        settings: {},
        runtime: {},
        activeRuntimeConfig: {},
        providers: { deepseek: {}, openaiCompatible: {}, xai: {}, dashscope: {}, embedding: {} }
      };
      state.update.mockResolvedValue({
        settings: state.settings,
        changedKeys: [],
        restartRequired: false
      });
      state.reload.mockResolvedValue({ applied: true, notHotReloaded: [], restartRequired: false });
      const { ProductModelsProviders } = await import("./product-models-providers.js");
      const { ProductAIRouting } = await import("./product-ai-routing.js");
      const node = await mount(
        view === "models" ? <ProductModelsProviders /> : <ProductAIRouting />
      );
      await act(async () => click(button(node, "Save & apply")));
      expect(state.update).toHaveBeenCalledTimes(1);
      expect(state.reload).toHaveBeenCalledTimes(1);
      expect(readText(node)).not.toContain("Saving…");
      expect(readText(node)).toContain("Saved");
      await act(async () => click(button(node, "Save & apply")));
      expect(state.update).toHaveBeenCalledTimes(2);
    }
  );
});
