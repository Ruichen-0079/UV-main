import { createEvent } from "@companion/protocol";
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
        useMemory: input.data.options?.useMemory ?? defaultUseMemory,
        readMemory: input.data.options?.readMemory,
        writeMemory: input.data.options?.writeMemory
      });
      const provider = response.payload.provider;
      return reply.send({
        ...response,
        reply: response.payload.content,
        traceId: response.traceId,
        provider,
        promptPreview: input.data.options?.promptPreview
          ? context.runtime.getLatestPromptPreview()
          : undefined
      });
    } catch (error) {
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
