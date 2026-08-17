import {
  AssistantTurnConflictError,
  ConversationPersistenceError,
  type RuntimeReplyStreamEvent
} from "@companion/core";
import { ProviderError, ProviderErrorCode } from "@companion/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { desktopCorsHeaders } from "../cors.js";
import { SseConnectionClosedError, writeSseFrame } from "./sse.js";
import { resolveMessageIdentity } from "./message.js";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no"
};

export const ProactiveTurnStreamRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1),
    modality: z.literal("text"),
    options: z
      .object({
        readMemory: z.boolean(),
        promptPreview: z.boolean().optional()
      })
      .strict()
  })
  .strict();

export type ProactiveTurnStreamRequest = z.infer<typeof ProactiveTurnStreamRequestSchema>;

export async function registerProactiveTurnStreamRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.post("/v1/proactive-turns/stream", async (request, reply) => {
    const input = ProactiveTurnStreamRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const identity = resolveMessageIdentity({});
    const requestTraceId = crypto.randomUUID();
    const abortController = new AbortController();
    const runtimeStream = context.runtime.streamAssistantInitiatedTurn(
      {
        sessionId: input.data.sessionId,
        idempotencyKey: input.data.idempotencyKey,
        readMemory: input.data.options.readMemory,
        ...(identity.personaId ? { personaId: identity.personaId } : {}),
        ...(identity.subjectUserId ? { subjectUserId: identity.subjectUserId } : {})
      },
      {
        signal: abortController.signal,
        promptPreview: input.data.options.promptPreview
      }
    );
    const iterator = runtimeStream[Symbol.asyncIterator]();
    let headersStarted = false;
    let responseFinalized = false;
    let clientDisconnected = false;
    let closePromise: Promise<void> | undefined;

    const closeIterator = (): Promise<void> => {
      if (closePromise) {
        return closePromise;
      }
      closePromise = Promise.resolve(iterator.return?.()).then(
        () => undefined,
        (error) => {
          request.log.warn({ err: error }, "failed to close proactive turn stream iterator");
        }
      );
      return closePromise;
    };
    const onDisconnect = () => {
      if (responseFinalized) {
        return;
      }
      clientDisconnected = true;
      abortController.abort();
      void closeIterator();
    };
    const onResponseError = () => onDisconnect();

    request.raw.once("aborted", onDisconnect);
    reply.raw.once("close", onDisconnect);
    reply.raw.once("error", onResponseError);

    try {
      let next: IteratorResult<RuntimeReplyStreamEvent>;
      try {
        next = await iterator.next();
      } catch (error) {
        if (clientDisconnected) {
          return;
        }
        return sendProactiveTurnError(reply, error, requestTraceId);
      }

      if (clientDisconnected) {
        return;
      }
      if (next.done) {
        return sendProactiveTurnError(
          reply,
          new Error("Proactive turn stream ended before a completed event was produced."),
          requestTraceId
        );
      }

      reply.hijack();
      headersStarted = true;
      reply.raw.writeHead(200, {
        ...SSE_HEADERS,
        ...desktopCorsHeaders(request.headers.origin)
      });

      let completed = false;
      while (!next.done) {
        if (clientDisconnected) {
          return;
        }
        await writeSseFrame(reply.raw, next.value.type, next.value, abortController.signal);
        if (next.value.type === "completed") {
          completed = true;
          responseFinalized = true;
          break;
        }
        next = await iterator.next();
      }

      if (!completed) {
        throw new Error("Proactive turn stream ended before a completed event was produced.");
      }
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    } catch (error) {
      if (clientDisconnected || error instanceof SseConnectionClosedError) {
        return;
      }
      if (!headersStarted) {
        return sendProactiveTurnError(reply, error, requestTraceId);
      }
      if (!responseFinalized && !reply.raw.destroyed && !reply.raw.writableEnded) {
        try {
          await writeSseFrame(reply.raw, "error", toSseError(error, requestTraceId));
        } catch (writeError) {
          request.log.warn({ err: writeError }, "failed to write proactive turn stream error");
        }
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    } finally {
      request.raw.off("aborted", onDisconnect);
      reply.raw.off("close", onDisconnect);
      reply.raw.off("error", onResponseError);
      await closeIterator();
    }
  });
}

function sendProactiveTurnError(
  reply: { status(code: number): { send(payload: unknown): unknown } },
  error: unknown,
  traceId: string
): unknown {
  if (error instanceof AssistantTurnConflictError) {
    return reply.status(409).send({
      error: "idempotency_conflict",
      message: "The assistant turn idempotency key has already been used.",
      traceId
    });
  }
  if (error instanceof ConversationPersistenceError) {
    return reply.status(503).send({
      error: "persistence_failed",
      operation: error.operation,
      message: error.message,
      traceId
    });
  }
  if (error instanceof ProviderError) {
    return reply.status(error.statusCode ?? 503).send({
      error: "provider_unavailable",
      code: error.code,
      provider: error.provider,
      capability: error.capability,
      message: error.message,
      traceId
    });
  }
  return reply.status(500).send({
    error: "proactive_turn_failed",
    message: "Assistant-initiated turn failed.",
    traceId
  });
}

function toSseError(
  error: unknown,
  traceId: string
): {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
  traceId: string;
} {
  if (error instanceof ConversationPersistenceError) {
    return {
      type: "error",
      code: "PERSISTENCE_FAILED",
      message: "Assistant message persistence failed.",
      retryable: false,
      traceId
    };
  }
  if (error instanceof ProviderError) {
    return {
      type: "error",
      code: error.code,
      message: safeProviderMessage(error.code),
      retryable: error.retryable,
      traceId
    };
  }
  return {
    type: "error",
    code: "INTERNAL",
    message: "Assistant-initiated turn failed.",
    retryable: false,
    traceId
  };
}

function safeProviderMessage(code: string): string {
  switch (code) {
    case ProviderErrorCode.MissingApiKey:
    case ProviderErrorCode.InvalidApiKey:
    case ProviderErrorCode.PermissionDenied:
      return "Provider authentication failed.";
    case ProviderErrorCode.RateLimited:
      return "Provider rate limit reached.";
    case ProviderErrorCode.Timeout:
      return "Provider request timed out.";
    case ProviderErrorCode.Cancelled:
      return "Assistant-initiated turn was cancelled.";
    case ProviderErrorCode.ProviderUnavailable:
      return "Provider is unavailable.";
    default:
      return "Provider request failed.";
  }
}
