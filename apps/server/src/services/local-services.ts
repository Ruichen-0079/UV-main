import type { AppContext } from "../context.js";

type Json = Record<string, any>;

async function probe(url: string): Promise<Json | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Json) : null;
  } catch {
    return null;
  }
}

/** Explicit public projection: sidecar diagnostics, credentials and vectors never escape. */
export async function localServicesStatus(context: AppContext) {
  const env = context.activeRuntimeEnv;
  const sttUrl = env["LOCAL_STT_BASE_URL"] || "http://127.0.0.1:9876";
  const ollamaUrl = env["MEM0_OLLAMA_BASE_URL"] || "http://127.0.0.1:11434";
  const mem0Url = env["MEM0_BASE_URL"] || "http://127.0.0.1:6131";
  const [stt, tags, memory, database] = await Promise.all([
    probe(`${sttUrl.replace(/\/$/, "")}/health`),
    probe(`${ollamaUrl.replace(/\/$/, "")}/api/tags`),
    probe(`${mem0Url.replace(/\/$/, "")}/health`),
    context.memoryRepository.healthCheck()
  ]);
  const speechReady = stt?.["service"] === "yuvi-local-stt" && stt?.["ok"] === true;
  const data = memory?.["data"];
  const models = Array.isArray(tags?.["models"]) ? tags["models"] : [];
  const providers = context.providers.getStatus().providers;
  return {
    checkedAt: new Date().toISOString(),
    stt: {
      available: speechReady,
      selected: context.providers.getSTTProvider().name === "local",
      speakerProfiles: speechReady && typeof stt?.["speakerModel"] === "string",
      diarization: speechReady && typeof stt?.["diarizationModel"] === "string",
      vad: speechReady && stt?.["vad"] === true,
      profileCount:
        speechReady && Number.isInteger(stt?.["speakerCount"])
          ? (stt!["speakerCount"] as number)
          : 0
    },
    memory: {
      backend: env["MEMORY_BACKEND"] === "mem0" ? "mem0" : "legacy",
      repository: env["MEMORY_REPOSITORY"] === "postgres" ? "postgres" : "in-memory",
      database: database.status,
      ollama: Array.isArray(tags?.["models"]),
      embedderPresent: models.some((model: Json) => model?.["name"] === "yuvi-embedding:0.6b"),
      model: "yuvi-embedding:0.6b",
      dimensions: 1024,
      status: ["healthy", "degraded", "unhealthy"].includes(data?.status)
        ? (data.status as string)
        : "unavailable",
      crud: data?.capabilities?.crud === true,
      search: data?.capabilities?.search === true,
      infer: data?.capabilities?.infer === true,
      embedder: data?.components?.embedder === "healthy",
      vectorStore: data?.components?.vectorStore === "healthy"
    },
    tts: {
      configured: providers.tts.readiness === "ready",
      observed: providers.tts.observed ?? "unknown",
      provider: providers.tts.provider
    }
  };
}
