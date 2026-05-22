import type {
  CreateMemoryInput,
  Memory,
  MemoryLayer,
  MemoryScope,
  MemoryStatus,
  MemorySubtype,
  MemoryType,
  UpdateMemoryInput
} from "@companion/memory";
import type { RetrievedMemoryDebug } from "@companion/memory";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ServerConfig } from "../config.js";
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
  "troubleshooting",
  "config",
  "emotion",
  "relationship"
]);
const MemoryScopeSchema = z.enum(["user", "project", "agent", "plugin", "session"]);
const MemoryLayerSchema = z.enum(["core", "recall", "archival", "working"]);
const MemoryStatusSchema = z.enum(["active", "superseded", "archived", "forgotten", "expired"]);
const OptionalDateStringSchema = z.string().min(1).nullable().optional();

const CreateMemoryRequestSchema = z.object({
  type: MemoryTypeSchema.default("working"),
  subtype: MemorySubtypeSchema.nullable().optional(),
  scope: MemoryScopeSchema.optional(),
  scopeId: z.string().min(1).nullable().optional(),
  memoryLayer: MemoryLayerSchema.optional(),
  status: MemoryStatusSchema.optional(),
  content: z.string().min(1),
  summary: z.string().nullable().optional(),
  importance: z.number().min(0).max(1).optional(),
  emotionValence: z.number().min(-1).max(1).optional(),
  emotionArousal: z.number().min(0).max(1).optional(),
  source: z.string().min(1).default("manual"),
  sourceTraceId: z.string().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string()).default([]),
  observedAt: OptionalDateStringSchema,
  eventTime: OptionalDateStringSchema,
  validFrom: OptionalDateStringSchema,
  validUntil: OptionalDateStringSchema,
  expiresAt: OptionalDateStringSchema,
  supersededAt: OptionalDateStringSchema,
  supersedes: z.array(z.string().min(1)).optional(),
  supersededBy: z.string().min(1).nullable().optional(),
  contradicts: z.array(z.string().min(1)).optional()
});

const UpdateMemoryRequestSchema = z
  .object({
    type: MemoryTypeSchema.optional(),
    subtype: MemorySubtypeSchema.nullable().optional(),
    scope: MemoryScopeSchema.optional(),
    scopeId: z.string().min(1).nullable().optional(),
    memoryLayer: MemoryLayerSchema.optional(),
    status: MemoryStatusSchema.optional(),
    content: z.string().min(1).optional(),
    summary: z.string().nullable().optional(),
    importance: z.number().min(0).max(1).optional(),
    emotionValence: z.number().min(-1).max(1).optional(),
    emotionArousal: z.number().min(0).max(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string()).optional(),
    observedAt: OptionalDateStringSchema,
    eventTime: OptionalDateStringSchema,
    validFrom: OptionalDateStringSchema,
    validUntil: OptionalDateStringSchema,
    expiresAt: OptionalDateStringSchema,
    supersededAt: OptionalDateStringSchema,
    supersedes: z.array(z.string().min(1)).optional(),
    supersededBy: z.string().min(1).nullable().optional(),
    contradicts: z.array(z.string().min(1)).optional()
  })
  .strict();

const RecentMemoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const SearchMemoryQuerySchema = z.object({
  q: z.string().default(""),
  type: MemoryTypeSchema.optional(),
  scope: MemoryScopeSchema.optional(),
  scopeId: z.string().min(1).optional(),
  includeArchived: z.coerce.boolean().optional(),
  includeHistory: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const MemoryParamsSchema = z.object({
  id: z.string().min(1)
});

const BulkDeleteMemoryRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100)
});

const RecentCandidatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const CandidateParamsSchema = z.object({
  id: z.string().min(1)
});

const AcceptCandidateRequestSchema = z
  .object({
    type: MemoryTypeSchema.optional(),
    subtype: MemorySubtypeSchema.nullable().optional(),
    scope: MemoryScopeSchema.optional(),
    scopeId: z.string().min(1).nullable().optional(),
    memoryLayer: MemoryLayerSchema.optional(),
    content: z.string().min(1).optional(),
    summary: z.string().nullable().optional(),
    importance: z.number().min(0).max(1).optional(),
    tags: z.array(z.string()).optional(),
    observedAt: OptionalDateStringSchema,
    eventTime: OptionalDateStringSchema,
    validFrom: OptionalDateStringSchema,
    validUntil: OptionalDateStringSchema,
    expiresAt: OptionalDateStringSchema,
    possibleSupersedes: z.array(z.string().min(1)).optional(),
    possibleContradictions: z.array(z.string().min(1)).optional()
  })
  .strict();

const RejectCandidateRequestSchema = z
  .object({
    reason: z.string().min(1).max(200).optional()
  })
  .strict();

const unsafeMetadataKeyPattern = /api[-_]?key|authorization|bearer|token|password|secret/i;

export async function registerMemoryRoutes(
  app: FastifyInstance,
  context: AppContext,
  config?: ServerConfig
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
    if (input.data.scope !== undefined) {
      createInput.scope = input.data.scope as MemoryScope;
    }
    if (input.data.scopeId !== undefined) {
      createInput.scopeId = input.data.scopeId;
    }
    if (input.data.memoryLayer !== undefined) {
      createInput.memoryLayer = input.data.memoryLayer as MemoryLayer;
    }
    if (input.data.status !== undefined) {
      createInput.status = input.data.status as MemoryStatus;
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
    assignTemporalFields(createInput, input.data);
    assignSupersessionFields(createInput, input.data);

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

    const searchQuery: {
      text: string;
      types?: MemoryType[];
      limit: number;
      scope?: MemoryScope;
      scopeId?: string;
      includeArchived?: boolean;
      includeHistory?: boolean;
    } = {
      text: query.data.q,
      limit: query.data.limit
    };

    if (query.data.type) {
      searchQuery.types = [query.data.type as MemoryType];
    }
    if (query.data.scope) {
      searchQuery.scope = query.data.scope as MemoryScope;
    }
    if (query.data.scopeId) {
      searchQuery.scopeId = query.data.scopeId;
    }
    if (query.data.includeArchived !== undefined) {
      searchQuery.includeArchived = query.data.includeArchived;
    }
    if (query.data.includeHistory !== undefined) {
      searchQuery.includeHistory = query.data.includeHistory;
    }

    const result = await context.memory.retrieveRelevantMemoriesWithMetadata(searchQuery);

    return reply.send({
      mock: false,
      query: result.query,
      repository: process.env["MEMORY_REPOSITORY"] ?? "in-memory",
      rawCount: result.rawCount,
      count: result.count,
      retrievalMode: result.retrievalMode,
      debugMemories: result.memories.map(toSafeRetrievedMemory),
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

  app.get("/memory/candidates/recent", async (request, reply) => {
    if (config?.runtimeMode && config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Memory candidate review is only available in development mode."
      });
    }
    const query = RecentCandidatesQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "invalid_request", details: query.error.flatten() });
    }

    const candidates = context.runtime.getRecentMemoryCandidates(query.data.limit);
    return reply.send({
      mock: false,
      volatile: true,
      message: "Memory candidate history is development-only and resets when the server restarts.",
      ...summarizeCandidates(candidates),
      candidates
    });
  });

  app.post("/memory/candidates/:id/accept", async (request, reply) => {
    if (config?.runtimeMode && config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Memory candidate review is only available in development mode."
      });
    }
    const params = CandidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }
    const input = AcceptCandidateRequestSchema.safeParse(request.body ?? {});
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const result = await context.runtime.acceptMemoryCandidate(params.data.id, {
      ...(input.data.type ? { type: input.data.type as MemoryType } : {}),
      ...(input.data.subtype !== undefined
        ? { subtype: input.data.subtype as MemorySubtype | null }
        : {}),
      ...(input.data.scope ? { scope: input.data.scope as MemoryScope } : {}),
      ...(input.data.scopeId !== undefined ? { scopeId: input.data.scopeId } : {}),
      ...(input.data.memoryLayer ? { memoryLayer: input.data.memoryLayer as MemoryLayer } : {}),
      ...(input.data.content !== undefined ? { content: input.data.content } : {}),
      ...(input.data.summary !== undefined ? { summary: input.data.summary } : {}),
      ...(input.data.importance !== undefined ? { importance: input.data.importance } : {}),
      ...(input.data.tags !== undefined ? { tags: input.data.tags } : {}),
      ...(input.data.observedAt !== undefined ? { observedAt: input.data.observedAt } : {}),
      ...(input.data.eventTime !== undefined ? { eventTime: input.data.eventTime } : {}),
      ...(input.data.validFrom !== undefined ? { validFrom: input.data.validFrom } : {}),
      ...(input.data.validUntil !== undefined ? { validUntil: input.data.validUntil } : {}),
      ...(input.data.expiresAt !== undefined ? { expiresAt: input.data.expiresAt } : {}),
      ...(input.data.possibleSupersedes !== undefined
        ? { possibleSupersedes: input.data.possibleSupersedes }
        : {}),
      ...(input.data.possibleContradictions !== undefined
        ? { possibleContradictions: input.data.possibleContradictions }
        : {})
    });

    if (!result) {
      return reply.status(404).send({ error: "not_found", message: "Memory candidate not found." });
    }
    if (result.alreadyStored) {
      const existing = await context.memoryRepository.getMemoryById(result.memoryId);
      return reply.send({
        ok: true,
        alreadyStored: true,
        message: result.message,
        memoryId: result.memoryId,
        memory: existing ? toSafeMemory(existing) : null
      });
    }

    return reply.send({
      ok: true,
      alreadyStored: false,
      message: result.message,
      memory: toSafeMemory(result.memory)
    });
  });

  app.post("/memory/candidates/:id/reject", async (request, reply) => {
    if (config?.runtimeMode && config.runtimeMode !== "development") {
      return reply.status(404).send({
        error: "not_found",
        message: "Memory candidate review is only available in development mode."
      });
    }
    const params = CandidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
    }
    const input = RejectCandidateRequestSchema.safeParse(request.body ?? {});
    if (!input.success) {
      return reply.status(400).send({ error: "invalid_request", details: input.error.flatten() });
    }

    const candidate = context.runtime.rejectMemoryCandidate(params.data.id, input.data.reason);
    if (!candidate) {
      return reply.status(404).send({ error: "not_found", message: "Memory candidate not found." });
    }

    return reply.send({ ok: true, candidate });
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
    if (input.data.scope !== undefined) {
      updateInput.scope = input.data.scope as MemoryScope;
    }
    if (input.data.scopeId !== undefined) {
      updateInput.scopeId = input.data.scopeId;
    }
    if (input.data.memoryLayer !== undefined) {
      updateInput.memoryLayer = input.data.memoryLayer as MemoryLayer;
    }
    if (input.data.status !== undefined) {
      updateInput.status = input.data.status as MemoryStatus;
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
    assignTemporalFields(updateInput, input.data);
    assignSupersessionFields(updateInput, input.data);

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

  app.post("/memory/:id/archive", async (request, reply) => {
    return updateMemoryStatus(request.params, reply, context, "archived");
  });

  app.post("/memory/:id/restore", async (request, reply) => {
    return updateMemoryStatus(request.params, reply, context, "active");
  });

  app.post("/memory/:id/forget", async (request, reply) => {
    return updateMemoryStatus(request.params, reply, context, "forgotten");
  });
}

async function updateMemoryStatus(
  rawParams: unknown,
  reply: FastifyReply,
  context: AppContext,
  status: MemoryStatus
): Promise<unknown> {
  const params = MemoryParamsSchema.safeParse(rawParams);
  if (!params.success) {
    return reply.status(400).send({ error: "invalid_request", details: params.error.flatten() });
  }

  const updated = await context.memoryRepository.updateMemory(params.data.id, { status });
  if (!updated) {
    return reply.status(404).send({ error: "not_found", message: "Memory not found." });
  }

  return reply.send({ ok: true, id: params.data.id, memory: toSafeMemory(updated) });
}

function assignTemporalFields(
  target: CreateMemoryInput | UpdateMemoryInput,
  input: {
    observedAt?: string | null | undefined;
    eventTime?: string | null | undefined;
    validFrom?: string | null | undefined;
    validUntil?: string | null | undefined;
    expiresAt?: string | null | undefined;
    supersededAt?: string | null | undefined;
  }
): void {
  if (input.observedAt !== undefined) target.observedAt = input.observedAt;
  if (input.eventTime !== undefined) target.eventTime = input.eventTime;
  if (input.validFrom !== undefined) target.validFrom = input.validFrom;
  if (input.validUntil !== undefined) target.validUntil = input.validUntil;
  if (input.expiresAt !== undefined) target.expiresAt = input.expiresAt;
  if (input.supersededAt !== undefined) target.supersededAt = input.supersededAt;
}

function assignSupersessionFields(
  target: CreateMemoryInput | UpdateMemoryInput,
  input: {
    supersedes?: string[] | undefined;
    supersededBy?: string | null | undefined;
    contradicts?: string[] | undefined;
  }
): void {
  if (input.supersedes !== undefined) target.supersedes = input.supersedes;
  if (input.supersededBy !== undefined) target.supersededBy = input.supersededBy;
  if (input.contradicts !== undefined) target.contradicts = input.contradicts;
}

function toSafeMemory(memory: Memory): Memory {
  return {
    ...memory,
    metadata: redactUnsafeMetadata(memory.metadata)
  };
}

function toSafeRetrievedMemory(memory: RetrievedMemoryDebug): RetrievedMemoryDebug {
  const metadata = memory.metadata ? redactUnsafeMetadata(memory.metadata) : undefined;
  return {
    ...memory,
    ...(metadata ? { metadata } : {})
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

function summarizeCandidates(candidates: Array<{ decision: string; fallbackUsed?: boolean }>): {
  count: number;
  storedCount: number;
  rejectedCount: number;
  candidateCount: number;
  fallbackUsed: boolean;
} {
  return {
    count: candidates.length,
    storedCount: candidates.filter((candidate) => candidate.decision === "stored").length,
    rejectedCount: candidates.filter((candidate) => candidate.decision === "rejected").length,
    candidateCount: candidates.filter((candidate) => candidate.decision === "candidate").length,
    fallbackUsed: candidates.some((candidate) => Boolean(candidate.fallbackUsed))
  };
}
