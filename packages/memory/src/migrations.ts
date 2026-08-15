import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { normalizePostgresConnectionString } from "./postgres-connection.js";

export const MIGRATION_LOCK_KEY1 = 872164201;
export const MIGRATION_LOCK_DEADLINE_MS = 30_000;
export const HISTORY_TABLE = "yuvi_schema_migrations";
export const HISTORY_SCHEMA = "public";

/** Zero-padded prefixes such as 001_*.sql are the current tree. */
export const MIGRATION_FILENAME_RE = /^([0-9]+)_(.+)\.sql$/;

export const INERT_EXTENSIONS = new Set(["plpgsql"]);
export const YUVI_EXTENSIONS = ["vector", "pgcrypto", "pg_trgm"] as const;
export const YUVI_RELATION_NAMES = [
  "memories",
  "entities",
  "relations",
  "conversation_sessions",
  "conversation_messages",
  "finalized_ingestion_turns",
  "finalized_ingestion_events",
  "conversation_messages_sequence_seq"
] as const;

const SYSTEM_SCHEMA_RE = /^(pg_catalog|information_schema|pg_toast|pg_temp_.*|pg_toast_temp_.*)$/;

const TRACK_BY_VERSION = new Map<number, MigrationTrack>([
  [1, "memory_search"],
  [2, "memory_search"],
  [3, "memory_search"],
  [4, "memory_search"],
  [5, "memory_search"],
  [6, "core"],
  [7, "core"],
  [8, "core"],
  [9, "core"]
]);

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  memories: [
    "id",
    "type",
    "subtype",
    "scope",
    "scope_id",
    "memory_layer",
    "status",
    "content",
    "summary",
    "embedding",
    "importance",
    "emotion_valence",
    "emotion_arousal",
    "source",
    "source_trace_id",
    "persona_id",
    "subject_user_id",
    "created_by_user_id",
    "speaker_id",
    "voice_profile_id",
    "session_id",
    "metadata",
    "tags",
    "created_at",
    "updated_at",
    "observed_at",
    "event_time",
    "valid_from",
    "valid_until",
    "expires_at",
    "last_accessed_at",
    "superseded_at",
    "supersedes",
    "superseded_by",
    "contradicts",
    "embedding_model",
    "embedding_provider",
    "embedding_dimensions",
    "embedded_at"
  ],
  entities: ["id", "name", "type", "created_at"],
  relations: ["id", "source_entity", "target_entity", "relation", "weight", "created_at"],
  conversation_sessions: ["id", "created_at", "updated_at"],
  conversation_messages: [
    "id",
    "session_id",
    "trace_id",
    "parent_message_id",
    "role",
    "content",
    "status",
    "created_at",
    "completed_at",
    "metadata",
    "sequence",
    "source_user_event_id",
    "finalized_turn_id",
    "persona_id",
    "subject_user_id",
    "ingestion_requested",
    "ingestion_skip_reason"
  ],
  finalized_ingestion_turns: [
    "finalized_turn_id",
    "assistant_message_id",
    "source_user_event_id",
    "conversation_id",
    "trace_id",
    "persona_id",
    "subject_user_id",
    "memory_scope",
    "finalized_at",
    "ingestion_requested",
    "ingestion_skip_reason",
    "failure_stage",
    "status",
    "policy_version",
    "source_digest",
    "eligible_event_count",
    "pending_event_count",
    "processing_event_count",
    "complete_event_count",
    "unchanged_event_count",
    "failed_event_count",
    "ambiguous_event_count",
    "skipped_event_count",
    "attempt_count",
    "last_attempt_at",
    "next_attempt_at",
    "completed_at",
    "last_error_code",
    "last_error_message",
    "lease_owner",
    "lease_expires_at",
    "version",
    "created_at",
    "updated_at"
  ],
  finalized_ingestion_events: [
    "event_id",
    "finalized_turn_id",
    "event_key",
    "backend_idempotency_key",
    "event_payload",
    "status",
    "result_kind",
    "attempt_count",
    "last_attempt_at",
    "dispatch_started_at",
    "next_attempt_at",
    "backend_memory_id",
    "backend_operation",
    "error_code",
    "error_message",
    "lease_owner",
    "lease_expires_at",
    "version",
    "created_at",
    "updated_at"
  ]
};

export type MigrationTrack = "core" | "memory_search";
export type CoreTrackStatus = "ready" | "failed";
export type MemorySearchStatus = "ready" | "unavailable" | "failed";

export type CoreTrackDiagnostics = {
  status: CoreTrackStatus;
  applied: string[];
  pending: string[];
};

export type MemorySearchDiagnostics = {
  status: MemorySearchStatus;
  applied: string[];
  pending: string[];
  failedMigration: string | null;
  errorCode: MigrationErrorCode | null;
};

export type MigrationErrorCode =
  | "DATABASE_UNAVAILABLE"
  | "MIGRATION_LOCK_TIMEOUT"
  | "FOREIGN_DATABASE"
  | "PARTIAL_YUVI_SCHEMA"
  | "INVALID_MIGRATION_HISTORY"
  | "UNKNOWN_MIGRATION"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "MIGRATION_FAILED"
  | "SCHEMA_POSTCONDITION_FAILED"
  | "DATABASE_CLASSIFICATION_FAILED"
  | "INVALID_MIGRATION_REGISTRY";

export type DatabaseClass =
  | "A"
  | "A2"
  | "A3"
  | "B"
  | "C"
  | "D"
  | "E"
  | "INVALID_HISTORY"
  | "UNCLASSIFIABLE";

export type SqlMigration = {
  name: string;
  sql: string;
};

export type RegisteredMigration = {
  name: string;
  version: number;
  slug: string;
  track: MigrationTrack;
  sql: string;
  checksum: string;
};

export type MigrationDiagnostics = {
  schemaReady: boolean;
  memorySearchReady: boolean;
  vectorAvailable: boolean;
  classification: DatabaseClass | null;
  applied: string[];
  pending: string[];
  currentMigration: string | null;
  lastErrorCode: MigrationErrorCode | null;
  lockWaitMs: number;
  core: CoreTrackDiagnostics;
  memorySearch: MemorySearchDiagnostics;
};

export type MigrationResult = {
  appliedNow: string[];
  recorded: string[];
  diagnostics: MigrationDiagnostics;
};

export type DatabaseInventory = {
  schemas: string[];
  relations: Array<{ schema: string; name: string; kind: string }>;
  extensions: string[];
  types: Array<{ schema: string; name: string; typetype: string }>;
  routines: Array<{ schema: string; name: string; kind: string }>;
  eventTriggers: string[];
  publications: string[];
  subscriptions: string[];
  historyPresent: boolean;
};

export type HistoryInspection =
  | { present: false }
  | { present: true; valid: false; reason: string }
  | {
      present: true;
      valid: true;
      rows: Array<{ name: string; checksum: string; appliedAt: string }>;
    };

export type SqlQueryFn = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: Array<Record<string, unknown>> }>;

export class MissingDatabaseUrlError extends Error {
  constructor() {
    super("DATABASE_URL is required to run PostgreSQL memory migrations.");
    this.name = "MissingDatabaseUrlError";
  }
}

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
  }
}

export function parseMigrationFilename(name: string): { version: number; slug: string } {
  const match = MIGRATION_FILENAME_RE.exec(name);
  if (!match) {
    throw new MigrationError(
      "INVALID_MIGRATION_REGISTRY",
      "A SQL migration filename is malformed."
    );
  }
  const version = Number.parseInt(match[1] ?? "", 10);
  const slug = match[2] ?? "";
  if (!Number.isInteger(version) || version < 0 || slug.length === 0) {
    throw new MigrationError(
      "INVALID_MIGRATION_REGISTRY",
      "A SQL migration filename is malformed."
    );
  }
  return { version, slug };
}

export function trackForVersion(version: number): MigrationTrack {
  const track = TRACK_BY_VERSION.get(version);
  if (!track) {
    throw new MigrationError(
      "INVALID_MIGRATION_REGISTRY",
      "A SQL migration version has no explicit track mapping."
    );
  }
  return track;
}

export function normalizeMigrationText(sql: string): string {
  return sql.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function checksumMigrationSql(sql: string): string {
  return createHash("sha256").update(normalizeMigrationText(sql), "utf8").digest("hex");
}

export function defaultMigrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../migrations");
}

export async function loadMigrationRegistry(
  migrationsDir = defaultMigrationsDir()
): Promise<RegisteredMigration[]> {
  const entries = await readdir(migrationsDir);
  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql"));
  const loaded = await Promise.all(
    sqlFiles.map(async (name) => {
      const parsed = parseMigrationFilename(name);
      const sql = await readFile(join(migrationsDir, name), "utf8");
      return {
        name,
        version: parsed.version,
        slug: parsed.slug,
        track: trackForVersion(parsed.version),
        sql,
        checksum: checksumMigrationSql(sql)
      } satisfies RegisteredMigration;
    })
  );
  return finalizeRegistry(loaded);
}

export function registryFromSqlMigrations(migrations: SqlMigration[]): RegisteredMigration[] {
  return finalizeRegistry(
    migrations.map((migration) => {
      const parsed = parseMigrationFilename(migration.name);
      return {
        name: migration.name,
        version: parsed.version,
        slug: parsed.slug,
        track: trackForVersion(parsed.version),
        sql: migration.sql,
        checksum: checksumMigrationSql(migration.sql)
      };
    })
  );
}

function finalizeRegistry(loaded: RegisteredMigration[]): RegisteredMigration[] {
  const seenVersions = new Set<number>();
  const seenNames = new Set<string>();
  for (const migration of loaded) {
    if (seenVersions.has(migration.version)) {
      throw new MigrationError("INVALID_MIGRATION_REGISTRY", "Duplicate migration numeric prefix.");
    }
    if (seenNames.has(migration.name)) {
      throw new MigrationError("INVALID_MIGRATION_REGISTRY", "Duplicate migration filename.");
    }
    seenVersions.add(migration.version);
    seenNames.add(migration.name);
  }
  return [...loaded].sort((left, right) => {
    if (left.version !== right.version) return left.version - right.version;
    return left.name.localeCompare(right.name);
  });
}

export async function readSqlMigrations(
  migrationsDir = defaultMigrationsDir()
): Promise<SqlMigration[]> {
  const registry = await loadMigrationRegistry(migrationsDir);
  return registry.map((migration) => ({ name: migration.name, sql: migration.sql }));
}

export function selectPendingForTrack(
  registry: RegisteredMigration[],
  recordedNames: Iterable<string>,
  track: MigrationTrack
): RegisteredMigration[] {
  const recorded = new Set(recordedNames);
  return registry.filter((migration) => migration.track === track && !recorded.has(migration.name));
}

/** Core-first, then optional memory_search. Numeric order is preserved within each track. */
export function selectPendingMigrations(
  registry: RegisteredMigration[],
  recordedNames: Iterable<string>,
  capabilities: { vectorAvailable: boolean }
): RegisteredMigration[] {
  const core = selectPendingForTrack(registry, recordedNames, "core");
  if (!capabilities.vectorAvailable) return core;
  return [...core, ...selectPendingForTrack(registry, recordedNames, "memory_search")];
}

export function emptyCoreDiagnostics(): CoreTrackDiagnostics {
  return { status: "failed", applied: [], pending: [] };
}

export function emptyMemorySearchDiagnostics(): MemorySearchDiagnostics {
  return {
    status: "unavailable",
    applied: [],
    pending: [],
    failedMigration: null,
    errorCode: null
  };
}

export function emptyDiagnostics(): MigrationDiagnostics {
  return {
    schemaReady: false,
    memorySearchReady: false,
    vectorAvailable: false,
    classification: null,
    applied: [],
    pending: [],
    currentMigration: null,
    lastErrorCode: null,
    lockWaitMs: 0,
    core: emptyCoreDiagnostics(),
    memorySearch: emptyMemorySearchDiagnostics()
  };
}

export function classifyFromInventory(
  inventory: DatabaseInventory,
  history: HistoryInspection,
  options: { legacyComplete?: boolean } = {}
): DatabaseClass {
  if (history.present && !history.valid) return "INVALID_HISTORY";
  const remainder = remainderInventory(inventory);
  const legacyComplete = options.legacyComplete === true;
  if (history.present && history.valid) {
    if (history.rows.length > 0) return "A";
    if (isTrulyEmpty(remainder)) return "A2";
    if (legacyComplete && isYuviOnlyRemainder(remainder)) return "A3";
    if (hasNonYuviUserObject(remainder)) return "E";
    if (hasYuviRelation(remainder)) return "D";
    return "E";
  }
  if (isTrulyEmpty(inventory)) return "B";
  if (legacyComplete && isYuviOnlyRemainder(inventory)) return "C";
  if (hasNonYuviUserObject(inventory)) return "E";
  if (hasYuviRelation(inventory)) return "D";
  return "E";
}

export function refusalCode(classification: DatabaseClass): MigrationErrorCode | null {
  switch (classification) {
    case "D":
      return "PARTIAL_YUVI_SCHEMA";
    case "E":
      return "FOREIGN_DATABASE";
    case "INVALID_HISTORY":
      return "INVALID_MIGRATION_HISTORY";
    case "UNCLASSIFIABLE":
      return "DATABASE_CLASSIFICATION_FAILED";
    default:
      return null;
  }
}

export function isTrulyEmpty(inventory: DatabaseInventory): boolean {
  if (!inventory.schemas.includes("public")) return false;
  if (inventory.schemas.some((schema) => schema !== "public")) return false;
  if (inventory.relations.length > 0) return false;
  if (inventory.extensions.some((name) => !INERT_EXTENSIONS.has(name))) return false;
  if (inventory.types.length > 0) return false;
  if (inventory.routines.length > 0) return false;
  if (inventory.eventTriggers.length > 0) return false;
  if (inventory.publications.length > 0) return false;
  if (inventory.subscriptions.length > 0) return false;
  return true;
}

function remainderInventory(inventory: DatabaseInventory): DatabaseInventory {
  return {
    ...inventory,
    relations: inventory.relations.filter(
      (relation) => !(relation.schema === HISTORY_SCHEMA && relation.name === HISTORY_TABLE)
    ),
    historyPresent: false
  };
}

function yuviRelationNameSet(): Set<string> {
  return new Set<string>(YUVI_RELATION_NAMES);
}

function hasYuviRelation(inventory: DatabaseInventory): boolean {
  const names = yuviRelationNameSet();
  return inventory.relations.some(
    (relation) => relation.schema === "public" && names.has(relation.name)
  );
}

function isYuviOnlyRemainder(inventory: DatabaseInventory): boolean {
  if (inventory.schemas.some((schema) => schema !== "public")) return false;
  const allowedRelations = yuviRelationNameSet();
  if (
    inventory.relations.some(
      (relation) => relation.schema !== "public" || !allowedRelations.has(relation.name)
    )
  ) {
    return false;
  }
  const allowedExtensions = new Set<string>(["plpgsql", ...YUVI_EXTENSIONS]);
  if (inventory.extensions.some((name) => !allowedExtensions.has(name))) return false;
  if (inventory.types.length > 0) return false;
  if (inventory.routines.length > 0) return false;
  if (inventory.eventTriggers.length > 0) return false;
  if (inventory.publications.length > 0) return false;
  if (inventory.subscriptions.length > 0) return false;
  return true;
}

function hasNonYuviUserObject(inventory: DatabaseInventory): boolean {
  if (inventory.schemas.some((schema) => schema !== "public")) return true;
  const allowedRelations = yuviRelationNameSet();
  if (
    inventory.relations.some(
      (relation) => relation.schema !== "public" || !allowedRelations.has(relation.name)
    )
  ) {
    return true;
  }
  const allowedExtensions = new Set<string>(["plpgsql", ...YUVI_EXTENSIONS]);
  if (inventory.extensions.some((name) => !allowedExtensions.has(name))) return true;
  if (inventory.types.length > 0) return true;
  if (inventory.routines.length > 0) return true;
  if (inventory.eventTriggers.length > 0) return true;
  if (inventory.publications.length > 0) return true;
  if (inventory.subscriptions.length > 0) return true;
  return false;
}

export function isCompleteLegacy(
  inventory: DatabaseInventory,
  extras?: {
    columns?: Record<string, string[]>;
    embeddingType?: string | null;
    statusConstraint?: string | null;
    indexes?: string[];
  }
): boolean {
  for (const ext of YUVI_EXTENSIONS) {
    if (!inventory.extensions.includes(ext)) return false;
  }
  const relationNames = new Set(
    inventory.relations
      .filter((relation) => relation.schema === "public")
      .map((relation) => relation.name)
  );
  for (const name of YUVI_RELATION_NAMES) {
    if (!relationNames.has(name)) return false;
  }
  if (!extras) return false;
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const have = new Set(extras.columns?.[table] ?? []);
    if (required.some((column) => !have.has(column))) return false;
  }
  if (extras.embeddingType !== "vector") return false;
  const constraint = extras.statusConstraint ?? "";
  if (!constraint.includes("streaming") || !constraint.includes("cancelled")) return false;
  const indexes = new Set(extras.indexes ?? []);
  if (!indexes.has("conversation_messages_finalized_turn_id_uidx")) return false;
  if (!indexes.has("finalized_ingestion_events_due_work_idx")) return false;
  return true;
}

export function normalizeInventory(inventory: DatabaseInventory): DatabaseInventory {
  const byName = (left: string, right: string) => left.localeCompare(right);
  return {
    schemas: [...inventory.schemas].sort(byName),
    relations: [...inventory.relations].sort(
      (left, right) =>
        left.schema.localeCompare(right.schema) ||
        left.name.localeCompare(right.name) ||
        left.kind.localeCompare(right.kind)
    ),
    extensions: [...inventory.extensions].sort(byName),
    types: [...inventory.types].sort(
      (left, right) =>
        left.schema.localeCompare(right.schema) || left.name.localeCompare(right.name)
    ),
    routines: [...inventory.routines].sort(
      (left, right) =>
        left.schema.localeCompare(right.schema) || left.name.localeCompare(right.name)
    ),
    eventTriggers: [...inventory.eventTriggers].sort(byName),
    publications: [...inventory.publications].sort(byName),
    subscriptions: [...inventory.subscriptions].sort(byName),
    historyPresent: inventory.historyPresent
  };
}

export async function collectDatabaseInventory(query: SqlQueryFn): Promise<DatabaseInventory> {
  const schemas = await query(
    `SELECT nspname AS name
     FROM pg_catalog.pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema')
       AND nspname NOT LIKE 'pg_toast%'
       AND nspname NOT LIKE 'pg_temp_%'
       AND nspname NOT LIKE 'pg_toast_temp_%'
     ORDER BY nspname`
  );
  const relations = await query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp_%'
       AND n.nspname NOT LIKE 'pg_toast_temp_%'
       AND c.relkind = ANY($1)
       AND c.relpersistence <> 't'
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_extension e ON d.refobjid = e.oid
         WHERE d.classid = 'pg_catalog.pg_class'::regclass
           AND d.objid = c.oid
           AND d.deptype = 'e'
       )
     ORDER BY n.nspname, c.relname`,
    [["r", "p", "v", "m", "S", "f"]]
  );
  const extensions = await query(
    `SELECT extname AS name FROM pg_catalog.pg_extension ORDER BY extname`
  );
  const types = await query(
    `SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS typetype
     FROM pg_catalog.pg_type t
     JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp_%'
       AND n.nspname NOT LIKE 'pg_toast_temp_%'
       AND t.typtype = ANY($1)
       AND t.typname NOT LIKE '\\_%'
       AND (t.typrelid = 0 OR NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_class c
         WHERE c.oid = t.typrelid AND c.relkind = ANY($2)
       ))
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_extension e ON d.refobjid = e.oid
         WHERE d.classid = 'pg_catalog.pg_type'::regclass
           AND d.objid = t.oid
           AND d.deptype = 'e'
       )
     ORDER BY n.nspname, t.typname`,
    [
      ["c", "e", "d"],
      ["r", "p", "v", "m"]
    ]
  );
  const routines = await query(
    `SELECT n.nspname AS schema, p.proname AS name, p.prokind::text AS kind
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%'
       AND n.nspname NOT LIKE 'pg_temp_%'
       AND n.nspname NOT LIKE 'pg_toast_temp_%'
       AND p.prokind = ANY($1)
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_extension e ON d.refobjid = e.oid
         WHERE d.classid = 'pg_catalog.pg_proc'::regclass
           AND d.objid = p.oid
           AND d.deptype = 'e'
       )
     ORDER BY n.nspname, p.proname`,
    [["f", "p", "a"]]
  );
  const eventTriggers = await query(
    `SELECT evtname AS name FROM pg_catalog.pg_event_trigger ORDER BY evtname`
  );
  const publications = await query(
    `SELECT pubname AS name FROM pg_catalog.pg_publication ORDER BY pubname`
  );
  const subscriptions = await query(
    `SELECT subname AS name FROM pg_catalog.pg_subscription ORDER BY subname`
  );
  return normalizeInventory({
    schemas: schemas.rows.map((row) => String(row["name"])),
    relations: relations.rows.map((row) => ({
      schema: String(row["schema"]),
      name: String(row["name"]),
      kind: String(row["kind"])
    })),
    extensions: extensions.rows.map((row) => String(row["name"])),
    types: types.rows.map((row) => ({
      schema: String(row["schema"]),
      name: String(row["name"]),
      typetype: String(row["typetype"])
    })),
    routines: routines.rows.map((row) => ({
      schema: String(row["schema"]),
      name: String(row["name"]),
      kind: String(row["kind"])
    })),
    eventTriggers: eventTriggers.rows.map((row) => String(row["name"])),
    publications: publications.rows.map((row) => String(row["name"])),
    subscriptions: subscriptions.rows.map((row) => String(row["name"])),
    historyPresent: relations.rows.some(
      (row) => String(row["schema"]) === HISTORY_SCHEMA && String(row["name"]) === HISTORY_TABLE
    )
  });
}

export async function inspectHistory(query: SqlQueryFn): Promise<HistoryInspection> {
  const exists = await query(
    `SELECT 1 AS present
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
    [HISTORY_SCHEMA, HISTORY_TABLE]
  );
  if (exists.rows.length === 0) return { present: false };

  const columns = await query(
    `SELECT a.attname AS name, t.typname AS typname, a.attnotnull AS notnull
     FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
     WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [HISTORY_SCHEMA, HISTORY_TABLE]
  );
  const expected = new Map<string, { typname: string; notnull: boolean }>([
    ["name", { typname: "text", notnull: true }],
    ["checksum", { typname: "text", notnull: true }],
    ["applied_at", { typname: "timestamptz", notnull: true }]
  ]);
  if (columns.rows.length !== expected.size) {
    return { present: true, valid: false, reason: "unexpected history columns" };
  }
  for (const row of columns.rows) {
    const name = String(row["name"]);
    const spec = expected.get(name);
    if (!spec) return { present: true, valid: false, reason: "unexpected history columns" };
    if (String(row["typname"]) !== spec.typname || row["notnull"] !== true) {
      return { present: true, valid: false, reason: "invalid history column types" };
    }
  }

  const pk = await query(
    `SELECT a.attname AS name
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
     WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
     ORDER BY a.attnum`,
    [HISTORY_SCHEMA, HISTORY_TABLE]
  );
  if (pk.rows.length !== 1 || String(pk.rows[0]?.["name"]) !== "name") {
    return { present: true, valid: false, reason: "history primary key must be name" };
  }

  const rows = await query(
    `SELECT name, checksum, applied_at
     FROM ${HISTORY_SCHEMA}.${HISTORY_TABLE}
     ORDER BY name`
  );
  return {
    present: true,
    valid: true,
    rows: rows.rows.map((row) => ({
      name: String(row["name"]),
      checksum: String(row["checksum"]),
      appliedAt: String(row["applied_at"])
    }))
  };
}

export async function inspectLegacyProof(query: SqlQueryFn): Promise<{
  columns: Record<string, string[]>;
  embeddingType: string | null;
  statusConstraint: string | null;
  indexes: string[];
}> {
  const columns: Record<string, string[]> = {};
  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    const result = await query(
      `SELECT a.attname AS name
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attname`,
      [table]
    );
    columns[table] = result.rows.map((row) => String(row["name"]));
  }
  const embedding = await query(
    `SELECT t.typname AS typname
     FROM pg_catalog.pg_attribute a
     JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
     WHERE n.nspname = 'public' AND c.relname = 'memories' AND a.attname = 'embedding'`
  );
  const constraint = await query(
    `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS def
     FROM pg_catalog.pg_constraint c
     JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public'
       AND rel.relname = 'conversation_messages'
       AND c.conname = 'conversation_messages_status_check'`
  );
  const indexes = await query(
    `SELECT c.relname AS name
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'i'
       AND c.relname = ANY($1)`,
    [["conversation_messages_finalized_turn_id_uidx", "finalized_ingestion_events_due_work_idx"]]
  );
  return {
    columns,
    embeddingType: embedding.rows[0] ? String(embedding.rows[0]["typname"]) : null,
    statusConstraint: constraint.rows[0] ? String(constraint.rows[0]["def"]) : null,
    indexes: indexes.rows.map((row) => String(row["name"]))
  };
}

export async function detectVectorAvailable(query: SqlQueryFn): Promise<boolean> {
  const installed = await query(
    `SELECT 1 AS present FROM pg_catalog.pg_extension WHERE extname = 'vector'`
  );
  if (installed.rows.length > 0) return true;
  const available = await query(
    `SELECT 1 AS present FROM pg_catalog.pg_available_extensions WHERE name = 'vector'`
  );
  return available.rows.length > 0;
}

export async function acquireMigrationLock(
  query: SqlQueryFn,
  options: {
    deadlineMs?: number | undefined;
    now?: (() => number) | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
  } = {}
): Promise<{ key2: number; waitMs: number }> {
  const deadlineMs = options.deadlineMs ?? MIGRATION_LOCK_DEADLINE_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const started = now();
  const key = await query(`SELECT pg_catalog.hashtext(pg_catalog.current_database()) AS key2`);
  const key2 = Number(key.rows[0]?.["key2"]);
  if (!Number.isInteger(key2)) {
    throw new MigrationError("MIGRATION_LOCK_TIMEOUT", "Migration lock key could not be derived.");
  }
  while (now() - started <= deadlineMs) {
    const locked = await query(`SELECT pg_catalog.pg_try_advisory_lock($1, $2) AS locked`, [
      MIGRATION_LOCK_KEY1,
      key2
    ]);
    if (locked.rows[0]?.["locked"] === true) {
      return { key2, waitMs: Math.max(0, now() - started) };
    }
    if (now() - started >= deadlineMs) break;
    await sleep(50);
  }
  throw new MigrationError(
    "MIGRATION_LOCK_TIMEOUT",
    "Timed out waiting for the PostgreSQL session advisory lock."
  );
}

export async function releaseMigrationLock(query: SqlQueryFn, key2: number): Promise<void> {
  await query(`SELECT pg_catalog.pg_advisory_unlock($1, $2)`, [MIGRATION_LOCK_KEY1, key2]);
}

export async function migrateYuviSchema(input: {
  databaseUrl: string;
  migrations?: SqlMigration[] | undefined;
  migrationsDir?: string | undefined;
  logger?: Pick<Console, "log"> | undefined;
  settings?: Record<string, string | undefined> | undefined;
  lockDeadlineMs?: number | undefined;
}): Promise<MigrationResult> {
  const diagnostics = emptyDiagnostics();
  const registry = input.migrations
    ? registryFromSqlMigrations(input.migrations)
    : await loadMigrationRegistry(input.migrationsDir);
  const client = new Client({
    connectionString: normalizePostgresConnectionString(input.databaseUrl),
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000
  });
  client.on("error", () => {
    // Unexpected disconnects (terminated backend) are converted to MigrationError.
  });
  let key2: number | null = null;
  try {
    try {
      await client.connect();
      await client.query("SELECT 1 AS ok");
    } catch (error) {
      throw wrapUnavailable(error);
    }
    const query = bindQuery(client);
    const lock = await acquireMigrationLock(query, { deadlineMs: input.lockDeadlineMs });
    key2 = lock.key2;
    diagnostics.lockWaitMs = lock.waitMs;

    let inventory: DatabaseInventory;
    let history: HistoryInspection;
    let classification: DatabaseClass;
    try {
      inventory = await collectDatabaseInventory(query);
      history = await inspectHistory(query);
      const needsLegacyProof =
        history.present === false ||
        (history.present && history.valid && history.rows.length === 0);
      const extras = needsLegacyProof
        ? await inspectLegacyProof(query).catch(() => undefined)
        : undefined;
      const legacyComplete = extras ? isCompleteLegacy(inventory, extras) : false;
      classification = classifyFromInventory(inventory, history, { legacyComplete });
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      throw new MigrationError(
        "DATABASE_CLASSIFICATION_FAILED",
        "The database could not be classified with read-only catalog queries."
      );
    }
    diagnostics.classification = classification;
    const blocked = refusalCode(classification);
    if (blocked) {
      diagnostics.lastErrorCode = blocked;
      throw new MigrationError(blocked, refusalMessage(blocked));
    }

    if (classification === "B" || classification === "C") {
      await ensureHistoryTable(client);
    }
    if (classification === "C" || classification === "A3") {
      await insertLegacyHistory(client, registry);
    }

    const recorded = await readRecordedHistory(query);
    verifyRecordedChecksums(registry, recorded);
    const vectorAvailable = await detectVectorAvailable(query);
    diagnostics.vectorAvailable = vectorAvailable;

    await applySessionSettings(client, input.settings);
    const appliedNow: string[] = [];
    if (classification === "C" || classification === "A3") {
      appliedNow.push(...registry.map((migration) => migration.name));
    }

    const corePending = selectPendingForTrack(registry, recorded.keys(), "core");
    for (const migration of corePending) {
      diagnostics.currentMigration = migration.name;
      await applyMigrationFile(client, migration);
      input.logger?.log(`Applied migration: ${migration.name}`);
      appliedNow.push(migration.name);
    }

    const recordedAfterCore = await readRecordedHistory(query);
    const remainingCore = selectPendingForTrack(registry, recordedAfterCore.keys(), "core");
    const hasRealCore =
      registry.some((migration) => migration.name === "006_conversation_v1.sql") &&
      registry.some(
        (migration) => migration.name === "009_finalized_ingestion_work_discovery_v1.sql"
      );
    if (hasRealCore) {
      const post = await verifyCorePostconditions(query);
      if (!post.schemaReady) {
        diagnostics.core = {
          status: "failed",
          applied: trackNames(registry, recordedAfterCore, "core"),
          pending: remainingCore.map((migration) => migration.name)
        };
        throw new MigrationError(
          "SCHEMA_POSTCONDITION_FAILED",
          "Core conversation schema postconditions were not met."
        );
      }
    } else if (remainingCore.length > 0) {
      diagnostics.core = {
        status: "failed",
        applied: trackNames(registry, recordedAfterCore, "core"),
        pending: remainingCore.map((migration) => migration.name)
      };
      throw new MigrationError(
        "SCHEMA_POSTCONDITION_FAILED",
        "Core conversation schema postconditions were not met."
      );
    }
    diagnostics.schemaReady = true;
    diagnostics.core = {
      status: "ready",
      applied: trackNames(registry, recordedAfterCore, "core"),
      pending: []
    };

    const memoryPending = vectorAvailable
      ? selectPendingForTrack(registry, recordedAfterCore.keys(), "memory_search")
      : [];
    if (!vectorAvailable) {
      diagnostics.memorySearch = {
        status: "unavailable",
        applied: trackNames(registry, recordedAfterCore, "memory_search"),
        pending: [],
        failedMigration: null,
        errorCode: null
      };
    } else {
      try {
        for (const migration of memoryPending) {
          diagnostics.currentMigration = migration.name;
          await applyMigrationFile(client, migration);
          input.logger?.log(`Applied migration: ${migration.name}`);
          appliedNow.push(migration.name);
        }
      } catch (error) {
        const wrapped = error instanceof MigrationError ? error : wrapFailed(error);
        const recordedAfterFailure = await readRecordedHistory(query).catch(
          () => recordedAfterCore
        );
        diagnostics.memorySearch = {
          status: "failed",
          applied: trackNames(registry, recordedAfterFailure, "memory_search"),
          pending: selectPendingForTrack(
            registry,
            recordedAfterFailure.keys(),
            "memory_search"
          ).map((migration) => migration.name),
          failedMigration: diagnostics.currentMigration,
          errorCode: wrapped.code
        };
        diagnostics.lastErrorCode = wrapped.code;
      }
    }

    const recordedAfter = await readRecordedHistory(query);
    if (diagnostics.memorySearch.status !== "failed") {
      const remainingMemory = vectorAvailable
        ? selectPendingForTrack(registry, recordedAfter.keys(), "memory_search")
        : [];
      diagnostics.memorySearch = vectorAvailable
        ? {
            status: remainingMemory.length === 0 ? "ready" : "failed",
            applied: trackNames(registry, recordedAfter, "memory_search"),
            pending: remainingMemory.map((migration) => migration.name),
            failedMigration: remainingMemory[0]?.name ?? null,
            errorCode: remainingMemory.length === 0 ? null : "MIGRATION_FAILED"
          }
        : diagnostics.memorySearch;
    }
    diagnostics.applied = [...recordedAfter.keys()].sort();
    diagnostics.pending = selectPendingMigrations(registry, recordedAfter.keys(), {
      vectorAvailable
    }).map((migration) => migration.name);
    diagnostics.memorySearchReady = diagnostics.memorySearch.status === "ready";
    diagnostics.currentMigration = null;
    if (diagnostics.memorySearch.status !== "failed") {
      diagnostics.lastErrorCode = null;
    }
    return {
      appliedNow,
      recorded: diagnostics.applied,
      diagnostics
    };
  } catch (error) {
    const wrapped = error instanceof MigrationError ? error : wrapFailed(error);
    diagnostics.lastErrorCode = wrapped.code;
    throw wrapped;
  } finally {
    try {
      if (key2 !== null) await releaseMigrationLock(bindQuery(client), key2);
    } catch {
      // Session close still drops the advisory lock.
    }
    await client.end().catch(() => undefined);
  }
}

export async function runPostgresMigrations(input: {
  databaseUrl: string;
  migrations?: SqlMigration[] | undefined;
  migrationsDir?: string | undefined;
  logger?: Pick<Console, "log"> | undefined;
  settings?: Record<string, string | undefined> | undefined;
}): Promise<string[]> {
  const result = await migrateYuviSchema(input);
  return result.appliedNow;
}

export function resolveDatabaseUrl(
  env: Record<string, string | undefined>,
  envFileText?: string | undefined
): string {
  const fileEnv = envFileText ? parseDotEnv(envFileText) : {};
  const databaseUrl = env["DATABASE_URL"] ?? fileEnv["DATABASE_URL"];
  if (!databaseUrl?.trim()) {
    throw new MissingDatabaseUrlError();
  }
  return databaseUrl;
}

export function parseDotEnv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = stripOptionalQuotes(line.slice(separatorIndex + 1).trim());
    parsed[key] = value;
  }
  return parsed;
}

function stripOptionalQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function bindQuery(client: Client): SqlQueryFn {
  return async (sql, params) => {
    const result = params ? await client.query(sql, params) : await client.query(sql);
    return { rows: result.rows as Array<Record<string, unknown>> };
  };
}

async function ensureHistoryTable(client: Client): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${HISTORY_SCHEMA}.${HISTORY_TABLE} (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL
      )`
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw wrapFailed(error);
  }
}

async function insertLegacyHistory(client: Client, registry: RegisteredMigration[]): Promise<void> {
  await client.query("BEGIN");
  try {
    const values: string[] = [];
    const params: unknown[] = [];
    registry.forEach((migration, index) => {
      const base = index * 2;
      values.push(`($${base + 1}, $${base + 2}, clock_timestamp())`);
      params.push(migration.name, migration.checksum);
    });
    await client.query(
      `INSERT INTO ${HISTORY_SCHEMA}.${HISTORY_TABLE} (name, checksum, applied_at)
       VALUES ${values.join(", ")}`,
      params
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw wrapFailed(error);
  }
}

async function applyMigrationFile(client: Client, migration: RegisteredMigration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO ${HISTORY_SCHEMA}.${HISTORY_TABLE} (name, checksum, applied_at)
       VALUES ($1, $2, clock_timestamp())`,
      [migration.name, migration.checksum]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new MigrationError("MIGRATION_FAILED", "A migration file failed and was rolled back.");
  }
}

async function applySessionSettings(
  client: Client,
  settings: Record<string, string | undefined> | undefined
): Promise<void> {
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (value !== undefined) {
      await client.query("SELECT pg_catalog.set_config($1, $2, false)", [key, value]);
    }
  }
}

async function readRecordedHistory(query: SqlQueryFn): Promise<Map<string, { checksum: string }>> {
  const history = await inspectHistory(query);
  if (!history.present) return new Map();
  if (!history.valid) {
    throw new MigrationError("INVALID_MIGRATION_HISTORY", "Migration history is invalid.");
  }
  return new Map(history.rows.map((row) => [row.name, { checksum: row.checksum }]));
}

function verifyRecordedChecksums(
  registry: RegisteredMigration[],
  recorded: Map<string, { checksum: string }>
): void {
  const byName = new Map(registry.map((migration) => [migration.name, migration]));
  for (const [name, row] of recorded) {
    const migration = byName.get(name);
    if (!migration) {
      throw new MigrationError(
        "UNKNOWN_MIGRATION",
        "History contains an unknown migration filename."
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationError(
        "MIGRATION_CHECKSUM_MISMATCH",
        "A recorded migration checksum does not match the current file."
      );
    }
  }
}

async function verifyCorePostconditions(query: SqlQueryFn): Promise<{ schemaReady: boolean }> {
  const tables = await query(
    `SELECT c.relname AS name
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname = ANY($1)`,
    [
      [
        "conversation_sessions",
        "conversation_messages",
        "finalized_ingestion_turns",
        "finalized_ingestion_events"
      ]
    ]
  );
  if (tables.rows.length !== 4) return { schemaReady: false };
  const constraint = await query(
    `SELECT pg_catalog.pg_get_constraintdef(c.oid) AS def
     FROM pg_catalog.pg_constraint c
     JOIN pg_catalog.pg_class rel ON rel.oid = c.conrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public'
       AND rel.relname = 'conversation_messages'
       AND c.conname = 'conversation_messages_status_check'`
  );
  const def = String(constraint.rows[0]?.["def"] ?? "");
  if (!def.includes("streaming") || !def.includes("cancelled")) return { schemaReady: false };
  const indexes = await query(
    `SELECT c.relname AS name
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname = ANY($1)`,
    [["conversation_messages_finalized_turn_id_uidx", "finalized_ingestion_events_due_work_idx"]]
  );
  return { schemaReady: indexes.rows.length === 2 };
}

function trackNames(
  registry: RegisteredMigration[],
  recorded: Map<string, { checksum: string }>,
  track: MigrationTrack
): string[] {
  return registry
    .filter((migration) => migration.track === track && recorded.has(migration.name))
    .map((migration) => migration.name);
}

function refusalMessage(code: MigrationErrorCode): string {
  switch (code) {
    case "FOREIGN_DATABASE":
      return "The target database is not an empty or Yuvi-owned schema.";
    case "PARTIAL_YUVI_SCHEMA":
      return "The target database has a partial Yuvi schema and was left unmodified.";
    case "INVALID_MIGRATION_HISTORY":
      return "The migration history table is present but invalid.";
    case "DATABASE_CLASSIFICATION_FAILED":
      return "The target database could not be classified.";
    default:
      return "Migration refused.";
  }
}

function wrapUnavailable(error: unknown): MigrationError {
  void sanitizeError(error);
  return new MigrationError("DATABASE_UNAVAILABLE", "The PostgreSQL target is not reachable.");
}

function wrapFailed(error: unknown): MigrationError {
  if (error instanceof MigrationError) return error;
  void sanitizeError(error);
  return new MigrationError("MIGRATION_FAILED", "The migration operation failed.");
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/postgres(?:ql)?:\/\/\S+/giu, "postgres://[REDACTED]")
    .replace(/(DATABASE_URL|PGPASSWORD|YUVI_POSTGRES_PASSWORD)=([^\s]+)/giu, "$1=[REDACTED]");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isSystemSchema(name: string): boolean {
  return SYSTEM_SCHEMA_RE.test(name);
}
