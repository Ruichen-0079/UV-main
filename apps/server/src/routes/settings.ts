import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { MemoryExtractorStatus } from "@companion/memory";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";
import {
  applyRuntimeEnv,
  getRuntimeEnvDir,
  getRuntimeEnvPath,
  quoteEnvValue,
  readRuntimeEnvFiles
} from "../env.js";
import { readMemoryIngestionDiagnostics } from "../memory-ingestion-diagnostics.js";
import {
  editableKeys,
  getPendingRestartKeys,
  getRuntimeSettingApplyMode,
  sanitizeSettingValue,
  secretKeys,
  validateRuntimeSettings,
  type EditableRuntimeSetting
} from "../runtime-settings.js";
import { requireLocalDashboardAccess } from "./security.js";

const RuntimeSettingsUpdateSchema = z
  .object({
    values: z.record(z.string(), z.string().nullable()).optional().default({}),
    removeOverrides: z.array(z.string()).optional().default([])
  })
  .strict()
  .superRefine((value, context) => {
    const conflicts = Object.keys(value.values).filter((key) =>
      value.removeOverrides.includes(key)
    );
    if (conflicts.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["removeOverrides"],
        message: `Keys cannot be both set and removed: ${conflicts.join(", ")}.`
      });
    }
  });

let settingsOperationQueue: Promise<void> = Promise.resolve();

export async function registerSettingsRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  app.get("/settings/runtime", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) {
      return reply;
    }
    return buildRuntimeSettings(context, config);
  });

  app.post("/settings/runtime", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) {
      return reply;
    }

    if (config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Runtime settings updates are only available in development mode."
      });
    }

    const parsed = RuntimeSettingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_request",
        details: parsed.error.flatten()
      });
    }

    const unsafeKeys = [...Object.keys(parsed.data.values), ...parsed.data.removeOverrides].filter(
      (key) => !editableKeys.includes(key as EditableRuntimeSetting)
    );
    if (unsafeKeys.length > 0) {
      return reply.status(400).send({
        error: "unsafe_keys",
        message: "Only allowlisted local development settings can be updated.",
        unsafeKeys: Array.from(new Set(unsafeKeys))
      });
    }

    return withSettingsOperationLock(async () => {
      let changedKeys: string[];
      try {
        changedKeys = await writeLocalRuntimeSettings(
          parsed.data.values,
          parsed.data.removeOverrides
        );
      } catch (error) {
        if (error instanceof InvalidRuntimeSettingsError) {
          return reply.status(400).send({
            error: "invalid_settings",
            fieldErrors: error.fieldErrors
          });
        }
        throw error;
      }
      const runtimeEnvFiles = await readRuntimeEnvFiles();
      const pendingRestartKeys = getPendingRestartKeys(
        runtimeEnvFiles.env,
        context.activeRuntimeEnv
      );
      return reply.send({
        ok: true,
        restartRequired: pendingRestartKeys.length > 0,
        pendingRestartKeys,
        changedKeys,
        settings: await buildRuntimeSettings(context, config)
      });
    });
  });

  app.post("/settings/runtime/reload", async (request, reply) => {
    if (!requireLocalDashboardAccess(config, request, reply)) {
      return reply;
    }

    if (config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Runtime settings reload is only available in development mode."
      });
    }

    return withSettingsOperationLock(async () => {
      const effectiveEnv = await readEffectiveRuntimeEnv(app);
      const validation = validateRuntimeSettings(effectiveEnv);
      if (Object.keys(validation.fieldErrors).length > 0) {
        return reply.status(400).send({
          error: "invalid_settings",
          fieldErrors: validation.fieldErrors
        });
      }
      const result = await context.reloadRuntimeConfig(effectiveEnv);
      applyRuntimeEnv(buildAppliedProcessEnv(effectiveEnv, context));
      const settings = await buildRuntimeSettings(context, config);

      return reply.send({
        ok: true,
        applied: true,
        appliedKeys: result.appliedKeys,
        restartRequired: result.restartRequired,
        pendingRestartKeys: result.pendingRestartKeys,
        active: {
          providers: result.providers.providers,
          memoryRepository: context.activeMemoryRepository
        },
        notHotReloaded: result.notHotReloaded,
        message: result.message,
        settings
      });
    });
  });
}

async function withSettingsOperationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = settingsOperationQueue;
  let release!: () => void;
  settingsOperationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
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
  const pendingRestartKeys = getPendingRestartKeys(env, context.activeRuntimeEnv);
  const pendingRestart = pendingRestartKeys.length > 0;

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
        chat: sanitizeProviderStatus(providerStatus.providers.chat),
        reasoning: sanitizeProviderStatus(providerStatus.providers.reasoning),
        embedding: sanitizeProviderStatus(providerStatus.providers.embedding),
        tts: sanitizeProviderStatus(providerStatus.providers.tts),
        stt: sanitizeProviderStatus(providerStatus.providers.stt),
        vision: sanitizeProviderStatus(providerStatus.providers.vision)
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
        runtimeEnvDir: getRuntimeEnvDir()
      },
      pendingRestart,
      pendingRestartKeys
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
      ingestionCoordinator: await readMemoryIngestionDiagnostics(
        context.memoryIngestionCoordinator
      ),
      vectorIndex: config.memoryVectorIndex,
      reasoningProviderConfigured: Boolean(providerStatus.providers.reasoning.configured)
    },
    providers: {
      deepseek: {
        baseUrl: sanitizeSettingValue(
          "DEEPSEEK_API_BASEURL",
          env["DEEPSEEK_API_BASEURL"] ?? "https://api.deepseek.com"
        ),
        apiKeyConfigured: Boolean(env["DEEPSEEK_API_KEY"]),
        apiKeyPreview: maskSecret(env["DEEPSEEK_API_KEY"]),
        chatModel: env["DEEPSEEK_CHAT_MODEL"] ?? "",
        reasoningModel: env["DEEPSEEK_REASONING_MODEL"] ?? "",
        status: {
          chat: sanitizeProviderStatus(providerStatus.providers.chat),
          reasoning: sanitizeProviderStatus(providerStatus.providers.reasoning)
        }
      },
      xai: {
        baseUrl: sanitizeSettingValue(
          "XAI_API_BASEURL",
          env["XAI_API_BASEURL"] ?? "https://api.x.ai/v1"
        ),
        apiKeyConfigured: Boolean(env["XAI_API_KEY"]),
        apiKeyPreview: maskSecret(env["XAI_API_KEY"]),
        ttsModel: env["XAI_TTS_MODEL"] ?? "",
        ttsVoice: env["XAI_TTS_VOICE"] ?? "",
        visionModel: env["XAI_VISION_MODEL"] ?? "",
        optional: true,
        implementedCapabilities: ["tts", "vision"]
      },
      dashscope: {
        baseUrl: sanitizeSettingValue("DASHSCOPE_API_BASEURL", env["DASHSCOPE_API_BASEURL"] ?? ""),
        apiKeyConfigured: Boolean(env["DASHSCOPE_API_KEY"]),
        apiKeyPreview: maskSecret(env["DASHSCOPE_API_KEY"]),
        sttModel: env["DASHSCOPE_STT_MODEL"] ?? "",
        optional: true,
        implementedCapabilities: ["stt"]
      },
      embedding: {
        provider: env["EMBEDDING_PROVIDER"] ?? "openai-compatible",
        baseUrl: sanitizeSettingValue("EMBEDDING_API_BASEURL", env["EMBEDDING_API_BASEURL"] ?? ""),
        apiKeyConfigured: Boolean(env["EMBEDDING_API_KEY"]),
        apiKeyPreview: maskSecret(env["EMBEDDING_API_KEY"]),
        model: env["EMBEDDING_MODEL"] ?? "",
        dimensions: env["EMBEDDING_DIMENSIONS"] ?? "",
        status: sanitizeProviderStatus(providerStatus.providers.embedding)
      }
    },
    restartRequired: pendingRestart,
    pendingRestartKeys,
    editableKeys,
    applyModes: Object.fromEntries(
      editableKeys.map((key) => [key, getRuntimeSettingApplyMode(key)])
    )
  };
}

function normalizeMemoryExtractor(value: string | undefined): "rule-based" | "llm" {
  return value === "rule-based" ? "rule-based" : "llm";
}

function parseBooleanString(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "TRUE";
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

function buildAppliedProcessEnv(
  effectiveEnv: Record<string, string | undefined>,
  context: AppContext
): Record<string, string | undefined> {
  const processEnv = { ...effectiveEnv };
  for (const key of editableKeys) {
    if (getRuntimeSettingApplyMode(key) !== "restart_required") continue;
    const activeValue = context.activeRuntimeEnv[key];
    if (activeValue === undefined) {
      delete processEnv[key];
    } else {
      processEnv[key] = activeValue;
    }
  }
  return processEnv;
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
    safeConfig[key] = sanitizeSettingValue(key, value) ?? "";
  }
  return safeConfig;
}

function sanitizeProviderStatus<T extends { baseUrl?: string | undefined }>(status: T): T {
  return {
    ...status,
    ...(status.baseUrl !== undefined
      ? { baseUrl: sanitizeSettingValue("XAI_API_BASEURL", status.baseUrl) }
      : {})
  };
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
      base: sanitizeSettingValue(key, baseEnv[key]) ?? "",
      localOverride: sanitizeSettingValue(key, localEnv[key]) ?? "",
      effective: sanitizeSettingValue(key, effectiveEnv[key]) ?? "",
      source
    };
  }
  return layeredSettings;
}

async function writeLocalRuntimeSettings(
  updates: Record<string, string | null>,
  removeOverrides: string[]
): Promise<string[]> {
  const envPath = getRuntimeEnvPath(".env.local");
  const runtimeEnvFiles = await readRuntimeEnvFiles();
  const existing = runtimeEnvFiles.local.values;
  const candidate = { ...existing };
  const changedKeys: string[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const normalized = value ?? "";
    if (!(key in candidate) || candidate[key] !== normalized) changedKeys.push(key);
    candidate[key] = normalized;
  }

  for (const key of removeOverrides) {
    if (key in candidate) {
      delete candidate[key];
      changedKeys.push(key);
    }
  }

  const ambientEnv = { ...process.env };
  const localStateKeys = new Set([
    ...Object.keys(existing),
    ...Object.keys(candidate),
    ...removeOverrides
  ]);
  for (const key of localStateKeys) delete ambientEnv[key];
  const candidateEnv = { ...runtimeEnvFiles.base.values, ...ambientEnv, ...candidate };
  const validation = validateRuntimeSettings(candidateEnv);
  if (Object.keys(validation.fieldErrors).length > 0) {
    throw new InvalidRuntimeSettingsError(validation.fieldErrors);
  }

  const uniqueChangedKeys = Array.from(new Set(changedKeys));
  if (uniqueChangedKeys.length > 0) {
    await atomicWriteLocalEnv(envPath, serializeLocalEnv(candidate));
  }

  return uniqueChangedKeys;
}

class InvalidRuntimeSettingsError extends Error {
  constructor(readonly fieldErrors: Record<string, string>) {
    super("Runtime settings are invalid.");
    this.name = "InvalidRuntimeSettingsError";
  }
}

async function atomicWriteLocalEnv(envPath: string, content: string): Promise<void> {
  const directory = dirname(envPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${envPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, envPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
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
