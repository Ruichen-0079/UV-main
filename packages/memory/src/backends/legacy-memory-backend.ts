/**
 * LegacyMemoryBackend adapts the existing MemoryRepository to the MemoryBackend contract.
 * It does not change repository semantics; chat paths continue using MemoryService + repository.
 */

import type { MemoryRepository } from "../repository.js";
import type {
  AddMemoryInput,
  DeleteMemoryInput,
  GetMemoryInput,
  ListMemoryInput,
  ListMemoryResult,
  MemoryBackend,
  MemoryBackendHealth,
  MemoryHistoryEntry,
  MemoryHistoryInput,
  MemoryRecord,
  MemorySearchResult,
  MemoryWriteResult,
  SearchMemoryInput,
  UpdateMemoryInput
} from "../backend.js";
import { MemoryBackendError } from "../backend.js";
import { parseMemoryScope } from "../scope.js";
import type { Memory } from "../types.js";

export class LegacyMemoryBackend implements MemoryBackend {
  readonly kind = "legacy" as const;

  constructor(private readonly repository: MemoryRepository) {}

  async health(): Promise<MemoryBackendHealth> {
    const result = await this.repository.healthCheck();
    const health: MemoryBackendHealth = {
      status: result.status === "healthy" ? "healthy" : "unhealthy",
      backend: "legacy",
      components: {
        repository: result.status,
        kind: this.repository.kind
      }
    };
    if (result.message) {
      health.message = result.message;
    }
    return health;
  }

  async add(input: AddMemoryInput): Promise<MemoryWriteResult> {
    const parts = safeParseScope(input.scope);
    const content =
      input.content?.trim() ||
      (input.messages ?? [])
        .map((message) => message.content.trim())
        .filter(Boolean)
        .join("\n");
    if (!content) {
      throw new MemoryBackendError(
        "VALIDATION_ERROR",
        "AddMemoryInput requires content or messages."
      );
    }
    const memory = await this.repository.createMemory({
      type: "semantic",
      subtype: "fact",
      scope: "user",
      scopeId: input.scope,
      content,
      source: "mem0-bridge-legacy",
      subjectUserId: parts.userId,
      personaId: parts.characterId,
      metadata: {
        ...(input.metadata ?? {}),
        userId: parts.userId,
        characterId: parts.characterId,
        schemaVersion: 1,
        mem0Scope: input.scope,
        explicit: input.metadata?.explicit ?? input.infer === false
      }
    });
    return {
      memoryId: memory.id,
      operation: "created",
      record: toRecord(memory, input.scope)
    };
  }

  async search(input: SearchMemoryInput): Promise<MemorySearchResult[]> {
    const limit = Math.max(1, Math.min(50, input.limit ?? 8));
    const rows = await this.repository.searchMemoriesByTextFallback({
      text: input.query,
      limit,
      statuses: ["active"]
    });
    return rows
      .filter((row) => row.scopeId === input.scope || row.metadata?.["mem0Scope"] === input.scope)
      .map((row) => ({
        ...toRecord(row, input.scope),
        score: row.searchScore ?? row.importance ?? 0
      }));
  }

  async get(input: GetMemoryInput): Promise<MemoryRecord | null> {
    const memory = await this.repository.getMemoryById(input.memoryId);
    if (!memory) return null;
    return toRecord(memory, input.scope ?? String(memory.scopeId ?? ""));
  }

  async list(input: ListMemoryInput): Promise<ListMemoryResult> {
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    const rows = await this.repository.listRecentMemories(limit + (input.offset ?? 0));
    const filtered = rows
      .filter((row) => row.scopeId === input.scope || row.metadata?.["mem0Scope"] === input.scope)
      .slice(input.offset ?? 0, (input.offset ?? 0) + limit)
      .map((row) => toRecord(row, input.scope));
    return { items: filtered, total: filtered.length };
  }

  async update(input: UpdateMemoryInput): Promise<MemoryRecord> {
    const patch: { content: string; metadata?: Record<string, unknown> } = {
      content: input.content
    };
    if (input.metadata) {
      patch.metadata = input.metadata as Record<string, unknown>;
    }
    const memory = await this.repository.updateMemory(input.memoryId, patch);
    if (!memory) {
      throw new MemoryBackendError("MEMORY_NOT_FOUND", `Memory ${input.memoryId} was not found.`);
    }
    return toRecord(memory, input.scope ?? String(memory.scopeId ?? ""));
  }

  async delete(input: DeleteMemoryInput): Promise<void> {
    const ok = await this.repository.deleteMemory(input.memoryId);
    if (!ok) {
      throw new MemoryBackendError("MEMORY_NOT_FOUND", `Memory ${input.memoryId} was not found.`);
    }
  }

  async history(_input: MemoryHistoryInput): Promise<MemoryHistoryEntry[]> {
    return [];
  }
}

function safeParseScope(scope: string): { userId: string; characterId: string } {
  try {
    return parseMemoryScope(scope);
  } catch {
    return { userId: "default-user", characterId: "default-character" };
  }
}

function toRecord(memory: Memory, scope: string): MemoryRecord {
  return {
    id: memory.id,
    content: memory.content,
    scope: scope || String(memory.scopeId ?? ""),
    metadata: {
      ...(memory.metadata as Record<string, unknown>),
      memoryType: memory.type,
      schemaVersion: 1
    },
    score: memory.searchScore ?? null,
    createdAt: memory.createdAt?.toISOString?.() ?? null,
    updatedAt: memory.updatedAt?.toISOString?.() ?? null
  };
}
