import { ConversationPersistenceError, type RuntimeReplyStreamEvent } from "@companion/core";
import { createEvent } from "@companion/protocol";
import { ProviderError, ProviderErrorCode } from "@companion/providers";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import {
  MessageRequestSchema,
  normalizeMessageMemoryOptions,
  sendMessageError
} from "./message.js";
import { SseConnectionClosedError, writeSseFrame } from "./sse.js";

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no"
};

export async function registerMessageStreamRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.post("/v1/messages/stream", async (request, reply) => {
    const input = MessageRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const content = input.data.content ?? input.data.text ?? "";
    const voiceOutput = Boolean(
      input.data.voiceOutput ?? input.data.options?.voiceOutput ?? input.data.options?.tts
    );
    const memoryOptions = normalizeMessageMemoryOptions(input.data.options);
    const userEvent = createEvent("user.message", {
      sessionId: input.data.sessionId,
      content
    });
    const abortController = new AbortController();
    const runtimeStream = context.runtime.streamUserMessage(userEvent, {
      signal: abortController.signal,
      voiceOutput,
      useMemory: memoryOptions.legacyUseMemory,
      readMemory: memoryOptions.readMemory,
      writeMemory: memoryOptions.writeMemory
    });
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
          request.log.warn({ err: error }, "failed to close message stream iterator");
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
        return sendMessageError(reply, error, userEvent.traceId);
      }

      if (clientDisconnected) {
        return;
      }
      if (next.done) {
        return sendMessageError(
          reply,
          new Error("Message stream ended before a completed event was produced."),
          userEvent.traceId
        );
      }

      reply.hijack();
      headersStarted = true;
      reply.raw.writeHead(200, SSE_HEADERS);

      let completed = false;
      while (!next.done) {
        if (clientDisconnected) {
          return;
        }
        const frame = runtimeEventToSseFrame(next.value);
        await writeSseFrame(reply.raw, frame.event, frame.data, abortController.signal);

        if (next.value.type === "completed") {
          completed = true;
          responseFinalized = true;
          break;
        }
        next = await iterator.next();
      }

      if (!completed) {
        throw new Error("Message stream ended before a completed event was produced.");
      }
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    } catch (error) {
      if (clientDisconnected || error instanceof SseConnectionClosedError) {
        return;
      }
      if (!headersStarted) {
        return sendMessageError(reply, error, userEvent.traceId);
      }
      if (!responseFinalized && !reply.raw.destroyed && !reply.raw.writableEnded) {
        try {
          await writeSseFrame(reply.raw, "error", toSseError(error, userEvent.traceId));
        } catch (writeError) {
          request.log.warn({ err: writeError }, "failed to write message stream error");
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

function runtimeEventToSseFrame(event: RuntimeReplyStreamEvent): {
  event: "text-delta" | "completed";
  data: RuntimeReplyStreamEvent;
} {
  return { event: event.type, data: event };
}

function toSseError(error: unknown, traceId: string): {
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
      message: "Message persistence failed.",
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
    message: "Message stream failed.",
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
      return "Message stream was cancelled.";
    case ProviderErrorCode.ProviderUnavailable:
      return "Provider is unavailable.";
    default:
      return "Provider request failed.";
  }
}
