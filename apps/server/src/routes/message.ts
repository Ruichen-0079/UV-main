import { ConversationPersistenceError } from "@companion/core";
import { parseRuntimeConfig } from "@companion/config";
import { createEvent } from "@companion/protocol";
import { ProviderError } from "@companion/providers";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

export const MessageRequestSchema = z
  .object({
    sessionId: z.string().min(1).default("default"),
    content: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    /** Explicit Mem0/user identity — preferred over env defaults. */
    subjectUserId: z.string().min(1).optional(),
    personaId: z.string().min(1).optional(),
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
    const identity = resolveMessageIdentity(input.data);
    const event = createEvent("user.message", {
      sessionId: input.data.sessionId,
      content,
      ...(identity.subjectUserId ? { subjectUserId: identity.subjectUserId } : {}),
      ...(identity.personaId ? { personaId: identity.personaId } : {})
    });

    request.log.info(
      {
        traceId: event.traceId,
        sessionId: input.data.sessionId,
        hasSubjectUserId: Boolean(identity.subjectUserId),
        hasPersonaId: Boolean(identity.personaId)
      },
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
      return sendMessageError(reply, error, event.traceId);
    }
  }

  app.post("/message", handleMessage);
  app.post("/v1/messages", handleMessage);
}

export function normalizeMessageMemoryOptions(
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

/**
 * Resolve chat identity for Mem0 scopes.
 * Request fields win; otherwise explicit MEMORY_SUBJECT_USER_ID / MEMORY_PERSONA_ID.
 * Never invents default-user / default-persona.
 */
export function resolveMessageIdentity(input: {
  subjectUserId?: string | undefined;
  personaId?: string | undefined;
}): { subjectUserId?: string; personaId?: string } {
  const runtime = parseRuntimeConfig(process.env);
  const subjectUserId = input.subjectUserId?.trim() || runtime.memory.subjectUserId?.trim();
  const personaId = input.personaId?.trim() || runtime.memory.personaId?.trim();
  return {
    ...(subjectUserId ? { subjectUserId } : {}),
    ...(personaId ? { personaId } : {})
  };
}

export function sendMessageError(
  reply: {
    status(code: number): { send(payload: unknown): unknown };
  },
  error: unknown,
  traceId: string
): unknown {
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
      attemptedProviders: (error as { attemptedProviders?: unknown }).attemptedProviders,
      setup:
        "Configure the selected provider in .env.local and use Settings > Apply Now, or set PROVIDER_ALLOW_MOCKS=true for explicit offline/mock development.",
      traceId
    });
  }
  return reply.status(500).send({
    error: "message_failed",
    message: error instanceof Error ? error.message : "Message handling failed.",
    traceId
  });
}
