import type {
  CreateMemoryInput,
  Memory,
  MemorySubtype,
  MemoryType,
  UpdateMemoryInput
} from "@companion/memory";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";

const MemoryTypeSchema = z.enum([
  "working",
  "episodic",
  "semantic",
  "emotional",
  "procedural",
  "relationship"
]);
const MemorySubtypeSchema = z.enum([
  "preference",
  "fact",
  "project",
  "workflow",
  "milestone",
  "provider-choice",
  "path",
  "repo",
  "command",
  "emotion",
  "relationship"
]);

const CreateMemoryRequestSchema = z.object({
  type: MemoryTypeSchema.default("working"),
  subtype: MemorySubtypeSchema.nullable().optional(),
  content: z.string().min(1),
  summary: z.string().nullable().optional(),
  importance: z.number().min(0).max(1).optional(),
  emotionValence: z.number().min(-1).max(1).optional(),
  emotionArousal: z.number().min(0).max(1).optional(),
  source: z.string().min(1).default("manual"),
  sourceTraceId: z.string().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).default([])
});

const UpdateMemoryRequestSchema = z
  .object({
    type: MemoryTypeSchema.optional(),
    subtype: MemorySubtypeSchema.nullable().optional(),
    content: z.string().min(1).optional(),
    summary: z.string().nullable().optional(),
    importance: z.number().min(0).max(1).optional(),
    emotionValence: z.number().min(-1).max(1).optional(),
    emotionArousal: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string()).optional()
  })
  .strict();

const RecentMemoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const SearchMemoryQuerySchema = z.object({
  q: z.string().default(""),
  type: MemoryTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const MemoryParamsSchema = z.object({
  id: z.string().min(1)
});

const BulkDeleteMemoryRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100)
});

const unsafeMetadataKeyPattern = /api[-_]?key|authorization|bearer|token|password|secret/i;

export async function registerMemoryRoutes(
  app: FastifyInstance,
  context: AppContext
): Promise<void> {
  app.post("/memory", async (request, reply) => {
    const input = CreateMemoryRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }
    const unsafeMetadataKey = findUnsafeMetadataKey(input.data.metadata);
    if (unsafeMetadataKey) {
      return reply.status(400).send({
        error: "unsafe_metadata",
        message: `Memory metadata key "${unsafeMetadataKey}" is not allowed.`
      });
    }

    const createInput: CreateMemoryInput = {
      type: input.data.type as MemoryType,
      content: input.data.content,
      source: input.data.source,
      tags: input.data.tags
    };

    if (input.data.subtype !== undefined) {
      createInput.subtype = input.data.subtype as MemorySubtype | null;
    }
    if (input.data.sourceTraceId !== undefined) {
      createInput.sourceTraceId = input.data.sourceTraceId;
    }
    if (input.data.metadata !== undefined) {
      createInput.metadata = input.data.metadata;
    }
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

    return reply.send(toSafeMemory(memory));
  });

  app.get("/memory/recent", async (request, reply) => {
    const query = RecentMemoryQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "invalid_request", details: query.error.flatten() });
    }

    const memories = await context.memoryRepository.listRecentMemories(query.data.limit);
    return reply.send({ memories: memories.map(toSafeMemory) });
  });

  app.get("/memory/search", async (request, reply) => {
    const query = SearchMemoryQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "invalid_request", details: query.error.flatten() });
    }

    const searchQuery: { text: string; types?: MemoryType[]; limit: number } = {
      text: query.data.q,
      limit: query.data.limit
    };

    if (query.data.type) {
      searchQuery.types = [query.data.type as MemoryType];
    }

    const result = await context.memory.retrieveRelevantMemoriesWithMetadata(searchQuery);

    return reply.send({
      mock: false,
      query: result.query,
      repository: process.env["MEMORY_REPOSITORY"] ?? "in-memory",
      rawCount: result.rawCount,
      count: result.count,
      retrievalMode: result.retrievalMode,
      memories: result.selectedMemories.map(toSafeMemory)
    });
  });

  app.post("/memory/bulk-delete", async (request, reply) => {
    const input = BulkDeleteMemoryRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    let deleted = 0;
    for (const id of input.data.ids) {
      if (await context.memoryRepository.deleteMemory(id)) {
        deleted += 1;
      }
    }

    return reply.send({ ok: true, deleted });
  });

  app.get("/memory/:id", async (request, reply) => {
    const params = MemoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }

    const memory = await context.memoryRepository.getMemoryById(params.data.id);
    if (!memory) {
      return reply.status(404).send({ error: "not_found", message: "Memory not found." });
    }

    return reply.send(toSafeMemory(memory));
  });

  app.patch("/memory/:id", async (request, reply) => {
    const params = MemoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }
    const input = UpdateMemoryRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }
    const unsafeMetadataKey = findUnsafeMetadataKey(input.data.metadata);
    if (unsafeMetadataKey) {
      return reply.status(400).send({
        error: "unsafe_metadata",
        message: `Memory metadata key "${unsafeMetadataKey}" is not allowed.`
      });
    }

    const updateInput: UpdateMemoryInput = {};
    if (input.data.type !== undefined) {
      updateInput.type = input.data.type as MemoryType;
    }
    if (input.data.subtype !== undefined) {
      updateInput.subtype = input.data.subtype as MemorySubtype | null;
    }
    if (input.data.content !== undefined) {
      updateInput.content = input.data.content;
    }
    if (input.data.summary !== undefined) {
      updateInput.summary = input.data.summary;
    }
    if (input.data.importance !== undefined) {
      updateInput.importance = input.data.importance;
    }
    if (input.data.emotionValence !== undefined) {
      updateInput.emotionValence = input.data.emotionValence;
    }
    if (input.data.emotionArousal !== undefined) {
      updateInput.emotionArousal = input.data.emotionArousal;
    }
    if (input.data.metadata !== undefined) {
      updateInput.metadata = input.data.metadata;
    }
    if (input.data.tags !== undefined) {
      updateInput.tags = input.data.tags;
    }

    const updated = await context.memoryRepository.updateMemory(params.data.id, updateInput);
    if (!updated) {
      return reply.status(404).send({ error: "not_found", message: "Memory not found." });
    }

    return reply.send(toSafeMemory(updated));
  });

  app.delete("/memory/:id", async (request, reply) => {
    const params = MemoryParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }

    const deleted = await context.memoryRepository.deleteMemory(params.data.id);
    if (!deleted) {
      return reply.status(404).send({ error: "not_found", message: "Memory not found." });
    }

    return reply.send({ ok: true, id: params.data.id });
  });
}

function toSafeMemory(memory: Memory): Memory {
  return {
    ...memory,
    metadata: redactUnsafeMetadata(memory.metadata)
  };
}

function findUnsafeMetadataKey(value: unknown, path: string[] = []): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (unsafeMetadataKeyPattern.test(key)) {
      return nextPath.join(".");
    }
    const nested = findUnsafeMetadataKey(child, nextPath);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function redactUnsafeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (unsafeMetadataKeyPattern.test(key)) {
      output[key] = "[redacted]";
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      output[key] = redactUnsafeMetadata(child as Record<string, unknown>);
    } else {
      output[key] = child;
    }
  }
  return output;
}
