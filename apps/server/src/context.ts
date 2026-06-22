import type { RuntimeLogger } from "@companion/core";
import { RuntimeOrchestrator } from "@companion/core";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  LlmMemoryExtractor,
  MemoryService,
  RuleBasedMemoryExtractor,
  createMemoryRepositoryFromEnv,
  parseMemoryRepositoryEnv,
  type MemoryRepository
} from "@companion/memory";
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
  memory: MemoryService;
  providers: ProviderRegistry;
  runtime: RuntimeOrchestrator;
  activeMemoryRepository: string;
  memoryMaintenanceScheduler?: MemoryMaintenanceScheduler | undefined;
  reloadRuntimeConfig(env: Record<string, string | undefined>): RuntimeConfigReloadResult;
};

export type RuntimeConfigReloadResult = {
  providers: ProviderStatusMap;
  restartRequired: boolean;
  notHotReloaded: string[];
  message: string;
};

export function createAppContext(logger: FastifyBaseLogger, config: ServerConfig): AppContext {
  if (config.eventBus === "nats") {
    throw new Error("EVENT_BUS=nats is reserved for future NATS support and is not implemented.");
  }

  const eventBus = new InMemoryEventBus();
  const dashboard = new DashboardStateService();
  eventBus.subscribe("*", (event) => {
    dashboard.recordEvent(event);
  });
  const memoryRepository = createMemoryRepositoryFromEnv();
  const promptBuilder = new PromptBuilder();
  const ruleBasedExtractor = new RuleBasedMemoryExtractor();
  const runtimeLogger = createRuntimeLogger(logger);
  const activeMemoryRepository = parseMemoryRepositoryEnv().kind;

  function createMemoryService(
    providers: ProviderRegistry,
    extractorMode = config.memoryExtractor
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

    return new MemoryService(memoryRepository, undefined, undefined, memoryExtractor, {
      provider: providers.getEmbeddingProvider(),
      enabled: true,
      logger: runtimeLogger
    });
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
      memoryRepository: activeMemoryRepository,
      directContext,
      logger: runtimeLogger
    });
  }

  const providers = createProviderRegistryFromEnv();
  const memory = createMemoryService(providers);
  const runtime = createRuntime(providers, memory);

  const context: AppContext = {
    eventBus,
    dashboard,
    memoryRepository,
    memory,
    providers,
    runtime,
    activeMemoryRepository,
    reloadRuntimeConfig(env) {
      const nextProviders = createProviderRegistryFromEnv(env);
      const nextMemory = createMemoryService(
        nextProviders,
        parseMemoryExtractorMode(env["MEMORY_EXTRACTOR"])
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
