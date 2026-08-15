import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MigrationError,
  acquireMigrationLock,
  checksumMigrationSql,
  classifyFromInventory,
  emptyDiagnostics,
  loadMigrationRegistry,
  parseMigrationFilename,
  registryFromSqlMigrations,
  selectPendingMigrations,
  trackForVersion,
  type DatabaseInventory,
  type HistoryInspection
} from "./migrations.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeRegistry(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-mig-"));
  tempDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql, "utf8");
  }
  return dir;
}

function emptyInventory(overrides: Partial<DatabaseInventory> = {}): DatabaseInventory {
  return {
    schemas: ["public"],
    relations: [],
    extensions: ["plpgsql"],
    types: [],
    routines: [],
    eventTriggers: [],
    publications: [],
    subscriptions: [],
    historyPresent: false,
    ...overrides
  };
}

function noHistory(): HistoryInspection {
  return { present: false };
}

describe("migration registry", () => {
  it("parses numeric prefixes and sorts by integer value", async () => {
    const dir = writeRegistry({
      "009_finalized_ingestion_work_discovery_v1.sql": "select 9;",
      "006_conversation_v1.sql": "select 6;",
      "001_init_memory.sql": "select 1;"
    });
    const registry = await loadMigrationRegistry(dir);
    expect(registry.map((item) => item.version)).toEqual([1, 6, 9]);
    expect(registry.map((item) => item.name)).toEqual([
      "001_init_memory.sql",
      "006_conversation_v1.sql",
      "009_finalized_ingestion_work_discovery_v1.sql"
    ]);
    expect(trackForVersion(1)).toBe("memory_search");
    expect(trackForVersion(6)).toBe("core");
    expect(parseMigrationFilename("008_finalized_ingestion_ledger_v1.sql")).toEqual({
      version: 8,
      slug: "finalized_ingestion_ledger_v1"
    });
  });

  it("fails closed on duplicate numeric prefixes", async () => {
    const dir = writeRegistry({
      "006_conversation_v1.sql": "select 6;",
      "6_other.sql": "select other;"
    });
    await expect(loadMigrationRegistry(dir)).rejects.toMatchObject({
      code: "INVALID_MIGRATION_REGISTRY"
    });
  });

  it("fails closed on malformed SQL migration filenames", async () => {
    const dir = writeRegistry({
      "init.sql": "select 1;"
    });
    await expect(loadMigrationRegistry(dir)).rejects.toBeInstanceOf(MigrationError);
    expect(() => parseMigrationFilename("001.sql")).toThrow(MigrationError);
    expect(() => parseMigrationFilename("foo_bar.sql")).toThrow(MigrationError);
  });

  it("allows gaps in numeric prefixes", async () => {
    const dir = writeRegistry({
      "006_conversation_v1.sql": "select 6;",
      "009_finalized_ingestion_work_discovery_v1.sql": "select 9;"
    });
    const registry = await loadMigrationRegistry(dir);
    expect(registry.map((item) => item.version)).toEqual([6, 9]);
  });
});

describe("checksum", () => {
  it("SHA256s UTF-8 content after CRLF to LF normalization", () => {
    const lf = checksumMigrationSql("select 1;\nselect 2;\n");
    const crlf = checksumMigrationSql("select 1;\r\nselect 2;\r\n");
    const cr = checksumMigrationSql("select 1;\rselect 2;\r");
    const expected = createHash("sha256").update("select 1;\nselect 2;\n", "utf8").digest("hex");
    expect(lf).toBe(expected);
    expect(crlf).toBe(expected);
    expect(cr).toBe(expected);
    expect(lf).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("set-based pending calculation", () => {
  const registry = registryFromSqlMigrations(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((version) => ({
      name: `${String(version).padStart(3, "0")}_item.sql`,
      sql: `select ${version};`
    }))
  );

  it("runs 006-009 when history is empty and vector is unavailable", () => {
    const pending = selectPendingMigrations(registry, [], { vectorAvailable: false });
    expect(pending.map((item) => item.name)).toEqual([
      "006_item.sql",
      "007_item.sql",
      "008_item.sql",
      "009_item.sql"
    ]);
  });

  it("applies core before memory_search when vector is available on an empty history", () => {
    const pending = selectPendingMigrations(registry, [], { vectorAvailable: true });
    expect(pending.map((item) => item.name)).toEqual([
      "006_item.sql",
      "007_item.sql",
      "008_item.sql",
      "009_item.sql",
      "001_item.sql",
      "002_item.sql",
      "003_item.sql",
      "004_item.sql",
      "005_item.sql"
    ]);
  });

  it("treats 006-009 plus 001 as a legal set and continues from 002", () => {
    const recorded = [
      "006_item.sql",
      "007_item.sql",
      "008_item.sql",
      "009_item.sql",
      "001_item.sql"
    ];
    const pending = selectPendingMigrations(registry, recorded, { vectorAvailable: true });
    expect(pending.map((item) => item.name)).toEqual([
      "002_item.sql",
      "003_item.sql",
      "004_item.sql",
      "005_item.sql"
    ]);
  });

  it("is a no-op when 006-009 are recorded and vector is unavailable", () => {
    const recorded = ["006_item.sql", "007_item.sql", "008_item.sql", "009_item.sql"];
    const pending = selectPendingMigrations(registry, recorded, { vectorAvailable: false });
    expect(pending).toEqual([]);
  });

  it("applies exactly 001-005 when vector later becomes available", () => {
    const recorded = ["006_item.sql", "007_item.sql", "008_item.sql", "009_item.sql"];
    const pending = selectPendingMigrations(registry, recorded, { vectorAvailable: true });
    expect(pending.map((item) => item.name)).toEqual([
      "001_item.sql",
      "002_item.sql",
      "003_item.sql",
      "004_item.sql",
      "005_item.sql"
    ]);
  });

  it("does not infer applied state from max(version)", () => {
    const recorded = ["006_item.sql", "007_item.sql", "008_item.sql", "009_item.sql"];
    const maxVersion = Math.max(...recorded.map((name) => parseMigrationFilename(name).version));
    expect(maxVersion).toBe(9);
    const pending = selectPendingMigrations(registry, recorded, { vectorAvailable: true });
    expect(pending.some((item) => item.version < maxVersion)).toBe(true);
    expect(pending.map((item) => item.version)).toEqual([1, 2, 3, 4, 5]);
    expect(pending.some((item) => item.version === 6)).toBe(false);
  });
});

describe("classification", () => {
  it("classifies empty, history, partial, foreign, and legacy states", () => {
    expect(classifyFromInventory(emptyInventory(), noHistory())).toBe("B");
    expect(
      classifyFromInventory(emptyInventory({ historyPresent: true }), {
        present: true,
        valid: true,
        rows: []
      })
    ).toBe("A2");
    expect(
      classifyFromInventory(emptyInventory({ historyPresent: true }), {
        present: true,
        valid: true,
        rows: [{ name: "006_item.sql", checksum: "abc", appliedAt: "now" }]
      })
    ).toBe("A");
    expect(
      classifyFromInventory(
        emptyInventory({
          relations: [{ schema: "public", name: "conversation_messages", kind: "r" }],
          extensions: ["plpgsql"]
        }),
        noHistory()
      )
    ).toBe("D");
    expect(
      classifyFromInventory(
        emptyInventory({
          relations: [{ schema: "public", name: "app_users", kind: "r" }]
        }),
        noHistory()
      )
    ).toBe("E");
    expect(
      classifyFromInventory(
        emptyInventory({
          relations: YUVI_RELATIONS.map((name) => ({ schema: "public", name, kind: "r" })),
          extensions: ["plpgsql", "vector", "pgcrypto", "pg_trgm"]
        }),
        noHistory(),
        { legacyComplete: true }
      )
    ).toBe("C");
    expect(
      classifyFromInventory(
        emptyInventory({
          historyPresent: true,
          relations: [
            { schema: "public", name: "yuvi_schema_migrations", kind: "r" },
            ...YUVI_RELATIONS.map((name) => ({ schema: "public", name, kind: "r" }))
          ],
          extensions: ["plpgsql", "vector", "pgcrypto", "pg_trgm"]
        }),
        { present: true, valid: true, rows: [] },
        { legacyComplete: true }
      )
    ).toBe("A3");
    expect(
      classifyFromInventory(emptyInventory(), {
        present: true,
        valid: false,
        reason: "extra column"
      })
    ).toBe("INVALID_HISTORY");
  });
});

const YUVI_RELATIONS = [
  "memories",
  "entities",
  "relations",
  "conversation_sessions",
  "conversation_messages",
  "finalized_ingestion_turns",
  "finalized_ingestion_events",
  "conversation_messages_sequence_seq"
];

describe("lock timeout", () => {
  it("fails closed after the bounded try_advisory_lock deadline", async () => {
    let now = 0;
    await expect(
      acquireMigrationLock(
        async (sql) => {
          if (sql.includes("hashtext")) return { rows: [{ key2: 42 }] };
          return { rows: [{ locked: false }] };
        },
        {
          deadlineMs: 30,
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          }
        }
      )
    ).rejects.toMatchObject({ code: "MIGRATION_LOCK_TIMEOUT" });
  });
});

describe("diagnostics redaction", () => {
  it("does not carry connection strings in the diagnostic object", () => {
    const diagnostics = emptyDiagnostics();
    expect(JSON.stringify(diagnostics)).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(JSON.stringify(diagnostics)).not.toContain("PGPASSWORD");
    expect(JSON.stringify(diagnostics)).not.toContain("DATABASE_URL");
  });
});
