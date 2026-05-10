import type { RuntimeLogger } from "@companion/core";
import { RuntimeOrchestrator } from "@companion/core";
import { InMemoryEventBus } from "@companion/event-bus";
import {
  MemoryService,
  createMemoryRepositoryFromEnv,
  type MemoryRepository
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import { createProviderRegistryFromEnv, type ProviderRegistry } from "@companion/providers";
import type { FastifyBaseLogger } from "fastify";

export type AppContext = {
  eventBus: InMemoryEventBus;
  memoryRepository: MemoryRepository;
  memory: MemoryService;
  providers: ProviderRegistry;
  runtime: RuntimeOrchestrator;
};

export function createAppContext(logger: FastifyBaseLogger): AppContext {
  const eventBus = new InMemoryEventBus();
  const memoryRepository = createMemoryRepositoryFromEnv();
  const memory = new MemoryService(memoryRepository);
  const promptBuilder = new PromptBuilder();
  const providers = createProviderRegistryFromEnv();
  const runtimeLogger = createRuntimeLogger(logger);

  const runtime = new RuntimeOrchestrator({
    eventBus,
    memory,
    promptBuilder,
    providers,
    logger: runtimeLogger
  });

  return {
    eventBus,
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
