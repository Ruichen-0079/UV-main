import { afterEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, readText, type FakeNode } from "./test-dom.js";
import { ProductConfigurationPanel, reorderRoute } from "./product-configuration.js";
const mock = vi.hoisted(() => ({ request: vi.fn(), sample: vi.fn() }));
vi.mock("./api/client.js", () => ({ request: mock.request, productSample: mock.sample, apiClient: { setDashboardDevToken: vi.fn() } }));
const caps = ["chat", "reasoning", "proactive", "embedding", "vision", "stt", "tts"];
function snapshot() { return { revision: 0, configuration: { version: 1, providers: [{ id: "p", displayName: "Endpoint", baseUrl: "http://localhost:8000", adapter: "openai-compatible" }], models: [{ id: "a", providerId: "p", displayName: "A", modelId: "a", temperature: .7, contextWindow: null, capabilities: ["chat"], enabled: true }, { id: "b", providerId: "p", displayName: "B", modelId: "b", temperature: .7, contextWindow: null, capabilities: ["chat"], enabled: true }], routes: Object.fromEntries(caps.map(c => [c, []])) }, people: [], primaryPersonId: null, proactive: { threshold: .7, intervalMs: 60000 }, proactiveState: { suppression: { kind: "NONE" }, eligibleAfterMs: 0 }, conversationalReady: false, applyState: "ACTIVE", routes: Object.fromEntries(caps.map(c => [c, { state: "NOT_CONFIGURED", modelIds: [] }])) }; }
function nodes(node: FakeNode): FakeNode[] { return [node, ...node.childNodes.flatMap(nodes)]; }
function props(node: FakeNode): any { return (node as any)[Object.keys(node).find(k => k.startsWith("__reactProps$"))!]; }
let root: Root | undefined, dom: ReturnType<typeof installFakeDom> | undefined;
afterEach(async () => { await act(async () => root?.unmount()); dom?.restore(); vi.clearAllMocks(); });
async function mount() { dom = installFakeDom(); await act(async () => { root = createRoot(dom!.container as unknown as Element); root.render(<StrictMode><ProductConfigurationPanel /></StrictMode>); }); return dom.container; }
it("first-run controls work with no Chat; compatible route assignment saves then re-fetches effective state", async () => {
  let saved = snapshot();
  mock.request.mockImplementation(async (url, init) => {
    if (url === "/product/voices") return { available: false, voices: [], unknown: [] };
    if (init?.method === "PUT") { const body = JSON.parse(init.body); saved = { ...saved, configuration: body.configuration, revision: saved.revision + 1, applyState: "RESTART_REQUIRED" }; }
    return structuredClone(saved);
  });
  const node = await mount(); expect(readText(node)).toContain("set up Chat"); expect(readText(node)).toContain("My Profile");
  const route = nodes(node).find(n => n.attributes["aria-label"] === "Chat route")!;
  const select = nodes(route).find(n => n.tagName === "SELECT")!;
  await act(async () => props(select).onChange({ target: { value: "a" } }));
  const button = nodes(node).find(n => n.tagName === "BUTTON" && readText(n) === "Save routes & apply")!;
  await act(async () => props(button).onClick());
  const update = mock.request.mock.calls.find(c => c[1]?.method === "PUT"); expect(JSON.parse(update![1].body).configuration.routes.chat).toEqual(["a"]);
  expect(mock.request.mock.calls.filter(c => c[0] === "/product/configuration" && !c[1]).length).toBeGreaterThan(1);
  expect(readText(node)).toContain("RESTART_REQUIRED"); expect(readText(node)).toContain("Effective: None"); expect(props(button).disabled).toBe(false);
  const stt = nodes(node).find(n => n.attributes["aria-label"] === "STT route")!; expect(nodes(stt).filter(n => n.tagName === "OPTION").map(readText)).toEqual(["Select model"]);
});
it("fallback order edits are stable and bounded", () => { expect(reorderRoute(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]); expect(reorderRoute(["a"], 0, -1)).toEqual(["a"]); });
it("unknown voice offers local playback, explicit link, creation, leave unresolved and deletion", async () => {
  mock.request.mockImplementation(async url => url === "/product/voices" ? { available: true, voices: [], unknown: [{ id: "review" }] } : snapshot());
  const node = await mount();
  for (const text of ["Unknown Voices", "▶ Play sample", "Who is this?", "Link to existing person", "Create new person", "Leave unknown", "Delete sample"]) expect(readText(node)).toContain(text);
  await act(async () => props(nodes(node).find(n => n.tagName === "BUTTON" && readText(n) === "Leave unknown")!).onClick());
  expect(mock.request).toHaveBeenCalledWith("/product/voice-samples/review/review", expect.objectContaining({ body: JSON.stringify({ leaveUnknown: true }) }));
  expect(readText(node)).not.toMatch(/similarity|cluster ID|embedding vector/);
});
