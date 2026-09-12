import { describe, expect, it } from "vitest";
import { parseProductConfiguration } from "@companion/providers";
import { productEnvironment, type ProductSettings } from "./product-store.js";

const MANAGED_ENV = {
  YUVI_PORTABLE_VERSION: "0.1.2",
  LOCAL_STT_BASE_URL: "http://127.0.0.1:19876",
  LOCAL_TTS_BASE_URL: "http://127.0.0.1:19881",
  GPT_SOVITS_TTS_BASE_URL: "http://127.0.0.1:19881",
  GPT_SOVITS_TTS_UPSTREAM_URL: "http://127.0.0.1:19880"
} as Record<string, string | undefined>;

function settingsWith(
  providers: ProductSettings["configuration"]["providers"],
  models: ProductSettings["configuration"]["models"],
  routes: Partial<ProductSettings["configuration"]["routes"]>
): ProductSettings {
  return {
    configuration: {
      version: 1,
      providers,
      models,
      routes: { chat: [], reasoning: [], proactive: [], embedding: [], vision: [], stt: [], tts: [], ...routes }
    },
    people: [],
    primaryPersonId: null,
    proactive: { threshold: 0.7, intervalMs: 60000 },
    revision: 1
  };
}

const sttProvider = (baseUrl: string) => ({ id: "stt-p", displayName: "Local STT", baseUrl, adapter: "local-stt" as const });
const sttModel = (providerId: string) => ({ id: "stt-m", providerId, displayName: "sensevoice", modelId: "sensevoice", temperature: 0.7, contextWindow: null, capabilities: ["stt" as const], enabled: true });
const ttsProvider = (baseUrl: string) => ({ id: "tts-p", displayName: "Local TTS", baseUrl, adapter: "dots-tts" as const });
const ttsModel = (providerId: string) => ({ id: "tts-m", providerId, displayName: "dots-studio/dots.tts-soar", modelId: "dots-studio/dots.tts-soar", temperature: 0.7, contextWindow: null, capabilities: ["tts" as const], enabled: true });

describe("portable provider routing (routing is not ownership)", () => {
  it("keeps managed defaults untouched when no explicit local route is selected", () => {
    const out = productEnvironment({ ...MANAGED_ENV }, settingsWith([], [], {}));
    expect(out["LOCAL_STT_BASE_URL"]).toBe("http://127.0.0.1:19876");
    expect(out["LOCAL_TTS_BASE_URL"]).toBe("http://127.0.0.1:19881");
    expect(out["GPT_SOVITS_TTS_UPSTREAM_URL"]).toBe("http://127.0.0.1:19880");
    expect(out["YUVI_PRODUCT_CONFIGURATION"]).toBeDefined();
  });

  it("allows an explicit external localhost STT endpoint without rewriting managed env", () => {
    const out = productEnvironment(
      { ...MANAGED_ENV },
      settingsWith([sttProvider("http://127.0.0.1:9876")], [sttModel("stt-p")], { stt: ["stt-m"] })
    );
    expect(out["LOCAL_STT_BASE_URL"]).toBe("http://127.0.0.1:19876");
    const adopted = parseProductConfiguration(JSON.parse(out["YUVI_PRODUCT_CONFIGURATION"]!));
    expect(adopted.routes.stt).toEqual(["stt-m"]);
    expect(adopted.providers.find((p) => p.id === "stt-p")?.baseUrl).toBe("http://127.0.0.1:9876");
  });

  it("allows an explicit external localhost TTS endpoint", () => {
    const out = productEnvironment(
      { ...MANAGED_ENV },
      settingsWith([ttsProvider("http://127.0.0.1:9881")], [ttsModel("tts-p")], { tts: ["tts-m"] })
    );
    expect(out["LOCAL_TTS_BASE_URL"]).toBe("http://127.0.0.1:19881");
    const adopted = parseProductConfiguration(JSON.parse(out["YUVI_PRODUCT_CONFIGURATION"]!));
    expect(adopted.routes.tts).toEqual(["tts-m"]);
    expect(adopted.providers.find((p) => p.id === "tts-p")?.baseUrl).toBe("http://127.0.0.1:9881");
  });

  it("keeps managed selections working when explicitly selected", () => {
    const out = productEnvironment(
      { ...MANAGED_ENV },
      settingsWith(
        [sttProvider("http://127.0.0.1:19876"), { id: "tts-g", displayName: "Managed TTS", baseUrl: "http://127.0.0.1:19881", adapter: "gpt-sovits" as const }],
        [sttModel("stt-p"), { id: "tts-m", providerId: "tts-g", displayName: "gpt-sovits", modelId: "alice", temperature: 0.7, contextWindow: null, capabilities: ["tts" as const], enabled: true }],
        { stt: ["stt-m"], tts: ["tts-m"] }
      )
    );
    const adopted = parseProductConfiguration(JSON.parse(out["YUVI_PRODUCT_CONFIGURATION"]!));
    expect(adopted.routes.stt).toEqual(["stt-m"]);
    expect(adopted.routes.tts).toEqual(["tts-m"]);
  });

  it("keeps localhost embedding with its configured dimensions", () => {
    const out = productEnvironment(
      { ...MANAGED_ENV },
      settingsWith(
        [{ id: "emb-p", displayName: "Local embedding", baseUrl: "http://127.0.0.1:8128/v1", adapter: "openai-compatible" as const, apiKey: "k" }],
        [{ id: "emb-m", providerId: "emb-p", displayName: "Qwen3", modelId: "Qwen3-Embedding-0.6B-Q8_0.gguf", temperature: 0.7, contextWindow: null, capabilities: ["embedding" as const], enabled: true, dimensions: 1024 }],
        { embedding: ["emb-m"] }
      )
    );
    const adopted = parseProductConfiguration(JSON.parse(out["YUVI_PRODUCT_CONFIGURATION"]!));
    expect(adopted.providers.find((p) => p.id === "emb-p")?.baseUrl).toBe("http://127.0.0.1:8128/v1");
    expect(adopted.models.find((m) => m.id === "emb-m")?.dimensions).toBe(1024);
  });

  it("leaves installed (non-portable) behavior unchanged", () => {
    const installed = { LOCAL_STT_BASE_URL: "http://127.0.0.1:9876" } as Record<string, string | undefined>;
    const out = productEnvironment(
      installed,
      settingsWith([sttProvider("http://127.0.0.1:9876")], [sttModel("stt-p")], { stt: ["stt-m"] })
    );
    expect(out["LOCAL_STT_BASE_URL"]).toBe("http://127.0.0.1:9876");
    expect(out["YUVI_PORTABLE_VERSION"]).toBeUndefined();
  });

  it("returns env untouched when no settings are saved", () => {
    expect(productEnvironment({ ...MANAGED_ENV }, null)).toEqual({ ...MANAGED_ENV });
  });
});
