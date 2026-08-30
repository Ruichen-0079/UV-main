import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  createDefaultP8IdentityAddress,
  createP8CorrectionRecord,
  type P8ExplicitCorrection
} from "@companion/p8";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  reconstructP8Projection,
  type P8ReferencedInterpretationCandidate
} from "@companion/p8";
import { normalizePostgresConnectionString, runPostgresMigrations } from "@companion/memory";
import { PostgresP8CorrectionStore, type P8PostgresRow } from "./p8-correction-store.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const ADDRESS = createDefaultP8IdentityAddress("subject-p8-1e");
const SCOPE = { reference: "p8-1e-integration-scope" } as const;

function memoryEvent(): MemoryEvent {
  return {
    id: "p8-1e-memory-a",
    kind: "fact",
    content: "The original persisted meaning evidence.",
    source: "p8-1e-integration",
    sourceRecordId: "opaque-source-record",
    scope: SCOPE.reference,
    recordedAt: "2026-08-30T00:00:00.000Z",
    metadata: {},
    assertion: { source: "user", verification: "verified" }
  };
}

function retrieval(): MemoryRetrievalOutcome {
  return {
    status: "ok",
    events: [memoryEvent()],
    source: "p8-1e-integration",
    limited: false
  };
}

function referencedCandidate(): P8ReferencedInterpretationCandidate {
  return {
    interpretationReference: "p8-1e-interpretation-a",
    candidate: {
      domain: "BACKGROUND",
      meaning: "The original persisted meaning evidence.",
      evidenceLinks: [
        {
          evidenceReference: "p8-1e-memory-a",
          relation: "SUPPORTS",
          support: "DIRECT"
        }
      ]
    }
  };
}

function correction(
  overrides: {
    correctionReference?: string;
    action?: "REVISE" | "RETRACT";
    replacementMeaning?: string;
    supersedesCorrectionReference?: string;
  } = {}
): P8ExplicitCorrection {
  const action = overrides.action ?? "REVISE";
  return {
    correctionReference: overrides.correctionReference ?? "p8-1e-correction-a",
    address: ADDRESS,
    scopeReference: SCOPE,
    target: {
      kind: "INTERPRETATION",
      interpretationReference: "p8-1e-interpretation-a"
    },
    action,
    ...(action === "REVISE"
      ? { replacementMeaning: overrides.replacementMeaning ?? "Persisted meaning two." }
      : {}),
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: "p8-1e-user-correction"
    },
    supersededEvidenceReferences: ["p8-1e-memory-a"],
    ...(overrides.supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference: overrides.supersedesCorrectionReference })
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function createPool(): Pool {
  return new Pool({
    connectionString: normalizePostgresConnectionString(DATABASE_URL!),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000
  });
}

describe("P8-1E PostgreSQL correction persistence", () => {
  it.skipIf(!DATABASE_URL)(
    "applies and reruns the migration, round-trips authority, isolates scope, and fails closed on malformed rows",
    async () => {
      const schema = `p8_1e_${randomUUID().replaceAll("-", "")}`;
      const migrationSql = await readFile(
        new URL("../../memory/migrations/011_p8_corrections_v1.sql", import.meta.url),
        "utf8"
      );
      const migration = { name: "011_p8_corrections_v1.sql", sql: migrationSql };
      const setupPool = createPool();
      try {
        await setupPool.query(`create schema ${quoteIdentifier(schema)}`);
        await runPostgresMigrations({
          databaseUrl: DATABASE_URL!,
          migrations: [migration],
          settings: { search_path: `${quoteIdentifier(schema)}, public` }
        });
        await expect(
          runPostgresMigrations({
            databaseUrl: DATABASE_URL!,
            migrations: [migration],
            settings: { search_path: `${quoteIdentifier(schema)}, public` }
          })
        ).resolves.toEqual([migration.name]);

        const client = await setupPool.connect();
        try {
          await client.query(`set search_path to ${quoteIdentifier(schema)}, public`);
          const store = new PostgresP8CorrectionStore({
            query: async (text, values) => {
              const result = await client.query(text, values);
              return { rows: result.rows as readonly P8PostgresRow[] };
            }
          });
          const first = correction();
          const second = correction({
            correctionReference: "p8-1e-correction-b",
            action: "RETRACT",
            supersedesCorrectionReference: first.correctionReference
          });

          await expect(store.appendCorrection(first)).resolves.toMatchObject({ status: "STORED" });
          await expect(store.appendCorrection(first)).resolves.toMatchObject({
            status: "ALREADY_STORED"
          });
          await expect(
            store.appendCorrection({ ...first, replacementMeaning: "Conflicting retry payload." })
          ).resolves.toEqual({ status: "CONFLICT" });
          const firstLoaded = await store.loadCorrections({
            address: ADDRESS,
            scopeReference: SCOPE
          });

          const processA = reconstructP8Projection({
            address: ADDRESS,
            authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
            expectedScopeReference: SCOPE,
            longTerm: retrieval(),
            referencedInterpretationCandidates: [referencedCandidate()],
            correctionStore: firstLoaded
          });
          const processBLoaded = await store.loadCorrections({
            address: ADDRESS,
            scopeReference: SCOPE
          });
          const processB = reconstructP8Projection({
            address: ADDRESS,
            authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
            expectedScopeReference: SCOPE,
            longTerm: retrieval(),
            referencedInterpretationCandidates: [referencedCandidate()],
            correctionStore: processBLoaded
          });
          expect(processA.status).toBe("RECONSTRUCTED");
          expect(processA).toEqual(processB);
          expect(processBLoaded).not.toBe(firstLoaded);
          if (processA.status !== "RECONSTRUCTED" || processB.status !== "RECONSTRUCTED") {
            throw new Error("P8 restart reconstruction did not produce a projection.");
          }
          expect(processA.projection.interpretations[0]).toMatchObject({
            meaning: "Persisted meaning two.",
            status: "KNOWN"
          });
          expect(processA.projection.targetableInterpretations?.[0]?.interpretation).not.toBe(
            processB.projection.targetableInterpretations?.[0]?.interpretation
          );

          await expect(store.appendCorrection(second)).resolves.toMatchObject({ status: "STORED" });
          const loaded = await store.loadCorrections({ address: ADDRESS, scopeReference: SCOPE });
          expect(loaded).toMatchObject({
            status: "SUCCESS_WITH_CORRECTIONS",
            corrections: [
              expect.objectContaining({ correctionReference: first.correctionReference }),
              expect.objectContaining({
                correctionReference: second.correctionReference,
                action: "RETRACT"
              })
            ]
          });
          expect(loaded).not.toHaveProperty("storedAt");

          const processAfterRetract = reconstructP8Projection({
            address: ADDRESS,
            authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
            expectedScopeReference: SCOPE,
            longTerm: retrieval(),
            referencedInterpretationCandidates: [referencedCandidate()],
            correctionStore: loaded
          });
          expect(processAfterRetract.status).toBe("RECONSTRUCTED");
          if (processAfterRetract.status !== "RECONSTRUCTED") {
            throw new Error("P8 lineage reconstruction did not produce a projection.");
          }
          expect(processAfterRetract.projection.interpretations[0]).toMatchObject({
            status: "UNKNOWN"
          });
          expect(processAfterRetract.projection.interpretations[0]).not.toHaveProperty("meaning");

          await expect(
            store.loadCorrections({
              address: ADDRESS,
              scopeReference: { reference: "other-scope" }
            })
          ).resolves.toEqual({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] });
          await expect(
            store.loadCorrections({
              address: { ...ADDRESS, characterInstanceId: "other-character" },
              scopeReference: SCOPE
            })
          ).resolves.toEqual({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] });
          await expect(
            store.loadCorrections({
              address: { ...ADDRESS, personaProfileId: "other-profile" },
              scopeReference: SCOPE
            })
          ).resolves.toEqual({ status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] });

          const malformed = createP8CorrectionRecord(
            correction({ correctionReference: "p8-1e-malformed-version" })
          );
          await client.query(
            `insert into p8_corrections (
               record_version, correction_reference,
               character_instance_id, persona_profile_id, subject_scope_id, scope_reference,
               target_kind, interpretation_reference, action,
               replacement_meaning, provenance_source, provenance_reference,
               superseded_evidence_references, payload
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
            [
              "p8-1e.v99",
              malformed.correctionReference,
              malformed.address.characterInstanceId,
              malformed.address.personaProfileId,
              malformed.address.subjectScopeId,
              malformed.scopeReference.reference,
              "INTERPRETATION",
              malformed.target.kind === "INTERPRETATION"
                ? malformed.target.interpretationReference
                : null,
              malformed.action,
              malformed.replacementMeaning,
              malformed.provenance.source,
              malformed.provenance.reference,
              malformed.supersededEvidenceReferences,
              JSON.stringify({ ...malformed, recordVersion: "p8-1e.v99" })
            ]
          );
          await expect(
            store.loadCorrections({ address: ADDRESS, scopeReference: SCOPE })
          ).resolves.toEqual({
            status: "ERROR"
          });

          const table = await client.query(
            `select table_schema, table_name
               from information_schema.tables
              where table_schema = $1
                and table_name = $2`,
            [schema, "p8_corrections"]
          );
          expect(table.rows).toEqual([{ table_schema: schema, table_name: "p8_corrections" }]);
          const index = await client.query(
            `select indexname from pg_indexes where schemaname = $1 and indexname = $2`,
            [schema, "p8_corrections_address_scope_idx"]
          );
          expect(index.rows).toHaveLength(1);
        } finally {
          client.release();
        }
      } finally {
        await setupPool.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`);
        await setupPool.end();
      }
    }
  );
});
