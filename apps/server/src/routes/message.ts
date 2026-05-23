import { createEvent } from "@companion/protocol";
import { ProviderError } from "@companion/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

const MessageRequestSchema = z
  .object({
    sessionId: z.string().min(1).default("default"),
    content: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    voiceOutput: z.boolean().optional(),
    options: z
      .object({
        tts: z.boolean().optional(),
        voiceOutput: z.boolean().optional(),
        useMemory: z.boolean().optional(),
        readMemory: z.boolean().optional(),
        writeMemory: z.boolean().optional(),
        promptPreview: z.boolean().optional()
      })
      .optional()
  })
  .refine((input) => input.content || input.text, {
    message: "Either content or text is required.",
    path: ["text"]
  });

const defaultUseMemory = true;

export async function registerMessageRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  async function handleMessage(
    request: { body: unknown; log: FastifyInstance["log"] },
    reply: {
      status(code: number): { send(payload: unknown): unknown };
      send(payload: unknown): unknown;
    }
  ) {
    const input = MessageRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const content = input.data.content ?? input.data.text ?? "";
    const voiceOutput = Boolean(
      input.data.voiceOutput ?? input.data.options?.voiceOutput ?? input.data.options?.tts
    );
    const memoryOptions = normalizeMessageMemoryOptions(input.data.options);
    const event = createEvent("user.message", {
      sessionId: input.data.sessionId,
      content
    });

    request.log.info(
      { traceId: event.traceId, sessionId: input.data.sessionId },
      "message request received"
    );

    try {
      const response = await context.runtime.handleUserMessage(event, {
        voiceOutput,
        useMemory: memoryOptions.legacyUseMemory,
        readMemory: memoryOptions.readMemory,
        writeMemory: memoryOptions.writeMemory
      });
      const provider = response.payload.provider;
      return reply.send({
        ...response,
        reply: response.payload.content,
        traceId: response.traceId,
        provider,
        memory: {
          legacyUseMemory: memoryOptions.legacyUseMemory,
          readMemory: memoryOptions.readMemory,
          writeMemory: memoryOptions.writeMemory,
          memoryReadEnabled: memoryOptions.readMemory,
          memoryWriteEnabled: memoryOptions.writeMemory
        },
        promptPreview: input.data.options?.promptPreview
          ? context.runtime.getLatestPromptPreview()
          : undefined
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        return reply.status(error.statusCode ?? 503).send({
          error: "provider_unavailable",
          code: error.code,
          provider: error.provider,
          capability: error.capability,
          message: error.message,
          setup:
            "Configure the selected provider in .env.local and use Settings > Apply Now, or set PROVIDER_ALLOW_MOCKS=true for explicit offline/mock development.",
          traceId: event.traceId
        });
      }
      return reply.status(500).send({
        error: "message_failed",
        message: error instanceof Error ? error.message : "Message handling failed.",
        traceId: event.traceId
      });
    }
  }

  app.post("/message", handleMessage);
  app.post("/v1/messages", handleMessage);
}

function normalizeMessageMemoryOptions(
  options:
    | {
        useMemory?: boolean | undefined;
        readMemory?: boolean | undefined;
        writeMemory?: boolean | undefined;
      }
    | undefined
): {
  legacyUseMemory: boolean | undefined;
  readMemory: boolean;
  writeMemory: boolean;
} {
  const legacyUseMemory = options?.useMemory;
  const defaultEnabled = legacyUseMemory ?? defaultUseMemory;
  return {
    legacyUseMemory,
    readMemory: options?.readMemory ?? defaultEnabled,
    writeMemory: options?.writeMemory ?? defaultEnabled
  };
}
