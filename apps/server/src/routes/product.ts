import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { readRuntimeEnvFiles } from "../env.js";
import {
  SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
  createServerMcpCapabilityBindings
} from "../mcp-capability-binding.js";
import { readMemoryIngestionDiagnostics } from "../memory-ingestion-diagnostics.js";
import { discoverOpenAiCompatibleModels, probeHttpEndpoint } from "../product/product-discovery.js";
import { mapMemoryEpistemic, mapProviderHealth } from "../product/product-health.js";
import {
  defaultProductPreferences,
  readProductPreferences,
  writeProductPreferences,
  type ProductPreferences
} from "../product/product-preferences.js";
import { redactDiagnosticsText, redactUnknown } from "../product/product-redaction.js";
import { editableKeys, secretKeys, type EditableRuntimeSetting } from "../runtime-settings.js";
import {
  InvalidRuntimeSettingsError,
  buildRuntimeSettings,
  withSettingsOperationLock,
  writeLocalRuntimeSettings
} from "./settings.js";
import { requireLocalDashboardAccess } from "./security.js";

const PreferencesPatchSchema = z
  .object({
    appearance: z
      .object({
        theme: z.enum(["light", "dark", "system"]).optional(),
        density: z.enum(["comfortable", "compact"]).optional(),
        reducedMotion: z.boolean().optional()
      })
      .optional(),
    general: z
      .object({
        rememberLastPage: z.boolean().optional(),
        lastPage: z.enum(["chat", "settings", "diagnostics"]).optional(),
        language: z.enum(["en", "zh"]).optional()
      })
      .optional(),
    firstRun: z
      .object({
        completed: z.boolean().optional(),
        skipped: z.boolean().optional()
      })
      .optional(),
    diagnostics: z.object({ follow: z.boolean().optional() }).optional()
  })
  .strict();

const ConnectionsUpdateSchema = z
  .object({
    values: z.record(z.string(), z.string().nullable()).default({}),
    removeOverrides: z.array(z.string()).default([]),
    apply: z.boolean().optional().default(true)
  })
  .strict();

const DiscoverySchema = z
  .object({
    connectionId: z.enum([
      "deepseek",
      "openai-compatible",
      "nvidia",
      "local",
      "xai",
      "dashscope",
      "embedding"
    ])
  })
  .strict();

export async function registerProductRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  app.get("/product/overview", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    return reply.send(await buildProductOverview(context, config));
  });

  app.post("/product/preferences", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const parsed = PreferencesPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const preferences = await writeProductPreferences(parsed.data as Partial<ProductPreferences>);
    return reply.send({ ok: true, preferences });
  });

  app.post("/product/connections", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const parsed = ConnectionsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const unsafeKeys = [...Object.keys(parsed.data.values), ...parsed.data.removeOverrides].filter(
      (key) => !editableKeys.includes(key as EditableRuntimeSetting)
    );
    if (unsafeKeys.length > 0) {
      return reply.status(400).send({
        error: "unsafe_keys",
        message: "Only allowlisted local settings can be updated.",
        unsafeKeys: Array.from(new Set(unsafeKeys))
      });
    }
    return withSettingsOperationLock(async () => {
      try {
        const changedKeys = await writeLocalRuntimeSettings(
          parsed.data.values,
          parsed.data.removeOverrides
        );
        let appliedKeys: string[] = [];
        let restartRequired = false;
        let pendingRestartKeys: string[] = [];
        let message = "Saved local settings.";
        if (parsed.data.apply && changedKeys.length > 0) {
          const env = (await readRuntimeEnvFiles()).env;
          const reload = await context.reloadRuntimeConfig(env);
          appliedKeys = reload.appliedKeys;
          restartRequired = reload.restartRequired;
          pendingRestartKeys = reload.pendingRestartKeys;
          message = reload.message;
        }
        return reply.send({
          ok: true,
          changedKeys,
          appliedKeys,
          restartRequired,
          pendingRestartKeys,
          message,
          overview: await buildProductOverview(context, config)
        });
      } catch (error) {
        if (error instanceof InvalidRuntimeSettingsError) {
          return reply
            .status(400)
            .send({ error: "invalid_settings", fieldErrors: error.fieldErrors });
        }
        throw error;
      }
    });
  });

  app.post("/product/models/discover", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const parsed = DiscoverySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const env = (await readRuntimeEnvFiles()).env;
    const target = connectionEndpoint(parsed.data.connectionId, env);
    if (!target.baseUrl) {
      return reply.status(400).send({
        error: "misconfigured",
        message: "This connection has no base URL."
      });
    }
    const result = await discoverOpenAiCompatibleModels({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey
    });
    return reply.send({
      connectionId: parsed.data.connectionId,
      ...result,
      models: result.models.map((model) => ({ id: model.id, ownedBy: model.ownedBy }))
    });
  });

  app.post("/product/connections/test", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const parsed = DiscoverySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const env = (await readRuntimeEnvFiles()).env;
    const target = connectionEndpoint(parsed.data.connectionId, env);
    if (!target.baseUrl) {
      return reply.status(400).send({
        ok: false,
        connectionId: parsed.data.connectionId,
        error: "This connection has no base URL."
      });
    }
    const probe = await probeHttpEndpoint({
      url: `${target.baseUrl.replace(/\/+$/, "")}/models`,
      apiKey: target.apiKey
    });
    return reply.send({
      connectionId: parsed.data.connectionId,
      ...probe
    });
  });

  app.get("/product/memory", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const query = typeof request.query === "object" && request.query ? request.query : {};
    const search =
      typeof (query as { q?: string }).q === "string" ? (query as { q: string }).q : "";
    return reply.send(await buildMemorySurface(context, search));
  });

  app.get("/product/capabilities", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const registry = createServerMcpCapabilityBindings({
      version: SERVER_MCP_CAPABILITY_BINDINGS_6K_VERSION,
      capabilities: [
        {
          capabilityRef: "capability://opaque/repository-read",
          description: "Read one authorized repository text file without modifying it.",
          toolName: "read_text_file"
        }
      ]
    });
    return reply.send({
      authority: "Runtime admission + static MCP allowlist",
      userConfigurableServers: false,
      deferredReason:
        "YUVI does not currently expose a user-editable MCP server catalog. The UI observes the static allowlist only.",
      version: registry.version,
      capabilities: registry.bindings.map((binding) => ({
        capabilityRef: binding.capabilityRef,
        toolName: binding.toolName
      })),
      descriptions: registry.descriptions.capabilities
    });
  });

  app.post("/product/voice/test", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const provider = context.providers.getTTSProvider();
    const status = context.providers.getStatus().providers.tts;
    if (status.readiness !== "ready") {
      return reply.status(409).send({
        ok: false,
        mock: Boolean(status.mock),
        error: "TTS is not ready. Configure a voice provider first.",
        health: mapProviderHealth({ id: "voice", label: "Voice", health: status })
      });
    }
    const started = Date.now();
    try {
      const output = await provider.synthesizeSpeech({
        text: "Hello, this is YUVI."
      });
      return reply.send({
        ok: true,
        mock: Boolean(status.mock),
        provider: output.finalProvider ?? provider.name,
        latencyMs: output.latencyMs ?? Date.now() - started,
        mimeType: output.mimeType,
        audioBase64: output.audioBase64 ?? Buffer.from(output.audio).toString("base64")
      });
    } catch (error) {
      return reply.status(502).send({
        ok: false,
        mock: Boolean(status.mock),
        provider: provider.name,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : "Voice test failed."
      });
    }
  });

  app.get("/product/diagnostics/export", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) return reply;
    const overview = await buildProductOverview(context, config);
    const events = context.dashboard.listRecentEvents?.(50) ?? [];
    const body = redactDiagnosticsText(
      JSON.stringify(
        redactUnknown({
          exportedAt: new Date().toISOString(),
          overview,
          events
        }),
        null,
        2
      )
    );
    return reply.send({ ok: true, text: body });
  });
}

async function buildProductOverview(context: AppContext, config: ServerConfig) {
  const settings = await buildRuntimeSettings(context, config);
  const prefs = await readProductPreferences();
  const providers = context.providers.getStatus();
  const database = await context.memoryRepository.healthCheck();
  const ingestion = await readMemoryIngestionDiagnostics(context.memoryIngestionCoordinator);
  const compact = [
    mapProviderHealth({ id: "yuvi", label: "YUVI", health: providers.providers.chat }),
    {
      id: "memory",
      label: "Memory",
      ...mapMemoryEpistemic(
        database.status === "healthy"
          ? "ok"
          : database.status === "unavailable"
            ? "unavailable"
            : "error"
      ),
      detail: database.message
    },
    mapProviderHealth({ id: "voice", label: "Voice", health: providers.providers.tts }),
    {
      id: "lumi",
      label: "Lumi",
      state: config.live2dAssetRoot ? "ready" : "misconfigured",
      tone: config.live2dAssetRoot ? "ok" : "warn",
      summary: config.live2dAssetRoot ? "Assets configured" : "Live2D assets not configured",
      detail: "Renderer ownership stays with the Companion window."
    }
  ];

  return {
    version: "product-ui.v1",
    generatedAt: new Date().toISOString(),
    preferences: prefs.malformed ? defaultProductPreferences() : prefs.preferences,
    preferencesMalformed: prefs.malformed,
    preferencesPath: prefs.path,
    runtimeMode: config.runtimeMode,
    compactHealth: compact,
    roles: projectRoles(providers, settings),
    connections: projectConnections(settings),
    deferredRoles: [
      {
        id: "character-supervisor",
        label: "Character supervisor / ambiguous recovery",
        intended: "GLM-5.3-Flash",
        status: "deferred",
        reason: "Runtime does not yet expose a distinct supervisor role."
      },
      {
        id: "cognition-fast",
        label: "Cognition fast",
        intended: "DeepSeek Flash",
        status: "deferred",
        reason: "Cognition currently uses a single reasoning provider chain."
      },
      {
        id: "cognition-deep",
        label: "Cognition deep",
        intended: "DeepSeek Pro",
        status: "deferred",
        reason: "Cognition currently uses a single reasoning provider chain."
      }
    ],
    memory: {
      backend: settings.memory.activeMemoryRepository,
      extractor: settings.memory.activeMemoryExtractor,
      databaseConfigured: settings.memory.databaseUrlConfigured,
      ingestion: {
        status: ingestion.status,
        diagnosticsAvailability: ingestion.diagnosticsAvailability,
        pendingCount: ingestion.pendingCount,
        reconcileRequiredCount: ingestion.reconcileRequiredCount,
        terminalFailedCount: ingestion.terminalFailedCount
      },
      compression: {
        classification: "IMPLEMENTED_PRIMITIVE_NOT_RUNTIME_ACTIVE",
        operational: false
      },
      idleDream: {
        classification: "DEFERRED / NOT_RUNTIME_ACTIVE",
        operational: false
      }
    },
    settings
  };
}

async function buildMemorySurface(context: AppContext, query: string) {
  const now = new Date();
  const episodes = await context.recentEpisodeStore.listActive({ now, limit: 12 });
  const dueJobs = await context.dreamJobStore.listDue(now, 12);
  let retrieval: {
    status: "ok" | "empty" | "unavailable" | "error" | "partial";
    events: Array<{ id: string; content: string; kind?: string }>;
  } = { status: "empty", events: [] };
  if (query.trim()) {
    try {
      const outcome = await context.memory.retrieveRelevantMemoriesWithMetadata({
        text: query,
        limit: 20
      });
      const selected = outcome.selectedMemories ?? [];
      retrieval = {
        status: selected.length === 0 ? "empty" : "ok",
        events: selected.slice(0, 20).map((memory) => ({
          id: memory.id,
          content: memory.summary ?? memory.content,
          kind: memory.type
        }))
      };
    } catch {
      retrieval = { status: "error", events: [] };
    }
  }
  return {
    l0: { name: "DirectContext", description: "Near-verbatim recent completed turns." },
    l1: {
      name: "Recent episodic ledger",
      episodes: episodes.map((episode) => ({
        id: episode.id,
        status: episode.status,
        whatHappened: episode.whatHappened,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        temporalConfidence: episode.temporalConfidence
      }))
    },
    l2: {
      name: "Durable MemoryEvent evidence",
      ...mapMemoryEpistemic(retrieval.status),
      query: query || null,
      events: retrieval.events
    },
    dream: {
      idleClassification: "DEFERRED / NOT_RUNTIME_ACTIVE",
      dueJobs: dueJobs.map((job) => ({
        jobId: job.jobId,
        triggerKind: job.triggerKind,
        status: job.status,
        lastErrorCode: job.lastErrorCode
      }))
    }
  };
}

function projectRoles(
  providers: ReturnType<AppContext["providers"]["getStatus"]>,
  settings: Awaited<ReturnType<typeof buildRuntimeSettings>>
) {
  return [
    {
      id: "character",
      label: "Character / reply",
      capability: "chat",
      chain: settings.settings["CHAT_PROVIDER_CHAIN"],
      health: mapProviderHealth({
        id: "character",
        label: "Character",
        health: providers.providers.chat
      }),
      fallback: "CHAT_PROVIDER_CHAIN order is Runtime fallback authority."
    },
    {
      id: "cognition",
      label: "Cognition / reasoning",
      capability: "reasoning",
      chain: settings.settings["REASONING_PROVIDER_CHAIN"],
      health: mapProviderHealth({
        id: "cognition",
        label: "Cognition",
        health: providers.providers.reasoning
      }),
      fallback: "REASONING_PROVIDER_CHAIN order is Runtime fallback authority."
    },
    {
      id: "embedding",
      label: "Embedding",
      capability: "embedding",
      chain: settings.settings["EMBEDDING_PROVIDER_CHAIN"],
      health: mapProviderHealth({
        id: "embedding",
        label: "Embedding",
        health: providers.providers.embedding
      })
    },
    {
      id: "tts",
      label: "Voice TTS",
      capability: "tts",
      chain: settings.settings["TTS_PROVIDER_CHAIN"],
      health: mapProviderHealth({ id: "tts", label: "TTS", health: providers.providers.tts })
    },
    {
      id: "stt",
      label: "Voice STT",
      capability: "stt",
      chain: settings.settings["STT_PROVIDER_CHAIN"],
      health: mapProviderHealth({ id: "stt", label: "STT", health: providers.providers.stt })
    },
    {
      id: "vision",
      label: "Vision",
      capability: "vision",
      chain: settings.settings["VISION_PROVIDER_CHAIN"],
      health: mapProviderHealth({
        id: "vision",
        label: "Vision",
        health: providers.providers.vision
      })
    }
  ];
}

function projectConnections(settings: Awaited<ReturnType<typeof buildRuntimeSettings>>) {
  const p = settings.providers as Record<string, Record<string, unknown>>;
  return [
    connectionCard("deepseek", "DeepSeek", p["deepseek"]),
    connectionCard("openai-compatible", "OpenAI-compatible", {
      baseUrl: (settings.settings["OPENAI_COMPATIBLE_API_BASEURL"] as { effective?: string })
        ?.effective,
      apiKeyConfigured: Boolean(
        (settings.settings["OPENAI_COMPATIBLE_API_KEY"] as { effectiveConfigured?: boolean })
          ?.effectiveConfigured
      )
    }),
    connectionCard("local", "Local OpenAI-compatible", {
      baseUrl: (settings.settings["LOCAL_MODEL_BASEURL"] as { effective?: string })?.effective,
      apiKeyConfigured: false
    }),
    connectionCard("nvidia", "NVIDIA", p["nvidia"]),
    connectionCard("xai", "xAI", p["xai"]),
    connectionCard("dashscope", "DashScope STT", p["dashscope"]),
    connectionCard("embedding", "Embedding", p["embedding"])
  ];
}

function connectionCard(id: string, label: string, raw: Record<string, unknown> | undefined) {
  return {
    id,
    label,
    baseUrl: typeof raw?.["baseUrl"] === "string" ? raw["baseUrl"] : "",
    apiKeyConfigured: Boolean(raw?.["apiKeyConfigured"]),
    sourceHint: "Environment overrides local UI config, which overrides defaults."
  };
}

function connectionEndpoint(
  id: string,
  env: Record<string, string | undefined>
): { baseUrl?: string; apiKey?: string } {
  const pair = (baseUrl: string | undefined, apiKey?: string | undefined) => {
    const result: { baseUrl?: string; apiKey?: string } = {};
    if (baseUrl) result.baseUrl = baseUrl;
    if (apiKey) result.apiKey = apiKey;
    return result;
  };
  switch (id) {
    case "deepseek":
      return pair(env["DEEPSEEK_API_BASEURL"], env["DEEPSEEK_API_KEY"]);
    case "openai-compatible":
      return pair(env["OPENAI_COMPATIBLE_API_BASEURL"], env["OPENAI_COMPATIBLE_API_KEY"]);
    case "nvidia":
      return pair(env["NVIDIA_API_BASEURL"], env["NVIDIA_API_KEY"]);
    case "local":
      return pair(env["LOCAL_MODEL_BASEURL"]);
    case "xai":
      return pair(env["XAI_API_BASEURL"], env["XAI_API_KEY"]);
    case "dashscope":
      return pair(env["DASHSCOPE_API_BASEURL"], env["DASHSCOPE_API_KEY"]);
    case "embedding":
      return pair(env["EMBEDDING_API_BASEURL"], env["EMBEDDING_API_KEY"]);
    default:
      return {};
  }
}

void secretKeys;
void editableKeys;
