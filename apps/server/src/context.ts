import type { RuntimeLogger } from "@companion/core";
import { RuntimeOrchestrator } from "@companion/core";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  LlmMemoryExtractor,
  MemoryService,
  RuleBasedMemoryExtractor,
  createMemoryRepositoryFromEnv,
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

export type AppContext = {
  eventBus: InMemoryEventBus;
  dashboard: DashboardStateService;
  memoryRepository: MemoryRepository;
  memory: MemoryService;
  providers: ProviderRegistry;
  runtime: RuntimeOrchestrator;
  activeMemoryRepository: string;
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
  const activeMemoryRepository = process.env["MEMORY_REPOSITORY"] ?? "in-memory";

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
            providerName: reasoningStatus.provider
          })
        : ruleBasedExtractor;

    return new MemoryService(memoryRepository, undefined, undefined, memoryExtractor);
  }

  function createRuntime(providers: ProviderRegistry, memory: MemoryService): RuntimeOrchestrator {
    return new RuntimeOrchestrator({
      eventBus,
      memory,
      promptBuilder,
      providers,
      memoryRepository: activeMemoryRepository,
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
      context.runtime = createRuntime(nextProviders, nextMemory);

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
  if ((env["MEMORY_REPOSITORY"] ?? "in-memory") !== activeMemoryRepository) {
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
  return notHotReloaded;
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
