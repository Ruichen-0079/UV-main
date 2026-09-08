/** Product authority. Legacy environment parsing is used only before adoption. */
export const CAPABILITY_ROUTES = ["chat", "reasoning", "proactive", "embedding", "vision", "stt", "tts"] as const;
export type CapabilityRoute = typeof CAPABILITY_ROUTES[number];
export const ADAPTER_CAPABILITIES = {
  "openai-compatible": ["chat", "reasoning", "proactive", "embedding", "vision"],
  "local-stt": ["stt"],
  "dashscope": ["stt"],
  "xai-tts": ["tts"],
  "dots-tts": ["tts"],
  "gpt-sovits": ["tts"]
} as const;
export type ProductProvider = { id: string; displayName: string; baseUrl: string; apiKey?: string; adapter: keyof typeof ADAPTER_CAPABILITIES };
export type ProductModel = { id: string; providerId: string; displayName: string; modelId: string; temperature: number; contextWindow: number | null; capabilities: CapabilityRoute[]; enabled: boolean; dimensions?: number; voice?: string; continuationFormat?: "deepseek-v4" };
export type ProductConfiguration = { version: 1; providers: ProductProvider[]; models: ProductModel[]; routes: Record<CapabilityRoute, string[]> };
export function emptyProductConfiguration(): ProductConfiguration {
  return { version: 1, providers: [], models: [], routes: Object.fromEntries(CAPABILITY_ROUTES.map(c => [c, []])) as unknown as ProductConfiguration["routes"] };
}
export function parseProductConfiguration(value: unknown): ProductConfiguration {
  const c = value as ProductConfiguration;
  const fail = (): never => { throw new Error("Invalid Provider → Model → Capability Route configuration."); };
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 200;
  const id = (v: unknown): v is string => text(v) && /^[a-zA-Z0-9_-]+$/.test(v);
  if (!c || c.version !== 1 || !Array.isArray(c.providers) || !Array.isArray(c.models) || !c.routes || c.providers.length > 100 || c.models.length > 500) fail();
  if (new Set(c.providers.map(p => p.id)).size !== c.providers.length || new Set(c.models.map(m => m.id)).size !== c.models.length) fail();
  for (const p of c.providers) {
    if (!id(p.id) || !text(p.displayName) || !(p.adapter in ADAPTER_CAPABILITIES) || typeof p.baseUrl !== "string" || p.baseUrl.length > 2048 || (p.apiKey !== undefined && (typeof p.apiKey !== "string" || p.apiKey.length > 4096))) fail();
    let url: URL;
    try { url = new URL(p.baseUrl); } catch { fail(); }
    if (!["http:", "https:"].includes(url!.protocol) || url!.username || url!.password || url!.search || url!.hash) fail();
    if (["local-stt", "dots-tts", "gpt-sovits"].includes(p.adapter) && !["localhost", "127.0.0.1", "[::1]"].includes(url!.hostname)) fail();
  }
  for (const m of c.models) {
    const p = c.providers.find(p => p.id === m.providerId);
    if (!p || !id(m.id) || !text(m.displayName) || !text(m.modelId) || typeof m.enabled !== "boolean" || !Number.isFinite(m.temperature) || m.temperature < 0 || m.temperature > 2 || !(m.contextWindow === null || (Number.isSafeInteger(m.contextWindow) && m.contextWindow >= 1024)) || !Array.isArray(m.capabilities) || new Set(m.capabilities).size !== m.capabilities.length) fail();
    if (m.capabilities.some(cap => !(ADAPTER_CAPABILITIES[p!.adapter] as readonly string[]).includes(cap))) fail();
    if (m.capabilities.includes("embedding") && (!Number.isSafeInteger(m.dimensions) || m.dimensions! < 1 || m.dimensions! > 65536)) fail();
    if (m.voice !== undefined && !text(m.voice)) fail();
    if (m.continuationFormat !== undefined && m.continuationFormat !== "deepseek-v4") fail();
  }
  if (Object.keys(c.routes).some(k => !(CAPABILITY_ROUTES as readonly string[]).includes(k))) fail();
  for (const cap of CAPABILITY_ROUTES) {
    const route = c.routes[cap];
    if (!Array.isArray(route) || new Set(route).size !== route.length) fail();
    for (const mid of route) {
      const model = c.models.find(m => m.id === mid);
      if (!model || !model.enabled || !model.capabilities.includes(cap)) fail();
    }
  }
  return structuredClone(c);
}
export function modelEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}
