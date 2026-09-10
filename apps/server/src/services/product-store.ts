import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getRuntimeEnvDir } from "../env.js";
import { emptyProductConfiguration, parseProductConfiguration, type ProductConfiguration } from "@companion/providers";
export type Person = { id: string; displayName: string; personaId: string; notes: string };
export type ProductSettings = { configuration: ProductConfiguration; people: Person[]; primaryPersonId: string | null; proactive: { threshold: number; intervalMs: number }; revision: number };
export function productPath(env = process.env) { return join(getRuntimeEnvDir(env), "product-settings.json"); }
export function readProductSettings(env = process.env): ProductSettings | null {
  try { const value = JSON.parse(readFileSync(productPath(env), "utf8")) as ProductSettings; parseProductConfiguration(value.configuration); return value; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Product settings could not be read. Restore the local settings file."); }
}
export function writePrivateJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}
export function defaultProductSettings(): ProductSettings { return { configuration: emptyProductConfiguration(), people: [], primaryPersonId: null, proactive: { threshold: .7, intervalMs: 60_000 }, revision: 0 }; }
export function productEnvironment(env: Record<string, string | undefined>, settings: ProductSettings | null): Record<string, string | undefined> {
  if (!settings) return env;
  if (env["YUVI_PORTABLE_VERSION"]) {
    for (const provider of settings.configuration.providers) {
      if (provider.adapter === "local-stt" && provider.baseUrl.replace(/\/$/, "") !== env["LOCAL_STT_BASE_URL"]) {
        throw new Error("Portable local STT must use its own managed endpoint. Update the saved Product provider URL.");
      }
      if (["gpt-sovits", "dots-tts"].includes(provider.adapter) && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(provider.baseUrl).hostname)) {
        throw new Error("Portable does not bundle an owned local TTS service.");
      }
    }
  }
  const primary = settings.people.find(p => p.id === settings.primaryPersonId);
  return { ...env, YUVI_PRODUCT_CONFIGURATION: JSON.stringify(settings.configuration), MEMORY_SUBJECT_USER_ID: primary?.id, MEMORY_PERSONA_ID: primary?.personaId, PROACTIVE_SCORE_THRESHOLD: String(settings.proactive.threshold), PROACTIVE_EVALUATION_INTERVAL_MS: String(settings.proactive.intervalMs) };
}
export function embeddingSignature(c: ProductConfiguration): string {
  return JSON.stringify(c.routes.embedding.map(id => { const m = c.models.find(m => m.id === id)!; return [m, c.providers.find(p => p.id === m.providerId)]; }));
}

/** Import only configured, implemented legacy routes; never invent model metadata. */
export function importLegacyConfiguration(env: Record<string, string | undefined>): ProductSettings {
  const settings = defaultProductSettings();
  const c = settings.configuration;
  const add = (vendor: string, cap: import("@companion/providers").CapabilityRoute, baseUrl: string | undefined, modelId: string | undefined, key: string | undefined, adapter: import("@companion/providers").ProductProvider["adapter"], context?: string, dimensions?: string) => {
    if (!baseUrl || !modelId) return;
    const pid = `import-${vendor}`; const mid = `${pid}-${cap}`;
    if (!c.providers.some(p => p.id === pid)) c.providers.push({ id: pid, displayName: vendor, baseUrl, adapter, ...(key ? { apiKey: key } : {}) });
    c.models.push({ id: mid, providerId: pid, displayName: modelId, modelId, temperature: .7, contextWindow: Number.isSafeInteger(Number(context)) && Number(context) >= 1024 ? Number(context) : null, enabled: true, capabilities: [cap], ...(cap === "embedding" ? { dimensions: Number(dimensions) || 1536 } : {}), ...(cap === "chat" && env["OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT"] === "deepseek-v4" && vendor === "openai-compatible" ? { continuationFormat: "deepseek-v4" as const } : {}) });
    c.routes[cap].push(mid);
  };
  const definitions = {
    "deepseek": ["DEEPSEEK", "https://api.deepseek.com"],
    "openai-compatible": ["OPENAI_COMPATIBLE", undefined],
    "nvidia": ["NVIDIA", "https://integrate.api.nvidia.com/v1"],
    "local": ["LOCAL", env["LOCAL_MODEL_BASEURL"]]
  } as const;
  for (const cap of ["chat", "reasoning", "embedding", "vision", "stt", "tts"] as const) {
    const chain = env[`${cap.toUpperCase()}_PROVIDER_CHAIN`]?.split(",").map(x => x.trim()) ?? (cap === "chat" || cap === "reasoning" ? [env[`DEFAULT_${cap.toUpperCase()}_PROVIDER`] ?? "deepseek", "nvidia", "local"] : cap === "embedding" ? [env["EMBEDDING_PROVIDER"] ?? "openai-compatible", "nvidia", "local"] : cap === "stt" ? ["dashscope", "local"] : ["xai", "local"]);
    for (const vendor of [...new Set(chain)]) {
      if ((cap === "chat" || cap === "reasoning" || cap === "embedding") && vendor in definitions) {
        const [prefix, fallback] = definitions[vendor as keyof typeof definitions];
        const genericEmbedding = cap === "embedding" && vendor === "openai-compatible";
        const key = env[genericEmbedding ? "EMBEDDING_API_KEY" : `${prefix}_API_KEY`];
        if (vendor !== "local" && !key) continue;
        add(vendor, cap, env[genericEmbedding ? "EMBEDDING_API_BASEURL" : `${prefix}_API_BASEURL`] ?? fallback, env[genericEmbedding ? "EMBEDDING_MODEL" : `${prefix}_${cap.toUpperCase()}_MODEL`], key, "openai-compatible", env[`${prefix}_CHAT_CONTEXT_WINDOW`], env[genericEmbedding ? "EMBEDDING_DIMENSIONS" : `${prefix}_EMBEDDING_DIMENSIONS`]);
      } else if (cap === "vision" && vendor === "xai" && env["XAI_API_KEY"]) add("xai-vision", cap, env["XAI_API_BASEURL"] ?? "https://api.x.ai/v1", env["XAI_VISION_MODEL"], env["XAI_API_KEY"], "openai-compatible");
      else if (cap === "stt" && vendor === "local") add("local-stt", cap, env["LOCAL_STT_BASE_URL"], env["LOCAL_STT_MODEL"], undefined, "local-stt");
      else if (cap === "stt" && vendor === "dashscope" && env["DASHSCOPE_API_KEY"]) add("dashscope", cap, env["DASHSCOPE_API_BASEURL"] ?? "https://dashscope.aliyuncs.com/api/v1", env["DASHSCOPE_STT_MODEL"], env["DASHSCOPE_API_KEY"], "dashscope");
      else if (cap === "tts" && vendor === "xai" && env["XAI_API_KEY"]) add("xai-tts", cap, env["XAI_API_BASEURL"] ?? "https://api.x.ai/v1", env["XAI_TTS_MODEL"], env["XAI_API_KEY"], "xai-tts");
      else if (cap === "tts" && vendor === "local") add("local-tts", cap, env["LOCAL_TTS_BASE_URL"] ?? env["GPT_SOVITS_TTS_BASE_URL"] ?? "http://127.0.0.1:9881", env["LOCAL_TTS_MODEL"], undefined, env["LOCAL_TTS_MODEL"] === "dots-studio/dots.tts-soar" ? "dots-tts" : "gpt-sovits");
    }
  }
  if (env["OPENAI_COMPATIBLE_API_KEY"]) add("openai-compatible", "proactive", env["OPENAI_COMPATIBLE_API_BASEURL"], env["OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL"], env["OPENAI_COMPATIBLE_API_KEY"], "openai-compatible");
  settings.proactive = { threshold: Number(env["PROACTIVE_SCORE_THRESHOLD"] ?? .7), intervalMs: Number(env["PROACTIVE_EVALUATION_INTERVAL_MS"] ?? 60000) };
  return settings;
}
