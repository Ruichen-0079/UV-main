import { afterEach, expect, it, vi } from "vitest";
import { localServicesStatus } from "./local-services.js";
import type { AppContext } from "../context.js";

afterEach(() => vi.unstubAllGlobals());
it("reports degraded inference and projects only safe capability evidence", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.includes("9876")
              ? {
                  ok: true,
                  service: "yuvi-local-stt",
                  speakerModel: "eres2net",
                  diarizationModel: "pyannote",
                  vad: true,
                  speakerCount: 2,
                  embedding: [1],
                  secret: "private"
                }
              : url.includes("11434")
                ? { models: [{ name: "yuvi-embedding:0.6b" }] }
                : {
                    data: {
                      status: "degraded",
                      capabilities: { infer: false, crud: true, search: true },
                      components: { embedder: "healthy", vectorStore: "healthy" },
                      message: "private"
                    }
                  }
          )
        )
    )
  );
  const context = {
    activeRuntimeEnv: { MEMORY_BACKEND: "mem0", MEMORY_REPOSITORY: "postgres" },
    memoryRepository: { healthCheck: async () => ({ status: "healthy" }) },
    providers: {
      getStatus: () => ({
        providers: { stt: { provider: "local" }, tts: { readiness: "not_ready", provider: "xai" } }
      })
    }
  } as unknown as AppContext;
  context.providers.getSTTProvider = () =>
    ({ name: "local" }) as ReturnType<AppContext["providers"]["getSTTProvider"]>;
  const result = await localServicesStatus(context);
  expect(result.stt).toMatchObject({
    available: true,
    speakerProfiles: true,
    diarization: true,
    vad: true
  });
  expect(result.memory).toMatchObject({
    status: "degraded",
    infer: false,
    search: true,
    embedderPresent: true,
    dimensions: 1024
  });
  expect(result.tts.configured).toBe(false);
  expect(JSON.stringify(result)).not.toContain("private");
});
it("does not mistake unrelated 200 endpoints for usable local services", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('{"ok":true}'))
  );
  const context = {
    activeRuntimeEnv: {},
    memoryRepository: { healthCheck: async () => ({ status: "healthy" }) },
    providers: { getStatus: () => ({ providers: { stt: {}, tts: {} } }) }
  } as unknown as AppContext;
  context.providers.getSTTProvider = () =>
    ({ name: "unavailable" }) as ReturnType<AppContext["providers"]["getSTTProvider"]>;
  const result = await localServicesStatus(context);
  expect(result.stt.available).toBe(false);
  expect(result.memory).toMatchObject({
    status: "unavailable",
    ollama: false,
    embedderPresent: false,
    infer: false,
    search: false
  });
});
