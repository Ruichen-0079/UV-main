import type { CreateMemoryInput, MemoryType } from "@companion/memory";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

const MemoryTypeSchema = z.enum(["working", "episodic", "semantic", "emotional", "procedural"]);

const CreateMemoryRequestSchema = z.object({
  type: MemoryTypeSchema.default("working"),
  content: z.string().min(1),
  summary: z.string().nullable().optional(),
  importance: z.number().min(0).max(1).optional(),
  emotionValence: z.number().min(-1).max(1).optional(),
  emotionArousal: z.number().min(0).max(1).optional(),
  source: z.string().min(1).default("manual"),
  tags: z.array(z.string()).default([])
});

const RecentMemoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export async function registerMemoryRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.post("/memory", async (request, reply) => {
    const input = CreateMemoryRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const createInput: CreateMemoryInput = {
      type: input.data.type as MemoryType,
      content: input.data.content,
      source: input.data.source,
      tags: input.data.tags
    };

    if (input.data.summary !== undefined) {
      createInput.summary = input.data.summary;
    }
    if (input.data.importance !== undefined) {
      createInput.importance = input.data.importance;
    }
    if (input.data.emotionValence !== undefined) {
      createInput.emotionValence = input.data.emotionValence;
    }
    if (input.data.emotionArousal !== undefined) {
      createInput.emotionArousal = input.data.emotionArousal;
    }

    const memory = await context.memoryRepository.createMemory(createInput);

    return reply.send(memory);
  });

  app.get("/memory/recent", async (request, reply) => {
    const query = RecentMemoryQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "invalid_request", details: query.error.flatten() });
    }

    const memories = await context.memoryRepository.listRecentMemories(query.data.limit);
    return reply.send({ memories });
  });
}
