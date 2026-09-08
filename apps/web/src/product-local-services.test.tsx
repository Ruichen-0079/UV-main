import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProductLocalServices } from "./product-local-services.js";
import { PRODUCT_ROUTING_DEFINITIONS } from "./product-ai-routing.js";
import { resolveDesktopSurface } from "./desktop-runtime.js";
vi.mock("./hooks/useAsyncData.js", () => ({
  useAsyncData: () => ({
    loading: false,
    error: null,
    refresh: vi.fn(),
    data: {
      checkedAt: "2026-09-07T00:00:00Z",
      stt: {
        available: true,
        selected: true,
        speakerProfiles: true,
        diarization: true,
        vad: true,
        profileCount: 0
      },
      memory: {
        backend: "mem0",
        repository: "postgres",
        database: "healthy",
        ollama: true,
        model: "yuvi-embedding:0.6b",
        dimensions: 1024,
        embedderPresent: true,
        status: "degraded",
        infer: false,
        crud: true,
        search: true,
        embedder: true,
        vectorStore: true
      },
      tts: { configured: false, provider: "xai", observed: "unknown" }
    }
  })
}));
it("renders speech readiness and reduced Memory capability without pretending TTS is selected", () => {
  const html = renderToStaticMarkup(<ProductLocalServices />);
  for (const text of ["Provider → Model → Capability Route", "Configure My Profile", "enroll your voice when available"]) expect(html).toContain(text);
  expect(PRODUCT_ROUTING_DEFINITIONS.map((route) => route.capability)).toEqual([
    "chat",
    "reasoning",
    "embedding",
    "stt",
    "tts",
    "vision"
  ]);
});
it("recognizes Product in a normal browser", async () => {
  vi.stubGlobal("window", { location: { hash: "#/webui" } });
  try {
    expect(await resolveDesktopSurface()).toBe("webui");
  } finally {
    vi.unstubAllGlobals();
  }
});
