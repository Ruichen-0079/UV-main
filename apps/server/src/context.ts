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
import { createProviderRegistryFromEnv, type ProviderRegistry } from "@companion/providers";
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
  const providers = createProviderRegistryFromEnv();
  const ruleBasedExtractor = new RuleBasedMemoryExtractor();
  const memoryExtractor =
    config.memoryExtractor === "llm"
      ? new LlmMemoryExtractor(providers.getReasoningProvider(), ruleBasedExtractor)
      : ruleBasedExtractor;
  const memory = new MemoryService(memoryRepository, undefined, undefined, memoryExtractor);
  const runtimeLogger = createRuntimeLogger(logger);

  const runtime = new RuntimeOrchestrator({
    eventBus,
    memory,
    promptBuilder,
    providers,
    memoryRepository: process.env["MEMORY_REPOSITORY"] ?? "in-memory",
    logger: runtimeLogger
  });

  return {
    eventBus,
    dashboard,
    memoryRepository,
    memory,
    providers,
    runtime
  };
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
