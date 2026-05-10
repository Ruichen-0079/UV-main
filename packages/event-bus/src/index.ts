import type { RuntimeEvent } from "@companion/protocol";

export type EventHandler<TEvent extends RuntimeEvent = RuntimeEvent> = (
  event: TEvent
) => void | Promise<void>;

export type EventTypePattern =
  | "*"
  | "user.*"
  | "memory.*"
  | "agent.*"
  | "tts.*"
  | "stt.*"
  | "vision.*"
  | "provider.*"
  | string;

export type EventSubscription = {
  unsubscribe(): void;
};

export interface EventBus {
  publish<TEvent extends RuntimeEvent>(event: TEvent): Promise<void>;
  subscribe<TEvent extends RuntimeEvent>(
    typePattern: TEvent["type"] | EventTypePattern,
    handler: EventHandler<TEvent>
  ): EventSubscription;
}

export type EventBusLogger = {
  debug(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
};

export type InMemoryEventBusOptions = {
  logger?: EventBusLogger;
  development?: boolean;
};

type HandlerEntry = {
  pattern: EventTypePattern;
  handler: EventHandler;
};

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Set<HandlerEntry>();
  private readonly logger: EventBusLogger | undefined;
  private readonly development: boolean;

  constructor(options: InMemoryEventBusOptions = {}) {
    this.logger = options.logger;
    this.development = options.development ?? process.env["NODE_ENV"] === "development";
  }

  async publish<TEvent extends RuntimeEvent>(event: TEvent): Promise<void> {
    const eventWithTrace = this.withTraceId(event);
    const matchingHandlers = Array.from(this.handlers)
      .filter((entry) => matchesEventType(entry.pattern, eventWithTrace.type));

    this.log("event published", {
      type: eventWithTrace.type,
      id: eventWithTrace.id,
      traceId: eventWithTrace.traceId,
      subscriberCount: matchingHandlers.length
    });

    await Promise.all(matchingHandlers.map(async (entry) => {
      try {
        await entry.handler(eventWithTrace);
      } catch (error) {
        this.logWarn("event handler failed", {
          type: eventWithTrace.type,
          id: eventWithTrace.id,
          traceId: eventWithTrace.traceId,
          pattern: entry.pattern,
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : "Unknown event handler error."
        });
      }
    }));
  }

  subscribe<TEvent extends RuntimeEvent>(
    typePattern: TEvent["type"] | EventTypePattern,
    handler: EventHandler<TEvent>
  ): EventSubscription {
    const entry: HandlerEntry = {
      pattern: typePattern,
      handler: handler as EventHandler
    };

    this.handlers.add(entry);
    this.log("event subscription added", { typePattern });

    return {
      unsubscribe: () => {
        this.handlers.delete(entry);
        this.log("event subscription removed", { typePattern });
      }
    };
  }

  private withTraceId<TEvent extends RuntimeEvent>(event: TEvent): TEvent {
    if (event.traceId.length > 0) {
      return event;
    }

    return {
      ...event,
      traceId: event.id
    };
  }

  private log(message: string, context: Record<string, unknown>): void {
    if (!this.development) {
      return;
    }

    if (this.logger) {
      this.logger.debug(message, context);
      return;
    }

    console.debug(`[event-bus] ${message}`, context);
  }

  private logWarn(message: string, context: Record<string, unknown>): void {
    if (this.logger?.warn) {
      this.logger.warn(message, context);
      return;
    }

    if (this.development) {
      console.warn(`[event-bus] ${message}`, context);
    }
  }
}

export function matchesEventType(pattern: EventTypePattern, eventType: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (!pattern.endsWith(".*")) {
    return pattern === eventType;
  }

  const prefix = pattern.slice(0, -1);
  return eventType.startsWith(prefix);
}
