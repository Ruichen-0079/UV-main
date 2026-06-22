import { writeFile } from "node:fs/promises";
import type { MemoryExtractorStatus } from "@companion/memory";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import { getRuntimeEnvPath, quoteEnvValue, readRuntimeEnvFiles } from "../env.js";
import { requireDashboardDevToken } from "./security.js";

const editableKeys = [
  "MEMORY_REPOSITORY",
  "DATABASE_URL",
  "MEMORY_EXTRACTOR",
  "MEMORY_MAINTENANCE_ENABLED",
  "MEMORY_MAINTENANCE_RUN_ON_STARTUP",
  "MEMORY_MAINTENANCE_INTERVAL_MINUTES",
  "MEMORY_MAINTENANCE_LIMIT",
  "MEMORY_VECTOR_INDEX_ENABLED",
  "MEMORY_VECTOR_INDEX_TYPE",
  "MEMORY_VECTOR_DISTANCE",
  "MEMORY_VECTOR_IVFFLAT_PROBES",
  "MEMORY_VECTOR_HNSW_EF_SEARCH",
  "YUVI_AUTO_MIGRATE",
  "YUVI_DEV_SUPERVISOR",
  "EVENT_BUS",
  "PROVIDER_ALLOW_MOCKS",
  "CHAT_PROVIDER_CHAIN",
  "REASONING_PROVIDER_CHAIN",
  "EMBEDDING_PROVIDER_CHAIN",
  "TTS_PROVIDER_CHAIN",
  "STT_PROVIDER_CHAIN",
  "VISION_PROVIDER_CHAIN",
  "SERVER_HOST",
  "SERVER_PORT",
  "DEEPSEEK_API_BASEURL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_CHAT_MODEL",
  "DEEPSEEK_REASONING_MODEL",
  "XAI_API_BASEURL",
  "XAI_API_KEY",
  "XAI_TTS_MODEL",
  "XAI_TTS_VOICE",
  "XAI_VISION_MODEL",
  "DASHSCOPE_API_BASEURL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_STT_MODEL",
  "NVIDIA_API_BASEURL",
  "NVIDIA_API_KEY",
  "NVIDIA_CHAT_MODEL",
  "NVIDIA_REASONING_MODEL",
  "NVIDIA_EMBEDDING_MODEL",
  "NVIDIA_EMBEDDING_DIMENSIONS",
  "NVIDIA_VISION_MODEL",
  "LOCAL_MODEL_BASEURL",
  "LOCAL_CHAT_MODEL",
  "LOCAL_REASONING_MODEL",
  "LOCAL_EMBEDDING_MODEL",
  "LOCAL_EMBEDDING_DIMENSIONS",
  "LOCAL_TTS_MODEL",
  "LOCAL_STT_MODEL",
  "LOCAL_VISION_MODEL",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_API_BASEURL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS"
] as const;

const RuntimeSettingsUpdateSchema = z.object({
  values: z.record(z.string(), z.string().nullable())
});

const secretKeys = new Set([
  "DATABASE_URL",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "NVIDIA_API_KEY",
  "EMBEDDING_API_KEY"
]);

const hotReloadableKeys = new Set([
  "DEEPSEEK_API_BASEURL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_CHAT_MODEL",
  "DEEPSEEK_REASONING_MODEL",
  "MEMORY_EXTRACTOR",
  "PROVIDER_ALLOW_MOCKS",
  "CHAT_PROVIDER_CHAIN",
  "REASONING_PROVIDER_CHAIN",
  "EMBEDDING_PROVIDER_CHAIN",
  "TTS_PROVIDER_CHAIN",
  "STT_PROVIDER_CHAIN",
  "VISION_PROVIDER_CHAIN",
  "XAI_API_BASEURL",
  "XAI_API_KEY",
  "XAI_TTS_MODEL",
  "XAI_TTS_VOICE",
  "XAI_VISION_MODEL",
  "DASHSCOPE_API_BASEURL",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_STT_MODEL",
  "NVIDIA_API_BASEURL",
  "NVIDIA_API_KEY",
  "NVIDIA_CHAT_MODEL",
  "NVIDIA_REASONING_MODEL",
  "NVIDIA_EMBEDDING_MODEL",
  "NVIDIA_EMBEDDING_DIMENSIONS",
  "NVIDIA_VISION_MODEL",
  "LOCAL_MODEL_BASEURL",
  "LOCAL_CHAT_MODEL",
  "LOCAL_REASONING_MODEL",
  "LOCAL_EMBEDDING_MODEL",
  "LOCAL_EMBEDDING_DIMENSIONS",
  "LOCAL_TTS_MODEL",
  "LOCAL_STT_MODEL",
  "LOCAL_VISION_MODEL",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_API_BASEURL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS"
]);

export async function registerSettingsRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  app.get("/settings/runtime", async () => {
    return buildRuntimeSettings(context, config);
  });

  app.post("/settings/runtime", async (request, reply) => {
    if (!requireDashboardDevToken(config, request, reply)) {
      return reply;
    }

    if (config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Runtime settings updates are only available in development mode."
      });
    }

    if (!isLocalRequest(request)) {
      return reply.status(403).send({
        error: "forbidden",
        message: "Runtime settings can only be updated from localhost."
      });
    }

    const parsed = RuntimeSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        details: parsed.error.flatten()
      });
    }

    const unsafeKeys = Object.keys(parsed.data.values).filter(
      (key) => !editableKeys.includes(key as (typeof editableKeys)[number])
    );
    if (unsafeKeys.length > 0) {
      return reply.status(400).send({
        error: "unsafe_keys",
        message: "Only allowlisted local development settings can be updated.",
        unsafeKeys
      });
    }
    const invalidMemoryExtractor = validateMemoryExtractorUpdate(parsed.data.values);
    if (invalidMemoryExtractor) {
      return reply.status(400).send({
        error: "invalid_memory_extractor",
        message: invalidMemoryExtractor
      });
    }

    const changedKeys = await writeLocalRuntimeSettings(parsed.data.values);
    return reply.send({
      ok: true,
      restartRequired: changedKeys.some((key) => !hotReloadableKeys.has(key)),
      changedKeys,
      settings: await buildRuntimeSettings(context, config)
    });
  });

  app.post("/settings/runtime/reload", async (request, reply) => {
    if (!requireDashboardDevToken(config, request, reply)) {
      return reply;
    }

    if (config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Runtime settings reload is only available in development mode."
      });
    }

    if (!isLocalRequest(request)) {
      return reply.status(403).send({
        error: "forbidden",
        message: "Runtime settings can only be reloaded from localhost."
      });
    }

    const effectiveEnv = await readEffectiveRuntimeEnv(app);
    const result = context.reloadRuntimeConfig(effectiveEnv);
    const settings = await buildRuntimeSettings(context, config);

    return reply.send({
      ok: true,
      applied: true,
      restartRequired: result.restartRequired,
      active: {
        providers: result.providers.providers,
        memoryRepository: context.activeMemoryRepository
      },
      notHotReloaded: result.notHotReloaded,
      message: result.message,
      settings
    });
  });
}

async function buildRuntimeSettings(context: AppContext, config: ServerConfig) {
  const runtimeEnvFiles = await readRuntimeEnvFiles();
  const baseEnvFile = runtimeEnvFiles.base;
  const localEnvFile = runtimeEnvFiles.local;
  const baseEnv = baseEnvFile.values;
  const localEnv = localEnvFile.values;
  const env = runtimeEnvFiles.env;
  const providerStatus = context.providers.getStatus();
  const memoryRepository = env["MEMORY_REPOSITORY"] ?? "in-memory";
  const memoryExtractor = normalizeMemoryExtractor(env["MEMORY_EXTRACTOR"]);
  const pendingRestart = hasRestartRequiredLocalOverrides(
    localEnv,
    config,
    context.activeMemoryRepository
  );

  return {
    configFiles: {
      ".env": {
        exists: baseEnvFile.exists,
        gitIgnored: true,
        path: baseEnvFile.path
      },
      ".env.local": {
        exists: localEnvFile.exists,
        gitIgnored: true,
        path: localEnvFile.path
      }
    },
    baseConfig: buildSafeConfig(baseEnv),
    localOverrideConfig: buildSafeConfig(localEnv),
    effectiveConfig: buildSafeConfig(env),
    activeRuntimeConfig: {
      serverHost: config.host,
      serverPort: config.port,
      eventBus: config.eventBus,
      memoryRepository: context.activeMemoryRepository,
      memoryExtractor: context.memory.getExtractorStatus().mode,
      memoryExtractorActive: context.memory.getExtractorStatus().active,
      providers: {
        chat: providerStatus.providers.chat,
        reasoning: providerStatus.providers.reasoning,
        embedding: providerStatus.providers.embedding
      }
    },
    settings: buildLayeredSettings(baseEnv, localEnv, env),
    runtime: {
      serverHost: env["SERVER_HOST"] ?? config.host,
      serverPort: Number.parseInt(env["SERVER_PORT"] ?? String(config.port), 10),
      activeServerHost: config.host,
      activeServerPort: config.port,
      runtimeMode: config.runtimeMode,
      eventBus: env["EVENT_BUS"] ?? config.eventBus,
      activeEventBus: config.eventBus,
      providerAllowMocks: parseBooleanString(env["PROVIDER_ALLOW_MOCKS"]),
      devSupervisor: {
        active: config.devSupervisor.active,
        autoMigrate: config.devSupervisor.autoMigrate,
        restartSupported: Boolean(
          config.devSupervisor.active && config.devSupervisor.restartMarkerPath
        ),
        runtimeEnvDir: process.env["YUVI_RUNTIME_ENV_DIR"] ?? process.cwd()
      },
      pendingRestart
    },
    memory: {
      memoryRepository,
      activeMemoryRepository: context.activeMemoryRepository,
      databaseUrlConfigured: Boolean(env["DATABASE_URL"]),
      restartRequiredForChanges: true,
      postgresRequiresDatabaseUrl: memoryRepository === "postgres",
      postgresMigrationReminder:
        memoryRepository === "postgres" ? "Run pnpm db:migrate before using Postgres memory." : "",
      memoryExtractor,
      activeMemoryExtractor: context.memory.getExtractorStatus().mode,
      memoryExtractorActive: context.memory.getExtractorStatus().active,
      memoryExtractorDefault: "llm",
      ...buildMemoryExtractorDiagnostics(context.memory.getExtractorStatus(), config.runtimeMode),
      maintenanceScheduler: context.memoryMaintenanceScheduler?.getStatus() ?? null,
      vectorIndex: config.memoryVectorIndex,
      reasoningProviderConfigured: Boolean(providerStatus.providers.reasoning.configured)
    },
    providers: {
      deepseek: {
        baseUrl: env["DEEPSEEK_API_BASEURL"] ?? "https://api.deepseek.com",
        apiKeyConfigured: Boolean(env["DEEPSEEK_API_KEY"]),
        apiKeyPreview: maskSecret(env["DEEPSEEK_API_KEY"]),
        chatModel: env["DEEPSEEK_CHAT_MODEL"] ?? "",
        reasoningModel: env["DEEPSEEK_REASONING_MODEL"] ?? "",
        status: {
          chat: providerStatus.providers.chat,
          reasoning: providerStatus.providers.reasoning
        }
      },
      xai: {
        baseUrl: env["XAI_API_BASEURL"] ?? "https://api.x.ai/v1",
        apiKeyConfigured: Boolean(env["XAI_API_KEY"]),
        apiKeyPreview: maskSecret(env["XAI_API_KEY"]),
        ttsModel: env["XAI_TTS_MODEL"] ?? "",
        ttsVoice: env["XAI_TTS_VOICE"] ?? "",
        visionModel: env["XAI_VISION_MODEL"] ?? "",
        optional: true,
        implemented: false
      },
      dashscope: {
        baseUrl: env["DASHSCOPE_API_BASEURL"] ?? "",
        apiKeyConfigured: Boolean(env["DASHSCOPE_API_KEY"]),
        apiKeyPreview: maskSecret(env["DASHSCOPE_API_KEY"]),
        sttModel: env["DASHSCOPE_STT_MODEL"] ?? "",
        optional: true,
        implemented: false
      },
      embedding: {
        provider: env["EMBEDDING_PROVIDER"] ?? "openai-compatible",
        baseUrl: env["EMBEDDING_API_BASEURL"] ?? "",
        apiKeyConfigured: Boolean(env["EMBEDDING_API_KEY"]),
        apiKeyPreview: maskSecret(env["EMBEDDING_API_KEY"]),
        model: env["EMBEDDING_MODEL"] ?? "",
        dimensions: env["EMBEDDING_DIMENSIONS"] ?? "",
        status: providerStatus.providers.embedding
      }
    },
    restartRequired: pendingRestart,
    editableKeys
  };
}

function validateMemoryExtractorUpdate(values: Record<string, string | null>): string | null {
  if (!("MEMORY_EXTRACTOR" in values)) {
    return null;
  }
  const value = values["MEMORY_EXTRACTOR"] || "llm";
  if (value === "llm" || value === "rule-based") {
    return null;
  }
  return "MEMORY_EXTRACTOR must be one of: llm, rule-based.";
}

function normalizeMemoryExtractor(value: string | undefined): "rule-based" | "llm" {
  return value === "rule-based" ? "rule-based" : "llm";
}

function parseBooleanString(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "TRUE";
}

function hasRestartRequiredLocalOverrides(
  localEnv: Record<string, string>,
  config: ServerConfig,
  activeMemoryRepository: string
): boolean {
  if (
    localEnv["MEMORY_REPOSITORY"] &&
    (localEnv["MEMORY_REPOSITORY"] ?? "in-memory") !== activeMemoryRepository
  ) {
    return true;
  }
  if (localEnv["SERVER_HOST"] && localEnv["SERVER_HOST"] !== config.host) {
    return true;
  }
  if (localEnv["SERVER_PORT"] && Number.parseInt(localEnv["SERVER_PORT"], 10) !== config.port) {
    return true;
  }
  if (
    localEnv["MEMORY_MAINTENANCE_ENABLED"] ||
    localEnv["MEMORY_MAINTENANCE_RUN_ON_STARTUP"] ||
    localEnv["MEMORY_MAINTENANCE_INTERVAL_MINUTES"] ||
    localEnv["MEMORY_MAINTENANCE_LIMIT"] ||
    localEnv["MEMORY_VECTOR_INDEX_ENABLED"] ||
    localEnv["MEMORY_VECTOR_INDEX_TYPE"] ||
    localEnv["MEMORY_VECTOR_DISTANCE"]
  ) {
    return true;
  }
  return Boolean(localEnv["EVENT_BUS"] && localEnv["EVENT_BUS"] !== config.eventBus);
}

async function readEffectiveRuntimeEnv(
  app: FastifyInstance
): Promise<Record<string, string | undefined>> {
  const runtimeEnvFiles = await readRuntimeEnvFiles();
  if (runtimeEnvFiles.base.exists) {
    app.log.info("[env] Loaded .env");
  }
  if (runtimeEnvFiles.local.exists) {
    app.log.info("[env] Loaded .env.local");
  }
  return runtimeEnvFiles.env;
}

function buildSafeConfig(env: Record<string, string | undefined>): Record<string, unknown> {
  const safeConfig: Record<string, unknown> = {};
  for (const key of editableKeys) {
    const value = env[key];
    if (secretKeys.has(key)) {
      safeConfig[key] = {
        configured: Boolean(value),
        maskedValue: maskSecret(value)
      };
      continue;
    }
    safeConfig[key] = value ?? "";
  }
  return safeConfig;
}

function buildLayeredSettings(
  baseEnv: Record<string, string | undefined>,
  localEnv: Record<string, string | undefined>,
  effectiveEnv: Record<string, string | undefined>
): Record<string, unknown> {
  const layeredSettings: Record<string, unknown> = {};
  for (const key of editableKeys) {
    const source = key in localEnv ? ".env.local" : key in baseEnv ? ".env" : "process.env/default";
    if (secretKeys.has(key)) {
      layeredSettings[key] = {
        baseConfigured: Boolean(baseEnv[key]),
        localOverrideConfigured: Boolean(localEnv[key]),
        effectiveConfigured: Boolean(effectiveEnv[key]),
        maskedValue: maskSecret(effectiveEnv[key]),
        source
      };
      continue;
    }

    layeredSettings[key] = {
      base: baseEnv[key] ?? "",
      localOverride: localEnv[key] ?? "",
      effective: effectiveEnv[key] ?? "",
      source
    };
  }
  return layeredSettings;
}

async function writeLocalRuntimeSettings(
  updates: Record<string, string | null>
): Promise<string[]> {
  const envPath = getRuntimeEnvPath(".env.local");
  const existing = (await readRuntimeEnvFiles()).local.values;
  const changedKeys: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const normalized = value ?? "";
    if ((existing[key] ?? "") !== normalized) {
      existing[key] = normalized;
      changedKeys.push(key);
    }
  }

  if (changedKeys.length > 0) {
    await writeFile(envPath, serializeLocalEnv(existing), "utf8");
  }

  return changedKeys;
}

function serializeLocalEnv(values: Record<string, string>): string {
  const lines = [
    "# YUVI Runtime local development settings.",
    "# Generated by Dashboard Settings. Do not commit this file."
  ];
  for (const key of Object.keys(values).sort()) {
    lines.push(`${key}=${quoteEnvValue(values[key] ?? "")}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildMemoryExtractorDiagnostics(
  status: MemoryExtractorStatus,
  runtimeMode: string
): Record<string, unknown> {
  const base = {
    memoryExtractorFallbackUsed: Boolean(status.fallbackUsed),
    memoryExtractorSkippedReason: status.skippedReason
  };
  if (runtimeMode !== "development") {
    return base;
  }
  return {
    ...base,
    memoryExtractorFailureStage: status.failureStage ?? null,
    memoryExtractorError: status.error ?? null,
    memoryExtractorValidationIssues: status.validationIssues ?? null,
    memoryExtractorRejectedReasons: status.rejectedReasons ?? null,
    memoryExtractorRawPreview: status.rawPreview ?? null,
    memoryExtractorCandidateCount: status.candidateCount ?? null,
    memoryExtractorRejectedCount: status.rejectedCount ?? null,
    memoryExtractorFinishReason: status.finishReason ?? null,
    memoryExtractorSelectedOutputSource: status.selectedOutputSource ?? null,
    memoryExtractorAnswerLength: status.answerLength ?? null,
    memoryExtractorReasoningLength: status.reasoningLength ?? null,
    memoryExtractorLastAttemptAt: status.lastAttemptAt ?? null
  };
}

function maskSecret(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const suffix = value.length >= 4 ? value.slice(-4) : "";
  return suffix ? `••••••••••••${suffix}` : "••••••••••••";
}

function isLocalRequest(request: FastifyRequest): boolean {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(request.ip);
}
