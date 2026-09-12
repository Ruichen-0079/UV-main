import { afterEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installFakeDom, readText, type FakeNode } from "./test-dom.js";
import { ProductLocalServicesPanel } from "./product-local-services.js";
import { PRODUCT_PROVIDER_DEFINITIONS } from "./product-models-providers.js";

const mock = vi.hoisted(() => ({
  request: vi.fn(),
  detectLocalServices: vi.fn(),
  probeLocalService: vi.fn()
}));
vi.mock("./api/client.js", () => ({
  request: mock.request,
  apiClient: { detectLocalServices: mock.detectLocalServices, probeLocalService: mock.probeLocalService }
}));

const CAPS = ["chat", "reasoning", "proactive", "embedding", "vision", "stt", "tts"];
const emptyRoutes = () => Object.fromEntries(CAPS.map((c) => [c, []]));
const emptyRouteStates = () =>
  Object.fromEntries(CAPS.map((c) => [c, { state: "NOT_CONFIGURED", modelIds: [] }]));

function snapshot() {
  return {
    revision: 3,
    configuration: {
      version: 1,
      providers: [
        { id: "emb-p", displayName: "Local embedding", baseUrl: "http://127.0.0.1:8128/v1", adapter: "openai-compatible", hasApiKey: true }
      ],
      models: [
        { id: "emb-m", providerId: "emb-p", displayName: "Qwen3-Embedding", modelId: "Qwen3-Embedding-0.6B-Q8_0.gguf", temperature: 0.7, contextWindow: null, capabilities: ["embedding"], enabled: true, dimensions: 1024 }
      ],
      routes: { ...emptyRoutes(), embedding: ["emb-m"] }
    },
    people: [],
    primaryPersonId: null,
    proactive: { threshold: 0.7, intervalMs: 60000 },
    proactiveState: { suppression: { kind: "NONE" }, eligibleAfterMs: 0 },
    conversationalReady: false,
    applyState: "ACTIVE",
    routes: { ...emptyRouteStates(), embedding: { state: "ACTIVE", modelIds: ["emb-m"] } }
  };
}

function findings() {
  return {
    checkedAt: "2026-09-11T00:00:00Z",
    services: {
      embedding: { service: "embedding", testedEndpoint: "http://127.0.0.1:8128/v1", source: "saved", state: "ready", model: "Qwen3-Embedding-0.6B-Q8_0.gguf", dimensions: 1024, detail: "Verified." },
      stt: { service: "stt", testedEndpoint: "http://127.0.0.1:9876", source: "default", state: "ready", model: "model.int8.onnx", detail: "SenseVoice recognition service is responding." },
      tts: { service: "tts", testedEndpoint: "http://127.0.0.1:9881", source: "default", state: "hibernated", voice: "rei", detail: "Hibernated. The service wakes automatically for synthesis." }
    }
  };
}

function nodes(node: FakeNode): FakeNode[] {
  return [node, ...node.childNodes.flatMap(nodes)];
}
function props(node: FakeNode): any {
  return (node as any)[Object.keys(node).find((k) => k.startsWith("__reactProps$"))!];
}
let root: Root | undefined;
let dom: ReturnType<typeof installFakeDom> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  dom?.restore();
  vi.clearAllMocks();
  root = undefined;
  dom = undefined;
});
async function mount() {
  dom = installFakeDom();
  await act(async () => {
    root = createRoot(dom!.container as unknown as Element);
    root.render(
      <StrictMode>
        <ProductLocalServicesPanel />
      </StrictMode>
    );
  });
  return dom.container;
}
function card(node: FakeNode, title: string): FakeNode {
  const found = nodes(node).find((n) => n.attributes["aria-label"] === title);
  if (!found) throw new Error(`missing card ${title}`);
  return found;
}
function buttonIn(scope: FakeNode, label: string): FakeNode {
  const found = nodes(scope).find((n) => n.tagName === "BUTTON" && readText(n) === label);
  if (!found) throw new Error(`missing button ${label}`);
  return found;
}

it("presents three connection cards without raw environment names", async () => {
  mock.request.mockImplementation(async () => structuredClone(snapshot()));
  const node = await mount();
  const text = readText(node);
  expect(text).toContain("Local models");
  expect(text).toContain("Detect local services");
  for (const title of ["Embedding", "Speech recognition", "Speech synthesis"]) expect(text).toContain(title);
  for (const raw of ["LOCAL_STT_BASE_URL", "LOCAL_TTS_BASE_URL", "EMBEDDING_API_BASEURL", "GPT_SOVITS_TTS_BASE_URL", "LOCAL_EMBEDDING_MODEL"])
    expect(text).not.toContain(raw);
  expect(text).toContain("http://127.0.0.1:8128/v1");
});

it("detects known local services without auto-saving", async () => {
  let saved = snapshot();
  mock.request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT") saved = { ...saved, configuration: JSON.parse(init.body).configuration, revision: saved.revision + 1 };
    return structuredClone(saved);
  });
  mock.detectLocalServices.mockResolvedValue(structuredClone(findings()));
  const node = await mount();
  await act(async () => props(buttonIn(node, "Detect local services")).onClick());
  const text = readText(node);
  expect(text).toContain("http://127.0.0.1:9876");
  expect(text).toContain("http://127.0.0.1:9881");
  expect(text).toContain("Hibernated");
  expect(text).toContain("1024");
  expect(mock.request.mock.calls.filter((c) => c[1]?.method === "PUT")).toHaveLength(0);
  expect(text).toContain("Nothing was saved");
});

it("saves the STT endpoint through the existing Product settings authority", async () => {
  let saved = snapshot();
  mock.request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(init.body);
      expect(body.revision).toBe(saved.revision);
      saved = { ...saved, configuration: body.configuration, revision: saved.revision + 1 };
      return structuredClone(saved);
    }
    return structuredClone(saved);
  });
  mock.detectLocalServices.mockResolvedValue(structuredClone(findings()));
  const node = await mount();
  await act(async () => props(buttonIn(node, "Detect local services")).onClick());
  await act(async () => props(buttonIn(card(node, "Speech recognition"), "Configure")).onClick());
  const form = nodes(card(node, "Speech recognition")).find((n) => n.tagName === "FORM")!;
  await act(async () => props(form).onSubmit({ preventDefault: () => {} }));
  const put = mock.request.mock.calls.find((c) => c[1]?.method === "PUT");
  expect(put?.[0]).toBe("/product/configuration");
  const configuration = JSON.parse(put![1].body).configuration;
  const provider = configuration.providers.find((p: any) => p.adapter === "local-stt");
  expect(provider.baseUrl).toBe("http://127.0.0.1:9876");
  const model = configuration.models.find((m: any) => m.providerId === provider.id);
  expect(model.capabilities).toEqual(["stt"]);
  expect(configuration.routes.stt).toEqual([model.id]);
  expect(configuration.routes.embedding).toEqual(["emb-m"]);
  expect(readText(node)).toContain("Speech recognition now routes to http://127.0.0.1:9876");
});

it("preserves configured embedding dimensions instead of overwriting them", async () => {
  let saved = snapshot();
  mock.request.mockImplementation(async (url, init) => {
    if (init?.method === "PUT") saved = { ...saved, configuration: JSON.parse(init.body).configuration };
    return structuredClone(saved);
  });
  mock.detectLocalServices.mockResolvedValue(structuredClone(findings()));
  const node = await mount();
  await act(async () => props(buttonIn(node, "Detect local services")).onClick());
  // Detection disagrees; the form must still open with the configured value.
  await act(async () => props(buttonIn(card(node, "Embedding"), "Configure")).onClick());
  const dims = nodes(card(node, "Embedding")).filter((n) => n.tagName === "INPUT" && props(n).type === "number");
  expect(dims.map((n) => props(n).value)).toContain("1024");
  const form = nodes(card(node, "Embedding")).find((n) => n.tagName === "FORM")!;
  await act(async () => props(form).onSubmit({ preventDefault: () => {} }));
  const put = mock.request.mock.calls.find((c) => c[1]?.method === "PUT");
  const model = JSON.parse(put![1].body).configuration.models.find((m: any) => m.id === "emb-m");
  expect(model.dimensions).toBe(1024);
});

it("tests saved endpoints through the existing provider test and reports the endpoint", async () => {
  mock.request.mockImplementation(async (url) => {
    if (url === "/product/providers/emb-p/test") return { ok: true, message: "Endpoint responded. Model calls are verified separately." };
    return structuredClone(snapshot());
  });
  const node = await mount();
  await act(async () => props(buttonIn(card(node, "Embedding"), "Test")).onClick());
  expect(mock.request.mock.calls.some((c) => c[0] === "/product/providers/emb-p/test")).toBe(true);
  expect(readText(node)).toContain("Tested http://127.0.0.1:8128/v1");
});

it("reports truthful errors with the tested endpoint when probing fails", async () => {
  mock.request.mockImplementation(async () => structuredClone(snapshot()));
  mock.probeLocalService.mockRejectedValue(new Error("Connection unavailable."));
  const node = await mount();
  await act(async () => props(buttonIn(card(node, "Speech synthesis"), "Configure")).onClick());
  await act(async () => props(buttonIn(card(node, "Speech synthesis"), "Test endpoint")).onClick());
  expect(mock.probeLocalService.mock.calls[0]?.[0]).toMatchObject({ service: "tts", endpoint: "http://127.0.0.1:9881" });
  const text = readText(node);
  expect(text).toContain("Tested http://127.0.0.1:9881");
  expect(text).toContain("Connection unavailable.");
});

it("keeps the raw advanced provider fields available underneath", () => {
  const local = PRODUCT_PROVIDER_DEFINITIONS.find((p) => p.id === "local");
  expect(local?.capabilities).toEqual(expect.arrayContaining(["embedding", "stt", "tts"]));
  expect(local?.fields.map((f) => f.key)).toEqual(
    expect.arrayContaining(["LOCAL_STT_BASE_URL", "LOCAL_TTS_BASE_URL", "LOCAL_EMBEDDING_MODEL", "LOCAL_EMBEDDING_DIMENSIONS"])
  );
  const embedding = PRODUCT_PROVIDER_DEFINITIONS.find((p) => p.id === "embedding");
  expect(embedding?.fields.map((f) => f.key)).toEqual(
    expect.arrayContaining(["EMBEDDING_API_BASEURL", "EMBEDDING_MODEL", "EMBEDDING_DIMENSIONS"])
  );
});
