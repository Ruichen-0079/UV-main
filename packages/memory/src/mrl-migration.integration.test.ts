import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { readSqlMigrations } from "./migrations.js";
import { normalizePostgresConnectionString } from "./postgres-connection.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const QWEN_MODEL = "Qwen3-Embedding-0.6B-Q8_0.gguf";
const QWEN_PROVIDER = "local";
const TARGET_DIMENSIONS = 512;

describe("P8-0C MRL migration PostgreSQL integration", () => {
  it.skipIf(!DATABASE_URL)(
    "converts a real Qwen 1024-D row to 512-D, preserves fields, and reruns without rebuilding",
    async () => {
      const pool = createPool();
      const client = await pool.connect();
      try {
        await createPre010Fixture(client, {
          embeddingProvider: QWEN_PROVIDER,
          embeddingModel: QWEN_MODEL
        });
        const migration = await readMigration();
        const expected = normalizedQwenVector();
        const preMigrationIndexOid = await readIndexOid(client);

        await configureMigration(client);
        await client.query(migration.sql);

        const first = await readFixture(client);
        expect(first.count).toBe(1);
        expect(first.row).toMatchObject({
          id: first.id,
          content: "P8-0C migration integration memory",
          metadata: { source: "p8-0c-integration" },
          embedding_provider: QWEN_PROVIDER,
          embedding_model: QWEN_MODEL,
          embedding_dimensions: 512,
          status: "active"
        });
        expect(first.row.created_at).toBe("2026-08-28 00:00:00+00");
        expect(first.row.updated_at).toBe("2026-08-28 00:00:01+00");
        expect(first.row.vector_dims).toBe(512);
        expect(first.row.column_type).toBe("vector(512)");
        expect(maxVectorError(parseVector(first.row.embedding), expected)).toBeLessThan(1e-6);
        expect(Math.hypot(...parseVector(first.row.embedding))).toBeCloseTo(1, 6);

        await client.query("set enable_seqscan = off");
        await client.query("analyze memories");
        const plan = await client.query(
          "explain (costs off) select id from memories where embedding is not null and vector_dims(embedding) = 512 order by embedding <=> $1::vector limit 1",
          [vectorLiteral(expected)]
        );
        expect(plan.rows.map((row) => String(row["QUERY PLAN"])).join("\n")).toContain(
          "memories_embedding_hnsw_idx"
        );

        const indexBeforeRerun = await readIndexOid(client);
        await configureMigration(client);
        await client.query(migration.sql);
        const second = await readFixture(client);
        expect(second.count).toBe(1);
        expect(second.id).toBe(first.id);
        expect(second.row.embedding).toBe(first.row.embedding);
        expect(await readIndexOid(client)).toBe(indexBeforeRerun);
      } finally {
        await dropFixtureSchema(client);
        client.release();
        await pool.end();
      }
    }
  );

  it.skipIf(!DATABASE_URL)(
    "rejects non-Qwen 1024-D provenance and rolls back row, schema, and index state",
    async () => {
      const pool = createPool();
      const client = await pool.connect();
      try {
        await createPre010Fixture(client, {
          embeddingProvider: "openai-compatible",
          embeddingModel: "text-embedding-other"
        });
        const migration = await readMigration();
        await configureMigration(client);
        const before = await readFixture(client);
        const indexBefore = await readIndexDefinition(client);

        await expect(client.query(migration.sql)).rejects.toThrow(
          "unsupported Qwen production provenance"
        );
        await client.query("rollback").catch(() => undefined);

        const after = await readFixture(client);
        expect(after).toEqual(before);
        expect(await readIndexDefinition(client)).toBe(indexBefore);
        expect(after.row.column_type).toBe("vector");
        expect(after.row.vector_dims).toBe(1024);
      } finally {
        await dropFixtureSchema(client);
        client.release();
        await pool.end();
      }
    }
  );
});

function createPool(): Pool {
  return new Pool({
    connectionString: normalizePostgresConnectionString(DATABASE_URL!),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000
  });
}

async function readMigration(): Promise<{ name: string; sql: string }> {
  const migration = (await readSqlMigrations()).find(
    (candidate) => candidate.name === "010_embedding_mrl_512_v1.sql"
  );
  if (!migration) {
    throw new Error("Migration 010_embedding_mrl_512_v1.sql was not found.");
  }
  return migration;
}

async function configureMigration(client: PoolClient): Promise<void> {
  for (const [key, value] of [
    ["TimeZone", "UTC"],
    ["yuvi.memory_vector_dimensions", "512"],
    ["yuvi.memory_vector_index_enabled", "true"],
    ["yuvi.memory_vector_index_type", "hnsw"],
    ["yuvi.memory_vector_distance", "cosine"]
  ] as const) {
    await client.query("select set_config($1, $2, false)", [key, value]);
  }
}

async function createPre010Fixture(
  client: PoolClient,
  provenance: { embeddingProvider: string; embeddingModel: string }
): Promise<void> {
  await client.query(`create schema ${quoteIdentifier(fixtureSchema)}`);
  await client.query(`set search_path to ${quoteIdentifier(fixtureSchema)}, public`);
  await client.query(`
    create table memories (
      id uuid primary key,
      type text not null,
      content text not null,
      metadata jsonb not null,
      status text not null,
      source text not null,
      source_trace_id text,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      embedding vector,
      embedding_model text,
      embedding_provider text,
      embedding_dimensions integer,
      embedded_at timestamptz
    )
  `);
  await client.query(`
    create index memories_embedding_hnsw_idx
      on memories
      using hnsw ((embedding::vector(1024)) vector_cosine_ops)
      where embedding is not null and vector_dims(embedding) = 1024
  `);

  await client.query(
    `insert into memories (
       id, type, content, metadata, status, source, source_trace_id,
       created_at, updated_at, embedding, embedding_model, embedding_provider,
       embedding_dimensions, embedded_at
     ) values ($1, 'semantic', $2, $3::jsonb, 'active', 'p8-0c-test', $4,
       $5::timestamptz, $6::timestamptz, $7::vector, $8, $9, 1024, $5::timestamptz)`,
    [
      fixtureId,
      "P8-0C migration integration memory",
      JSON.stringify({ source: "p8-0c-integration", preserved: true }),
      "p8-0c-migration-trace",
      "2026-08-28T00:00:00.000Z",
      "2026-08-28T00:00:01.000Z",
      vectorLiteral(nativeQwenVector()),
      provenance.embeddingModel,
      provenance.embeddingProvider
    ]
  );
}

async function dropFixtureSchema(client: PoolClient): Promise<void> {
  await client.query("rollback").catch(() => undefined);
  await client.query(`drop schema if exists ${quoteIdentifier(fixtureSchema)} cascade`);
}

async function readFixture(client: PoolClient): Promise<{
  count: number;
  id: string;
  row: {
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    embedding_provider: string;
    embedding_model: string;
    embedding_dimensions: number;
    status: string;
    created_at: string;
    updated_at: string;
    embedding: string;
    vector_dims: number;
    column_type: string;
  };
}> {
  const result = await client.query(`
    select id::text, content, metadata, embedding_provider, embedding_model,
           embedding_dimensions, status, created_at::text, updated_at::text,
           embedding::text, vector_dims(embedding) as vector_dims
    from memories
  `);
  const column = await client.query(`
    select format_type(atttypid, atttypmod) as column_type
    from pg_attribute
    where attrelid = 'memories'::regclass and attname = 'embedding' and not attisdropped
  `);
  const row = result.rows[0] as (typeof result.rows)[0] & { column_type?: string };
  return {
    count: result.rowCount ?? 0,
    id: String(row["id"]),
    row: {
      id: String(row["id"]),
      content: String(row["content"]),
      metadata: row["metadata"] as Record<string, unknown>,
      embedding_provider: String(row["embedding_provider"]),
      embedding_model: String(row["embedding_model"]),
      embedding_dimensions: Number(row["embedding_dimensions"]),
      status: String(row["status"]),
      created_at: String(row["created_at"]),
      updated_at: String(row["updated_at"]),
      embedding: String(row["embedding"]),
      vector_dims: Number(row["vector_dims"]),
      column_type: String(column.rows[0]?.["column_type"])
    }
  };
}

async function readIndexOid(client: PoolClient): Promise<string> {
  const result = await client.query(`
    select index_class.oid::text as index_oid
    from pg_class index_class
    join pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
    where index_namespace.nspname = current_schema()
      and index_class.relname = 'memories_embedding_hnsw_idx'
  `);
  return String(result.rows[0]?.["index_oid"]);
}

async function readIndexDefinition(client: PoolClient): Promise<string> {
  const result = await client.query(`
    select indexdef
    from pg_indexes
    where schemaname = current_schema()
      and tablename = 'memories'
      and indexname = 'memories_embedding_hnsw_idx'
  `);
  return String(result.rows[0]?.["indexdef"]);
}

function nativeQwenVector(): number[] {
  return Array.from({ length: 1024 }, (_, index) => (index === 0 ? 3 : index === 1 ? 4 : 1));
}

function normalizedQwenVector(): number[] {
  const prefix = nativeQwenVector().slice(0, TARGET_DIMENSIONS);
  const norm = Math.hypot(...prefix);
  return prefix.map((value) => value / norm);
}

function parseVector(value: string): number[] {
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => Number(item));
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => value.toFixed(8)).join(",")}]`;
}

function maxVectorError(actual: number[], expected: number[]): number {
  return Math.max(...actual.map((value, index) => Math.abs(value - (expected[index] ?? NaN))));
}

const fixtureId = randomUUID();
const fixtureSchema = `p8c_mrl_${randomUUID().replaceAll("-", "")}`;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
