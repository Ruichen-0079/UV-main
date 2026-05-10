import { createEvent } from "@companion/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

const MessageRequestSchema = z.object({
  sessionId: z.string().min(1).default("default"),
  content: z.string().min(1),
  voiceOutput: z.boolean().optional().default(false)
});

export async function registerMessageRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  async function handleMessage(request: { body: unknown; log: FastifyInstance["log"] }, reply: { status(code: number): { send(payload: unknown): unknown }; send(payload: unknown): unknown }) {
    const input = MessageRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const event = createEvent("user.message", {
      sessionId: input.data.sessionId,
      content: input.data.content
    });

    request.log.info({ traceId: event.traceId, sessionId: input.data.sessionId }, "message request received");

    const response = await context.runtime.handleUserMessage(event, {
      voiceOutput: input.data.voiceOutput
    });

    return reply.send(response);
  }

  app.post("/message", handleMessage);
  app.post("/v1/messages", handleMessage);
}
