import { Pool, type QueryResultRow } from "pg";
import type {
  CreateEntityInput,
  CreateMemoryInput,
  CreateRelationInput,
  Entity,
  Memory,
  MemoryLayer,
  MemoryScope,
  MemorySearchQuery,
  MemoryStatus,
  MemorySubtype,
  MemoryType,
  Relation,
  UpdateMemoryInput
} from "./types.js";

export interface MemoryRepository {
  healthCheck(): Promise<{ status: "healthy" | "unavailable"; message?: string }>;
  getRetrievalMode?(): "keyword" | "postgres-trigram";
  createMemory(input: CreateMemoryInput): Promise<Memory>;
  getMemoryById(id: string): Promise<Memory | null>;
  updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory | null>;
  deleteMemory(id: string): Promise<boolean>;
  listRecentMemories(limit?: number): Promise<Memory[]>;
  searchMemoriesByTextFallback(query: MemorySearchQuery): Promise<Memory[]>;
  searchMemoriesByEmbedding(query: MemorySearchQuery): Promise<Memory[]>;
  updateMemoryAccess(id: string): Promise<void>;
  close?(): Promise<void>;
  createEntity(input: CreateEntityInput): Promise<Entity>;
  createRelation(input: CreateRelationInput): Promise<Relation>;
}

export class PostgresMemoryRepository implements MemoryRepository {
  private readonly pool: Pool;

  constructor(connectionString: string | Pool) {
    this.pool =
      typeof connectionString === "string" ? new Pool({ connectionString }) : connectionString;
  }

  async healthCheck(): Promise<{ status: "healthy" | "unavailable"; message?: string }> {
    try {
      await this.pool.query("select 1");
      return { status: "healthy" };
    } catch (error) {
      return {
        status: "unavailable",
        message: error instanceof Error ? error.message : "PostgreSQL health check failed."
      };
    }
  }

  getRetrievalMode(): "postgres-trigram" {
    return "postgres-trigram";
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const now = new Date();
    const scope = input.scope ?? inferDefaultScope(input);
    const memoryLayer = input.memoryLayer ?? inferMemoryLayer(input.type, input.subtype ?? null);
    const observedAt = toDateOrDefault(input.observedAt, now);
    const validFrom = toDateOrDefault(input.validFrom, observedAt);
    const result = await this.pool.query(
      `insert into memories (
        type, subtype, scope, scope_id, memory_layer, status, content, summary, embedding,
        importance, emotion_valence, emotion_arousal, source, source_trace_id, metadata, tags,
        observed_at, event_time, valid_from, valid_until, expires_at, superseded_at,
        supersedes, superseded_by, contradicts
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25
      ) returning *`,
      [
        input.type,
        input.subtype ?? null,
        scope,
        input.scopeId ?? (scope === "project" ? "yuvi-runtime" : null),
        memoryLayer,
        input.status ?? "active",
        input.content,
        input.summary ?? null,
        input.embedding ? vectorLiteral(input.embedding) : null,
        input.importance ?? 0.5,
        input.emotionValence ?? 0,
        input.emotionArousal ?? 0,
        input.source,
        input.sourceTraceId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.tags ?? [],
        observedAt,
        toNullableDate(input.eventTime),
        validFrom,
        toNullableDate(input.validUntil),
        toNullableDate(input.expiresAt),
        toNullableDate(input.supersededAt),
        input.supersedes ?? [],
        input.supersededBy ?? null,
        input.contradicts ?? []
      ]
    );

    return mapMemoryRow(requireOne(result.rows));
  }

  async getMemoryById(id: string): Promise<Memory | null> {
    const result = await this.pool.query("select * from memories where id = $1", [id]);
    const row = result.rows[0];
    return row ? mapMemoryRow(row) : null;
  }

  async updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory | null> {
    const assignments: string[] = [];
    const values: unknown[] = [];

    function set(column: string, value: unknown): void {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    }

    if (input.type !== undefined) {
      set("type", input.type);
    }
    if (input.subtype !== undefined) {
      set("subtype", input.subtype);
    }
    if (input.scope !== undefined) {
      set("scope", input.scope);
    }
    if (input.scopeId !== undefined) {
      set("scope_id", input.scopeId);
    }
    if (input.memoryLayer !== undefined) {
      set("memory_layer", input.memoryLayer);
    }
    if (input.status !== undefined) {
      set("status", input.status);
    }
    if (input.content !== undefined) {
      set("content", input.content);
    }
    if (input.summary !== undefined) {
      set("summary", input.summary);
    }
    if (input.importance !== undefined) {
      set("importance", input.importance);
    }
    if (input.emotionValence !== undefined) {
      set("emotion_valence", input.emotionValence);
    }
    if (input.emotionArousal !== undefined) {
      set("emotion_arousal", input.emotionArousal);
    }
    if (input.metadata !== undefined) {
      set("metadata", JSON.stringify(input.metadata));
    }
    if (input.tags !== undefined) {
      set("tags", input.tags);
    }
    if (input.observedAt !== undefined) {
      set("observed_at", toNullableDate(input.observedAt));
    }
    if (input.eventTime !== undefined) {
      set("event_time", toNullableDate(input.eventTime));
    }
    if (input.validFrom !== undefined) {
      set("valid_from", toNullableDate(input.validFrom));
    }
    if (input.validUntil !== undefined) {
      set("valid_until", toNullableDate(input.validUntil));
    }
    if (input.expiresAt !== undefined) {
      set("expires_at", toNullableDate(input.expiresAt));
    }
    if (input.supersededAt !== undefined) {
      set("superseded_at", toNullableDate(input.supersededAt));
    }
    if (input.supersedes !== undefined) {
      set("supersedes", input.supersedes);
    }
    if (input.supersededBy !== undefined) {
      set("superseded_by", input.supersededBy);
    }
    if (input.contradicts !== undefined) {
      set("contradicts", input.contradicts);
    }

    if (assignments.length === 0) {
      return this.getMemoryById(id);
    }

    values.push(id);
    const result = await this.pool.query(
      `update memories
       set ${assignments.join(", ")}, updated_at = now()
       where id = $${values.length}
       returning *`,
      values
    );
    const row = result.rows[0];
    return row ? mapMemoryRow(row) : null;
  }

  async deleteMemory(id: string): Promise<boolean> {
    const result = await this.pool.query("delete from memories where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async listRecentMemories(limit = 20): Promise<Memory[]> {
    const result = await this.pool.query(
      `select * from memories
       where ${activeMemorySql("manual")}
       order by created_at desc
       limit $1`,
      [limit]
    );

    return result.rows.map(mapMemoryRow);
  }

  async searchMemoriesByTextFallback(query: MemorySearchQuery): Promise<Memory[]> {
    const text = query.text?.trim() ?? "";
    const likeText = `%${escapeLike(text)}%`;
    const clauses = [
      `(
        $1 = ''
        or content ilike $2 escape '\\'
        or coalesce(summary, '') ilike $2 escape '\\'
        or type ilike $2 escape '\\'
        or source ilike $2 escape '\\'
        or coalesce(source_trace_id, '') ilike $2 escape '\\'
        or coalesce(subtype, '') ilike $2 escape '\\'
        or exists (
          select 1 from unnest(tags) as tag
          where tag ilike $2 escape '\\'
        )
        or metadata::text ilike $2 escape '\\'
        or similarity(content, $1) > 0.18
        or similarity(coalesce(summary, ''), $1) > 0.18
      )`
    ];
    const values: unknown[] = [text, likeText];

    if (query.types?.length) {
      values.push(query.types);
      clauses.push(`type = any($${values.length}::text[])`);
    }

    if (query.scope) {
      values.push(query.scope);
      clauses.push(`scope = $${values.length}`);
    }

    if (query.scopeId) {
      values.push(query.scopeId);
      clauses.push(`scope_id = $${values.length}`);
    }

    clauses.push(
      activeMemorySql(
        query.includeHistory ? "history" : query.includeArchived ? "manual" : "prompt"
      )
    );

    if (query.tags?.length) {
      values.push(query.tags);
      clauses.push(`tags && $${values.length}::text[]`);
    }

    values.push(query.limit ?? 10);

    const result = await this.pool.query(
      `select *
       from (
         select memories.*,
           case
             when $1 = '' then 0
             else
               case when content ilike $2 escape '\\' then 8 else 0 end +
               case when coalesce(summary, '') ilike $2 escape '\\' then 7 else 0 end +
               case when exists (
                 select 1 from unnest(tags) as tag
                 where tag ilike $2 escape '\\'
               ) then 6 else 0 end +
               case when type ilike $2 escape '\\' then 5 else 0 end +
               case when coalesce(subtype, '') ilike $2 escape '\\' then 5 else 0 end +
               case when source ilike $2 escape '\\' then 3 else 0 end +
               case when coalesce(source_trace_id, '') ilike $2 escape '\\' then 3 else 0 end +
               case when metadata::text ilike $2 escape '\\' then 2 else 0 end +
               greatest(similarity(content, $1), similarity(coalesce(summary, ''), $1)) * 4
           end as keyword_score
         from memories
         where ${clauses.join(" and ")}
       ) ranked_memories
       order by
         keyword_score desc,
         importance desc,
         last_accessed_at desc,
         created_at desc
       limit $${values.length}`,
      values
    );

    return result.rows.map(mapMemoryRow);
  }

  async searchMemoriesByEmbedding(query: MemorySearchQuery): Promise<Memory[]> {
    if (!query.embedding?.length) {
      return this.searchMemoriesByTextFallback(query);
    }

    const result = await this.pool.query(
      `select * from memories
       where embedding is not null
         and ${activeMemorySql(query.includeHistory ? "history" : query.includeArchived ? "manual" : "prompt")}
       order by embedding <=> $1::vector
       limit $2`,
      [vectorLiteral(query.embedding), query.limit ?? 10]
    );

    return result.rows.map(mapMemoryRow);
  }

  async updateMemoryAccess(id: string): Promise<void> {
    await this.pool.query(
      `update memories
       set last_accessed_at = now(), updated_at = now()
       where id = $1`,
      [id]
    );
  }

  async createEntity(input: CreateEntityInput): Promise<Entity> {
    const result = await this.pool.query(
      `insert into entities (name, type)
       values ($1, $2)
       returning *`,
      [input.name, input.type]
    );

    return mapEntityRow(requireOne(result.rows));
  }

  async createRelation(input: CreateRelationInput): Promise<Relation> {
    const result = await this.pool.query(
      `insert into relations (source_entity, target_entity, relation, weight)
       values ($1, $2, $3, $4)
       returning *`,
      [input.sourceEntity, input.targetEntity, input.relation, input.weight ?? 1]
    );

    return mapRelationRow(requireOne(result.rows));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export class InMemoryMemoryRepository implements MemoryRepository {
  private readonly memories: Memory[] = [];
  private readonly entities: Entity[] = [];
  private readonly relations: Relation[] = [];

  async healthCheck(): Promise<{ status: "healthy" | "unavailable"; message?: string }> {
    return { status: "healthy", message: "Using in-memory memory repository." };
  }

  getRetrievalMode(): "keyword" {
    return "keyword";
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const now = new Date();
    const scope = input.scope ?? inferDefaultScope(input);
    const memoryLayer = input.memoryLayer ?? inferMemoryLayer(input.type, input.subtype ?? null);
    const observedAt = toDateOrDefault(input.observedAt, now);
    const memory: Memory = {
      id: crypto.randomUUID(),
      type: input.type,
      subtype: input.subtype ?? null,
      scope,
      scopeId: input.scopeId ?? (scope === "project" ? "yuvi-runtime" : null),
      memoryLayer,
      status: input.status ?? "active",
      content: input.content,
      summary: input.summary ?? null,
      embedding: input.embedding ?? null,
      importance: input.importance ?? 0.5,
      emotionValence: input.emotionValence ?? 0,
      emotionArousal: input.emotionArousal ?? 0,
      source: input.source,
      sourceTraceId: input.sourceTraceId ?? null,
      metadata: input.metadata ?? {},
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      observedAt,
      eventTime: toNullableDate(input.eventTime),
      validFrom: toDateOrDefault(input.validFrom, observedAt),
      validUntil: toNullableDate(input.validUntil),
      expiresAt: toNullableDate(input.expiresAt),
      lastAccessedAt: now,
      supersededAt: toNullableDate(input.supersededAt),
      supersedes: input.supersedes ?? [],
      supersededBy: input.supersededBy ?? null,
      contradicts: input.contradicts ?? []
    };
    this.memories.push(memory);
    return memory;
  }

  async getMemoryById(id: string): Promise<Memory | null> {
    return this.memories.find((memory) => memory.id === id) ?? null;
  }

  async updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory | null> {
    const memory = this.memories.find((candidate) => candidate.id === id);
    if (!memory) {
      return null;
    }

    if (input.type !== undefined) {
      memory.type = input.type;
    }
    if (input.subtype !== undefined) {
      memory.subtype = input.subtype as MemorySubtype | null;
    }
    if (input.scope !== undefined) {
      memory.scope = input.scope;
    }
    if (input.scopeId !== undefined) {
      memory.scopeId = input.scopeId;
    }
    if (input.memoryLayer !== undefined) {
      memory.memoryLayer = input.memoryLayer;
    }
    if (input.status !== undefined) {
      memory.status = input.status;
    }
    if (input.content !== undefined) {
      memory.content = input.content;
    }
    if (input.summary !== undefined) {
      memory.summary = input.summary;
    }
    if (input.importance !== undefined) {
      memory.importance = input.importance;
    }
    if (input.emotionValence !== undefined) {
      memory.emotionValence = input.emotionValence;
    }
    if (input.emotionArousal !== undefined) {
      memory.emotionArousal = input.emotionArousal;
    }
    if (input.metadata !== undefined) {
      memory.metadata = input.metadata;
    }
    if (input.tags !== undefined) {
      memory.tags = input.tags;
    }
    if (input.observedAt !== undefined) {
      memory.observedAt = toDateOrDefault(input.observedAt, memory.observedAt);
    }
    if (input.eventTime !== undefined) {
      memory.eventTime = toNullableDate(input.eventTime);
    }
    if (input.validFrom !== undefined) {
      memory.validFrom = toDateOrDefault(input.validFrom, memory.validFrom);
    }
    if (input.validUntil !== undefined) {
      memory.validUntil = toNullableDate(input.validUntil);
    }
    if (input.expiresAt !== undefined) {
      memory.expiresAt = toNullableDate(input.expiresAt);
    }
    if (input.supersededAt !== undefined) {
      memory.supersededAt = toNullableDate(input.supersededAt);
    }
    if (input.supersedes !== undefined) {
      memory.supersedes = input.supersedes;
    }
    if (input.supersededBy !== undefined) {
      memory.supersededBy = input.supersededBy;
    }
    if (input.contradicts !== undefined) {
      memory.contradicts = input.contradicts;
    }
    memory.updatedAt = new Date();
    return memory;
  }

  async deleteMemory(id: string): Promise<boolean> {
    const index = this.memories.findIndex((memory) => memory.id === id);
    if (index === -1) {
      return false;
    }
    this.memories.splice(index, 1);
    return true;
  }

  async listRecentMemories(limit = 20): Promise<Memory[]> {
    return [...this.memories]
      .filter((memory) => isMemoryVisible(memory, "manual"))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit);
  }

  async searchMemoriesByTextFallback(query: MemorySearchQuery): Promise<Memory[]> {
    const searchText = (query.text ?? "").toLowerCase();
    return this.memories
      .filter((memory) =>
        isMemoryVisible(
          memory,
          query.includeHistory ? "history" : query.includeArchived ? "manual" : "prompt"
        )
      )
      .filter((memory) => !query.types?.length || query.types.includes(memory.type))
      .filter((memory) => !query.scope || memory.scope === query.scope)
      .filter((memory) => !query.scopeId || memory.scopeId === query.scopeId)
      .filter(
        (memory) => !query.tags?.length || query.tags.some((tag) => memory.tags.includes(tag))
      )
      .filter(
        (memory) =>
          !searchText ||
          memory.content.toLowerCase().includes(searchText) ||
          memory.summary?.toLowerCase().includes(searchText) ||
          memory.source.toLowerCase().includes(searchText) ||
          memory.subtype?.toLowerCase().includes(searchText) ||
          memory.tags.some((tag) => tag.toLowerCase().includes(searchText)) ||
          JSON.stringify(memory.metadata).toLowerCase().includes(searchText)
      )
      .sort((left, right) => right.importance - left.importance)
      .slice(0, query.limit ?? 10);
  }

  async searchMemoriesByEmbedding(query: MemorySearchQuery): Promise<Memory[]> {
    return this.searchMemoriesByTextFallback(query);
  }

  async updateMemoryAccess(id: string): Promise<void> {
    const memory = this.memories.find((candidate) => candidate.id === id);
    if (memory) {
      memory.lastAccessedAt = new Date();
      memory.updatedAt = new Date();
    }
  }

  async createEntity(input: CreateEntityInput): Promise<Entity> {
    const entity: Entity = {
      id: crypto.randomUUID(),
      name: input.name,
      type: input.type,
      createdAt: new Date()
    };
    this.entities.push(entity);
    return entity;
  }

  async createRelation(input: CreateRelationInput): Promise<Relation> {
    const relation: Relation = {
      id: crypto.randomUUID(),
      sourceEntity: input.sourceEntity,
      targetEntity: input.targetEntity,
      relation: input.relation,
      weight: input.weight ?? 1,
      createdAt: new Date()
    };
    this.relations.push(relation);
    return relation;
  }
}

export function createMemoryRepositoryFromEnv(
  env: Record<string, string | undefined> = process.env
): MemoryRepository {
  const repositoryMode = env["MEMORY_REPOSITORY"] ?? "in-memory";
  const databaseUrl = env["DATABASE_URL"];

  if (repositoryMode === "postgres") {
    if (!databaseUrl) {
      throw new Error("MEMORY_REPOSITORY=postgres requires DATABASE_URL.");
    }

    return new PostgresMemoryRepository(databaseUrl);
  }

  return new InMemoryMemoryRepository();
}

function mapMemoryRow(row: QueryResultRow): Memory {
  return {
    id: row["id"],
    type: row["type"] as MemoryType,
    subtype: row["subtype"] ?? null,
    scope: (row["scope"] ?? "user") as MemoryScope,
    scopeId: row["scope_id"] ?? null,
    memoryLayer: (row["memory_layer"] ??
      inferMemoryLayer(row["type"] as MemoryType, row["subtype"] ?? null)) as MemoryLayer,
    status: (row["status"] ?? "active") as MemoryStatus,
    content: row["content"],
    summary: row["summary"],
    embedding: parseVector(row["embedding"]),
    importance: Number(row["importance"]),
    emotionValence: Number(row["emotion_valence"]),
    emotionArousal: Number(row["emotion_arousal"]),
    source: row["source"],
    sourceTraceId: row["source_trace_id"] ?? null,
    metadata: parseMetadata(row["metadata"]),
    tags: row["tags"] ?? [],
    createdAt: row["created_at"],
    updatedAt: row["updated_at"],
    observedAt: row["observed_at"] ?? row["created_at"],
    eventTime: row["event_time"] ?? null,
    validFrom: row["valid_from"] ?? row["observed_at"] ?? row["created_at"],
    validUntil: row["valid_until"] ?? null,
    expiresAt: row["expires_at"] ?? null,
    lastAccessedAt: row["last_accessed_at"],
    supersededAt: row["superseded_at"] ?? null,
    supersedes: row["supersedes"] ?? [],
    supersededBy: row["superseded_by"] ?? null,
    contradicts: row["contradicts"] ?? []
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function mapEntityRow(row: QueryResultRow): Entity {
  return {
    id: row["id"],
    name: row["name"],
    type: row["type"],
    createdAt: row["created_at"]
  };
}

function mapRelationRow(row: QueryResultRow): Relation {
  return {
    id: row["id"],
    sourceEntity: row["source_entity"],
    targetEntity: row["target_entity"],
    relation: row["relation"],
    weight: Number(row["weight"]),
    createdAt: row["created_at"]
  };
}

function requireOne<TRow>(rows: TRow[]): TRow {
  const row = rows[0];
  if (!row) {
    throw new Error("Expected database query to return one row.");
  }

  return row;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function parseVector(value: unknown): number[] | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(Number);
  }

  if (typeof value === "string") {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .filter(Boolean)
      .map(Number);
  }

  return null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

type VisibilityMode = "prompt" | "manual" | "history";

function activeMemorySql(mode: VisibilityMode): string {
  const activeWindow = `(expires_at is null or expires_at > now())
    and (valid_from is null or valid_from <= now())
    and (valid_until is null or valid_until > now())`;
  if (mode === "history") {
    return activeWindow;
  }
  if (mode === "manual") {
    return `status in ('active', 'archived') and ${activeWindow}`;
  }
  return `status = 'active' and ${activeWindow}`;
}

function isMemoryVisible(memory: Memory, mode: VisibilityMode): boolean {
  const now = Date.now();
  if (memory.expiresAt && memory.expiresAt.getTime() <= now) {
    return false;
  }
  if (memory.validUntil && memory.validUntil.getTime() <= now) {
    return false;
  }
  if (memory.validFrom && memory.validFrom.getTime() > now) {
    return false;
  }
  if (mode === "history") {
    return true;
  }
  if (mode === "manual") {
    return memory.status === "active" || memory.status === "archived";
  }
  return memory.status === "active";
}

function inferDefaultScope(
  input: Pick<CreateMemoryInput, "type" | "subtype" | "content" | "summary" | "tags">
): MemoryScope {
  if (input.type === "working") {
    return "session";
  }
  const haystack =
    `${input.content} ${input.summary ?? ""} ${(input.tags ?? []).join(" ")}`.toLowerCase();
  if (haystack.includes("yuvi") || haystack.includes("runtime")) {
    return "project";
  }
  return "user";
}

function inferMemoryLayer(type: MemoryType, subtype: MemorySubtype | null): MemoryLayer {
  if (type === "working") {
    return "working";
  }
  if (
    type === "semantic" ||
    subtype === "preference" ||
    subtype === "project" ||
    subtype === "provider-choice"
  ) {
    return "core";
  }
  if (type === "episodic" || subtype === "milestone" || subtype === "troubleshooting") {
    return "recall";
  }
  return "recall";
}

function toNullableDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function toDateOrDefault(value: Date | string | null | undefined, fallback: Date): Date {
  return toNullableDate(value) ?? fallback;
}
