import type { RuntimeLogger } from "@companion/core";
import { RuntimeOrchestrator } from "@companion/core";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  LlmMemoryExtractor,
  MemoryService,
  RuleBasedMemoryExtractor,
  createMemoryBackend,
  createMemoryRepositoryFromEnv,
  createConversationRepositoryFromEnv,
  parseMemoryRepositoryEnv,
  type ConversationRepository,
  type MemoryRepository
} from "@companion/memory";
import { parseRuntimeConfig } from "@companion/config";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createProviderRegistryFromEnv,
  type ProviderRegistry,
  type ProviderStatusMap
} from "@companion/providers";
import type { FastifyBaseLogger } from "fastify";
import type { ServerConfig } from "./config.js";
import { DashboardStateService } from "./services/dashboard.js";
import type { MemoryMaintenanceScheduler } from "./services/memoryMaintenanceScheduler.js";

export type AppContext = {
  eventBus: InMemoryEventBus;
  dashboard: DashboardStateService;
  memoryRepository: MemoryRepository;
  conversationRepository: ConversationRepository;
  memory: MemoryService;
  providers: ProviderRegistry;
  runtime: RuntimeOrchestrator;
  activeMemoryRepository: string;
  memoryMaintenanceScheduler?: MemoryMaintenanceScheduler | undefined;
  reloadRuntimeConfig(env: Record<string, string | undefined>): Promise<RuntimeConfigReloadResult>;
};

export type RuntimeConfigReloadResult = {
  providers: ProviderStatusMap;
  restartRequired: boolean;
  notHotReloaded: string[];
  message: string;
};

export async function createAppContext(
  logger: FastifyBaseLogger,
  config: ServerConfig
): Promise<AppContext> {
  if (config.eventBus === "nats") {
    throw new Error("EVENT_BUS=nats is reserved for future NATS support and is not implemented.");
  }

  const eventBus = new InMemoryEventBus();
  const dashboard = new DashboardStateService();
  eventBus.subscribe("*", (event) => {
    dashboard.recordEvent(event);
  });
  const activeMemoryRepository = parseMemoryRepositoryEnv().kind;
  const memoryRepository = createMemoryRepositoryFromEnv();
  let conversationRepository: ConversationRepository;
  try {
    conversationRepository = createConversationRepositoryFromEnv(
      process.env,
      memoryRepository.getDatabaseClient?.()
    );
  } catch (error) {
    await memoryRepository.close?.();
    throw error;
  }
  const promptBuilder = new PromptBuilder();
  const ruleBasedExtractor = new RuleBasedMemoryExtractor();
  const runtimeLogger = createRuntimeLogger(logger);

  function createMemoryService(
    providers: ProviderRegistry,
    extractorMode = config.memoryExtractor,
    env: Record<string, string | undefined> = process.env
  ): MemoryService {
    const reasoningStatus = providers.getStatus().providers.reasoning;
    const memoryExtractor =
      extractorMode === "llm"
        ? new LlmMemoryExtractor(providers.getReasoningProvider(), ruleBasedExtractor, {
            enabled: true,
            providerConfigured: Boolean(reasoningStatus.configured && !reasoningStatus.mock),
            providerName: reasoningStatus.provider,
            logger: runtimeLogger,
            includeRawPreview: config.runtimeMode === "development"
          })
        : ruleBasedExtractor;

    const runtimeConfig = parseRuntimeConfig(env);
    const backendKind = runtimeConfig.memory.backend === "mem0" ? "mem0" : "legacy";
    // Runtime must not require Sidecar healthy at boot — Mem0 client is lazy HTTP.
    const mem0Backend =
      backendKind === "mem0"
        ? createMemoryBackend({
            kind: "mem0",
            ...(runtimeConfig.memory.mem0BaseUrl
              ? { mem0BaseUrl: runtimeConfig.memory.mem0BaseUrl }
              : {}),
            ...(runtimeConfig.memory.mem0TimeoutMs !== undefined
              ? { mem0TimeoutMs: runtimeConfig.memory.mem0TimeoutMs }
              : {}),
            mem0WriteTimeoutMs: 180_000,
            ...(runtimeConfig.memory.mem0HealthTimeoutMs !== undefined
              ? { mem0HealthTimeoutMs: runtimeConfig.memory.mem0HealthTimeoutMs }
              : {})
          })
        : undefined;

    if (backendKind === "mem0") {
      runtimeLogger.info("memory backend selected", {
        backend: "mem0",
        mem0BaseUrl: runtimeConfig.memory.mem0BaseUrl,
        searchTimeoutMs: runtimeConfig.memory.mem0TimeoutMs
      });
    }

    return new MemoryService(
      memoryRepository,
      undefined,
      undefined,
      memoryExtractor,
      {
        provider: providers.getEmbeddingProvider(),
        // Mem0 owns embeddings for LTM; keep provider only for legacy path.
        enabled: backendKind === "legacy",
        logger: runtimeLogger
      },
      {
        kind: backendKind,
        mem0: mem0Backend,
        searchTimeoutMs: runtimeConfig.memory.mem0TimeoutMs,
        writeTimeoutMs: 180_000,
        logger: runtimeLogger
      }
    );
  }

  function createRuntime(
    providers: ProviderRegistry,
    memory: MemoryService,
    directContext = config.directContext
  ): RuntimeOrchestrator {
    return new RuntimeOrchestrator({
      eventBus,
      memory,
      promptBuilder,
      providers,
      conversation: conversationRepository,
      memoryRepository: activeMemoryRepository,
      directContext,
      logger: runtimeLogger
    });
  }

  let providers: ProviderRegistry;
  let memory: MemoryService;
  let runtime: RuntimeOrchestrator;
  try {
    providers = createProviderRegistryFromEnv();
    memory = createMemoryService(providers);
    runtime = createRuntime(providers, memory);
  } catch (error) {
    await conversationRepository.close?.();
    await memoryRepository.close?.();
    throw error;
  }

  const context: AppContext = {
    eventBus,
    dashboard,
    memoryRepository,
    conversationRepository,
    memory,
    providers,
    runtime,
    activeMemoryRepository,
    async reloadRuntimeConfig(env) {
      await context.runtime.sealAndDrainMemoryWrites();
      const nextProviders = createProviderRegistryFromEnv(env);
      const nextMemory = createMemoryService(
        nextProviders,
        parseMemoryExtractorMode(env["MEMORY_EXTRACTOR"]),
        env
      );
      context.providers = nextProviders;
      context.memory = nextMemory;
      context.runtime = createRuntime(nextProviders, nextMemory, {
        enabled: parseBoolean(env["DIRECT_CONTEXT_ENABLED"], config.directContext.enabled),
        maxTurns: parsePositiveInteger(
          env["DIRECT_CONTEXT_MAX_TURNS"],
          config.directContext.maxTurns
        ),
        maxChars: parsePositiveInteger(
          env["DIRECT_CONTEXT_MAX_CHARS"],
          config.directContext.maxChars
        )
      });

      const notHotReloaded = collectNotHotReloadedSettings(env, config, activeMemoryRepository);
      const restartRequired = notHotReloaded.length > 0;

      return {
        providers: nextProviders.getStatus(),
        restartRequired,
        notHotReloaded,
        message: restartRequired
          ? "Runtime provider config reloaded. Some settings require server restart."
          : "Runtime provider config reloaded."
      };
    }
  };

  return context;
}

function collectNotHotReloadedSettings(
  env: Record<string, string | undefined>,
  config: ServerConfig,
  activeMemoryRepository: string
): string[] {
  const notHotReloaded: string[] = [];
  if (parseMemoryRepositoryEnv(env).kind !== activeMemoryRepository) {
    notHotReloaded.push("MEMORY_REPOSITORY");
  }
  if ((env["SERVER_HOST"] ?? config.host) !== config.host) {
    notHotReloaded.push("SERVER_HOST");
  }
  if (Number.parseInt(env["SERVER_PORT"] ?? String(config.port), 10) !== config.port) {
    notHotReloaded.push("SERVER_PORT");
  }
  if ((env["EVENT_BUS"] ?? config.eventBus) !== config.eventBus) {
    notHotReloaded.push("EVENT_BUS");
  }
  if (parseBoolean(env["MEMORY_MAINTENANCE_ENABLED"], false) !== config.memoryMaintenance.enabled) {
    notHotReloaded.push("MEMORY_MAINTENANCE_ENABLED");
  }
  if (
    parseBoolean(env["MEMORY_MAINTENANCE_RUN_ON_STARTUP"], false) !==
    config.memoryMaintenance.runOnStartup
  ) {
    notHotReloaded.push("MEMORY_MAINTENANCE_RUN_ON_STARTUP");
  }
  if (
    parsePositiveInteger(env["MEMORY_MAINTENANCE_INTERVAL_MINUTES"], 0) !==
    config.memoryMaintenance.intervalMinutes
  ) {
    notHotReloaded.push("MEMORY_MAINTENANCE_INTERVAL_MINUTES");
  }
  if (
    parseStrictPositiveInteger(env["MEMORY_MAINTENANCE_LIMIT"], 500) !==
    config.memoryMaintenance.limit
  ) {
    notHotReloaded.push("MEMORY_MAINTENANCE_LIMIT");
  }
  if (parseBoolean(env["MEMORY_VECTOR_INDEX_ENABLED"], true) !== config.memoryVectorIndex.enabled) {
    notHotReloaded.push("MEMORY_VECTOR_INDEX_ENABLED");
  }
  if ((env["MEMORY_VECTOR_INDEX_TYPE"] ?? "hnsw") !== config.memoryVectorIndex.type) {
    notHotReloaded.push("MEMORY_VECTOR_INDEX_TYPE");
  }
  if ((env["MEMORY_VECTOR_DISTANCE"] ?? "cosine") !== config.memoryVectorIndex.distance) {
    notHotReloaded.push("MEMORY_VECTOR_DISTANCE");
  }
  return notHotReloaded;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1" || value === "yes";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseStrictPositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMemoryExtractorMode(value: string | undefined): "rule-based" | "llm" {
  return value === "rule-based" ? "rule-based" : "llm";
}

function createRuntimeLogger(logger: FastifyBaseLogger): RuntimeLogger {
  return {
    info(message, context) {
      logger.info(context ?? {}, message);
    },
    warn(message, context) {
      logger.warn(context ?? {}, message);
    },
    error(message, context) {
      logger.error(context ?? {}, message);
    }
  };
}
