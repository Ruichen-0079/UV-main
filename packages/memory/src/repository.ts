import { Pool, type QueryResultRow } from "pg";
import type {
  CreateEntityInput,
  CreateMemoryInput,
  CreateRelationInput,
  Entity,
  Memory,
  MemorySearchQuery,
  MemoryType,
  Relation
} from "./types.js";

export interface MemoryRepository {
  healthCheck(): Promise<{ status: "healthy" | "unavailable"; message?: string }>;
  createMemory(input: CreateMemoryInput): Promise<Memory>;
  getMemoryById(id: string): Promise<Memory | null>;
  listRecentMemories(limit?: number): Promise<Memory[]>;
  searchMemoriesByTextFallback(query: MemorySearchQuery): Promise<Memory[]>;
  searchMemoriesByEmbedding(query: MemorySearchQuery): Promise<Memory[]>;
  updateMemoryAccess(id: string): Promise<void>;
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

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const result = await this.pool.query(
      `insert into memories (
        type, subtype, content, summary, embedding, importance, emotion_valence,
        emotion_arousal, source, source_trace_id, tags
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      ) returning *`,
      [
        input.type,
        input.subtype ?? null,
        input.content,
        input.summary ?? null,
        input.embedding ? vectorLiteral(input.embedding) : null,
        input.importance ?? 0.5,
        input.emotionValence ?? 0,
        input.emotionArousal ?? 0,
        input.source,
        input.sourceTraceId ?? null,
        input.tags ?? []
      ]
    );

    return mapMemoryRow(requireOne(result.rows));
  }

  async getMemoryById(id: string): Promise<Memory | null> {
    const result = await this.pool.query("select * from memories where id = $1", [id]);
    const row = result.rows[0];
    return row ? mapMemoryRow(row) : null;
  }

  async listRecentMemories(limit = 20): Promise<Memory[]> {
    const result = await this.pool.query(
      `select * from memories
       order by created_at desc
       limit $1`,
      [limit]
    );

    return result.rows.map(mapMemoryRow);
  }

  async searchMemoriesByTextFallback(query: MemorySearchQuery): Promise<Memory[]> {
    const clauses = ["(content ilike $1 or summary ilike $1 or $1 = '%%')"];
    const values: unknown[] = [`%${escapeLike(query.text ?? "")}%`];

    if (query.types?.length) {
      values.push(query.types);
      clauses.push(`type = any($${values.length}::text[])`);
    }

    if (query.tags?.length) {
      values.push(query.tags);
      clauses.push(`tags && $${values.length}::text[]`);
    }

    values.push(query.limit ?? 10);

    const result = await this.pool.query(
      `select * from memories
       where ${clauses.join(" and ")}
       order by importance desc, last_accessed_at desc, created_at desc
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

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    const now = new Date();
    const memory: Memory = {
      id: crypto.randomUUID(),
      type: input.type,
      subtype: input.subtype ?? null,
      content: input.content,
      summary: input.summary ?? null,
      embedding: input.embedding ?? null,
      importance: input.importance ?? 0.5,
      emotionValence: input.emotionValence ?? 0,
      emotionArousal: input.emotionArousal ?? 0,
      source: input.source,
      sourceTraceId: input.sourceTraceId ?? null,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now
    };
    this.memories.push(memory);
    return memory;
  }

  async getMemoryById(id: string): Promise<Memory | null> {
    return this.memories.find((memory) => memory.id === id) ?? null;
  }

  async listRecentMemories(limit = 20): Promise<Memory[]> {
    return [...this.memories]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, limit);
  }

  async searchMemoriesByTextFallback(query: MemorySearchQuery): Promise<Memory[]> {
    const searchText = (query.text ?? "").toLowerCase();
    return this.memories
      .filter((memory) => !query.types?.length || query.types.includes(memory.type))
      .filter(
        (memory) => !query.tags?.length || query.tags.some((tag) => memory.tags.includes(tag))
      )
      .filter(
        (memory) =>
          !searchText ||
          memory.content.toLowerCase().includes(searchText) ||
          memory.summary?.toLowerCase().includes(searchText)
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
    content: row["content"],
    summary: row["summary"],
    embedding: parseVector(row["embedding"]),
    importance: Number(row["importance"]),
    emotionValence: Number(row["emotion_valence"]),
    emotionArousal: Number(row["emotion_arousal"]),
    source: row["source"],
    sourceTraceId: row["source_trace_id"] ?? null,
    tags: row["tags"] ?? [],
    createdAt: row["created_at"],
    updatedAt: row["updated_at"],
    lastAccessedAt: row["last_accessed_at"]
  };
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
