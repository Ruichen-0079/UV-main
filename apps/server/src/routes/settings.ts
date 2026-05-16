import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
import type { AppContext } from "../context.js";

const editableKeys = [
  "MEMORY_REPOSITORY",
  "EVENT_BUS",
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
  "EMBEDDING_PROVIDER",
  "EMBEDDING_API_BASEURL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIMENSIONS"
] as const;

const RuntimeSettingsUpdateSchema = z.object({
  values: z.record(z.string(), z.string().nullable())
});

export async function registerSettingsRoutes(
  app: FastifyInstance,
  context: AppContext,
  config: ServerConfig
): Promise<void> {
  app.get("/settings/runtime", async () => {
    return buildRuntimeSettings(context, config);
  });

  app.post("/settings/runtime", async (request, reply) => {
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

    const changedKeys = await writeLocalRuntimeSettings(parsed.data.values);
    return reply.send({
      ok: true,
      restartRequired: changedKeys.length > 0,
      changedKeys,
      settings: await buildRuntimeSettings(context, config)
    });
  });
}

async function buildRuntimeSettings(context: AppContext, config: ServerConfig) {
  const baseEnv = await readLocalEnv(path.join(process.cwd(), ".env"));
  const localEnv = await readLocalEnv(path.join(process.cwd(), ".env.local"));
  const env = { ...baseEnv, ...process.env, ...localEnv };
  const providerStatus = context.providers.getStatus();
  const memoryRepository = env["MEMORY_REPOSITORY"] ?? "in-memory";
  const pendingRestart = Object.entries(localEnv).some(
    ([key, value]) => process.env[key] !== value
  );

  return {
    runtime: {
      serverHost: env["SERVER_HOST"] ?? config.host,
      serverPort: Number.parseInt(env["SERVER_PORT"] ?? String(config.port), 10),
      activeServerHost: config.host,
      activeServerPort: config.port,
      runtimeMode: config.runtimeMode,
      eventBus: env["EVENT_BUS"] ?? config.eventBus,
      activeEventBus: config.eventBus,
      pendingRestart
    },
    memory: {
      memoryRepository,
      activeMemoryRepository: process.env["MEMORY_REPOSITORY"] ?? "in-memory",
      databaseUrlConfigured: Boolean(env["DATABASE_URL"]),
      restartRequiredForChanges: true,
      postgresRequiresDatabaseUrl: memoryRepository === "postgres",
      postgresMigrationReminder:
        memoryRepository === "postgres" ? "Run pnpm db:migrate before using Postgres memory." : ""
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
        provider: env["EMBEDDING_PROVIDER"] ?? "mock",
        baseUrl: env["EMBEDDING_API_BASEURL"] ?? "",
        apiKeyConfigured: Boolean(env["EMBEDDING_API_KEY"]),
        apiKeyPreview: maskSecret(env["EMBEDDING_API_KEY"]),
        model: env["EMBEDDING_MODEL"] ?? "",
        dimensions: env["EMBEDDING_DIMENSIONS"] ?? ""
      }
    },
    restartRequired: pendingRestart,
    editableKeys
  };
}

async function writeLocalRuntimeSettings(
  updates: Record<string, string | null>
): Promise<string[]> {
  const envPath = path.join(process.cwd(), ".env.local");
  const existing = await readLocalEnv(envPath);
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

async function readLocalEnv(envPath: string): Promise<Record<string, string>> {
  try {
    return parseEnvText(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    result[trimmed.slice(0, separator)] = unquoteEnvValue(trimmed.slice(separator + 1));
  }
  return result;
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

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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
