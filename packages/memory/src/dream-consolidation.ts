import { Pool } from "pg";
import type { QueryResultRow } from "pg";
import { MemoryIngestionPolicy } from "./ingestion.js";
import { normalizePostgresConnectionString } from "./postgres-connection.js";
import { DEFAULT_MEMORY_HIERARCHY_BUDGETS, type MemoryHierarchyBudgets } from "./hierarchy.js";
import { jaccardSimilarity, sha256Hex, tokenizeMemoryText } from "./memory-vnext-text.js";
import type { MemoryWriteEventInput, MemoryWriteEventOutcome } from "./provider.js";
import type { RecentEpisode } from "./recent-episode.js";
import type { RecentEpisodeStore } from "./recent-episode-store.js";

export const DREAM_CONSOLIDATION_VERSION = "memory-vnext-dream.v1" as const;
export const DEFAULT_DREAM_LEASE_MS = 30_000;

export const DreamTriggerKinds = [
  "recurrence",
  "salience",
  "explicit",
  "idle",
  "scheduled"
] as const;
export type DreamTriggerKind = (typeof DreamTriggerKinds)[number];

export const DreamJobStatuses = [
  "pending",
  "processing",
  "complete",
  "skipped",
  "terminal_failed",
  "reconcile_required"
] as const;
export type DreamJobStatus = (typeof DreamJobStatuses)[number];

export type DreamJob = {
  jobId: string;
  triggerKind: DreamTriggerKind;
  status: DreamJobStatus;
  memoryScope: string | null;
  personaId: string | null;
  subjectUserId: string | null;
  sourceEpisodeIds: string[];
  sourceDigest: string;
  payload: Record<string, unknown>;
  resultEventPayloads: MemoryWriteEventInput[] | null;
  resultSummary: string | null;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DreamWriter = (events: MemoryWriteEventInput[]) => Promise<MemoryWriteEventOutcome[]>;

export interface DreamJobStore {
  upsertPending(job: DreamJob): Promise<DreamJob>;
  getByDigest(sourceDigest: string): Promise<DreamJob | null>;
  getById(jobId: string): Promise<DreamJob | null>;
  listDue(now: Date, limit: number): Promise<DreamJob[]>;
  save(job: DreamJob): Promise<DreamJob>;
}

export class InMemoryDreamJobStore implements DreamJobStore {
  private readonly jobs = new Map<string, DreamJob>();
  private readonly digestIndex = new Map<string, string>();

  async upsertPending(job: DreamJob): Promise<DreamJob> {
    const existingId = this.digestIndex.get(job.sourceDigest);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (
        existing &&
        (existing.status === "complete" ||
          existing.status === "processing" ||
          existing.status === "pending")
      ) {
        return cloneJob(existing);
      }
    }
    const stored = cloneJob(job);
    this.jobs.set(stored.jobId, stored);
    this.digestIndex.set(stored.sourceDigest, stored.jobId);
    return cloneJob(stored);
  }

  async getByDigest(sourceDigest: string): Promise<DreamJob | null> {
    const id = this.digestIndex.get(sourceDigest);
    const job = id ? this.jobs.get(id) : undefined;
    return job ? cloneJob(job) : null;
  }

  async getById(jobId: string): Promise<DreamJob | null> {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : null;
  }

  async listDue(now: Date, limit: number): Promise<DreamJob[]> {
    const nowMs = now.getTime();
    return [...this.jobs.values()]
      .filter((job) => isDue(job, nowMs))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
      .map(cloneJob);
  }

  async save(job: DreamJob): Promise<DreamJob> {
    const stored = cloneJob(job);
    this.jobs.set(stored.jobId, stored);
    this.digestIndex.set(stored.sourceDigest, stored.jobId);
    return cloneJob(stored);
  }
}

export type DreamConsiderInput = {
  episode: RecentEpisode;
  existing: readonly RecentEpisode[];
  now: Date;
  idleMs?: number | undefined;
  explicitImportance?: boolean | undefined;
};

export type DreamConsiderResult = {
  triggered: boolean;
  triggerKind?: DreamTriggerKind;
  job?: DreamJob;
  skippedReason?: string;
};

export class DreamConsolidationEngine {
  constructor(
    private readonly jobs: DreamJobStore,
    private readonly episodes: RecentEpisodeStore,
    private readonly options: {
      budgets?: Partial<MemoryHierarchyBudgets> | undefined;
      writer?: DreamWriter | undefined;
      ingestion?: MemoryIngestionPolicy | undefined;
      leaseMs?: number | undefined;
      idleMs?: number | undefined;
    } = {}
  ) {}

  async consider(input: DreamConsiderInput): Promise<DreamConsiderResult> {
    if (input.episode.userStatements.length === 0) {
      return { triggered: false, skippedReason: "no-user-statements" };
    }

    const budgets = { ...DEFAULT_MEMORY_HIERARCHY_BUDGETS, ...this.options.budgets };
    const cluster = findRecurrenceCluster(input.episode, input.existing, budgets);
    const explicit = input.explicitImportance === true || hasExplicitImportance(input.episode);
    const idle = (input.idleMs ?? 0) >= (this.options.idleMs ?? 30 * 60 * 1000);
    let triggerKind: DreamTriggerKind | undefined;
    let members = [input.episode];

    if (cluster.length >= budgets.recurrenceMinCount) {
      triggerKind = "recurrence";
      members = cluster;
    } else if (explicit) {
      triggerKind = hasExplicitRemember(input.episode) ? "explicit" : "salience";
    } else if (idle) {
      triggerKind = "idle";
    }

    if (!triggerKind) {
      return { triggered: false, skippedReason: "no-trigger" };
    }

    const sourceEpisodeIds = [...new Set(members.map((item) => item.id))].sort();
    const sourceDigest = sha256Hex(
      members
        .map((item) => item.sourceDigest)
        .sort()
        .join("|")
    );
    const existing = await this.jobs.getByDigest(sourceDigest);
    if (existing?.status === "complete") {
      return { triggered: false, job: existing, skippedReason: "already-complete" };
    }
    if (existing?.status === "pending" || existing?.status === "processing") {
      return { triggered: false, job: existing, skippedReason: "already-queued" };
    }

    const nowIso = input.now.toISOString();
    const job = await this.jobs.upsertPending({
      jobId: `dream:${sourceDigest.slice(0, 16)}`,
      triggerKind,
      status: "pending",
      memoryScope: input.episode.memoryScope,
      personaId: input.episode.personaId,
      subjectUserId: input.episode.subjectUserId,
      sourceEpisodeIds,
      sourceDigest,
      payload: {
        version: DREAM_CONSOLIDATION_VERSION,
        userOnly: true,
        assistantNonAuthoritative: true,
        recurrenceDoesNotUpgradeConfidence: true
      },
      resultEventPayloads: null,
      resultSummary: null,
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null
    });
    return { triggered: true, triggerKind, job };
  }

  async runDue(now: Date, leaseOwner: string, limit = 4): Promise<DreamJob[]> {
    const due = await this.jobs.listDue(now, limit);
    const completed: DreamJob[] = [];
    for (const job of due) {
      completed.push(await this.runJob(job, now, leaseOwner));
    }
    return completed;
  }

  async runJob(job: DreamJob, now: Date, leaseOwner: string): Promise<DreamJob> {
    if (job.status === "complete") return job;
    const leaseMs = this.options.leaseMs ?? DEFAULT_DREAM_LEASE_MS;
    const claimed: DreamJob = {
      ...job,
      status: "processing",
      attemptCount: job.attemptCount + 1,
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      updatedAt: now.toISOString()
    };
    await this.jobs.save(claimed);

    try {
      const episodes: RecentEpisode[] = [];
      for (const id of claimed.sourceEpisodeIds) {
        const episode = await this.episodes.getById(id);
        if (episode) episodes.push(episode);
      }
      const events = await this.extractUserGroundedEvents(episodes, claimed);
      if (events.length === 0) {
        const skipped: DreamJob = {
          ...claimed,
          status: "skipped",
          resultEventPayloads: [],
          resultSummary: "No user-grounded long-term evidence extracted.",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now.toISOString(),
          updatedAt: now.toISOString()
        };
        return this.jobs.save(skipped);
      }

      let outcomes: MemoryWriteEventOutcome[] = [];
      if (this.options.writer) {
        outcomes = await this.options.writer(events);
      }
      const ambiguous = outcomes.some(
        (outcome) => outcome.status === "rejected" && outcome.failureClass === "ambiguous"
      );
      if (ambiguous) {
        const reconcile: DreamJob = {
          ...claimed,
          status: "reconcile_required",
          resultEventPayloads: events,
          resultSummary: "Writer returned an ambiguous external effect.",
          lastErrorCode: "AMBIGUOUS_WRITE",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now.toISOString()
        };
        return this.jobs.save(reconcile);
      }

      for (const episode of episodes) {
        await this.episodes.markStatus(episode.id, "consolidated", {
          consolidatedAt: now.toISOString(),
          consolidationJobId: claimed.jobId
        });
      }

      const complete: DreamJob = {
        ...claimed,
        status: "complete",
        resultEventPayloads: events,
        resultSummary: `Consolidated ${events.length} user-grounded event(s) from ${episodes.length} episode(s).`,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      return this.jobs.save(complete);
    } catch (error) {
      const failed: DreamJob = {
        ...claimed,
        status: "terminal_failed",
        lastErrorCode: "DREAM_EXECUTION_FAILED",
        lastErrorMessage: error instanceof Error ? error.message : "dream failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now.toISOString()
      };
      return this.jobs.save(failed);
    }
  }

  private async extractUserGroundedEvents(
    episodes: RecentEpisode[],
    job: DreamJob
  ): Promise<MemoryWriteEventInput[]> {
    const ingestion = this.options.ingestion ?? new MemoryIngestionPolicy();
    const userStatements = episodes.flatMap((episode) => episode.userStatements);
    const unique = dedupeStatements(userStatements);
    const events: MemoryWriteEventInput[] = [];
    for (const [index, statement] of unique.entries()) {
      const result = await ingestion.build({
        userMessage: statement,
        assistantMessage: "Consolidation context only; assistant prose is not evidence.",
        scope: job.memoryScope ?? "user",
        sessionId: episodes[0]?.sessionId,
        personaId: job.personaId,
        subjectUserId: job.subjectUserId,
        observedAt: episodes[0]?.occurredAt ?? episodes[0]?.recordedAt,
        conversationId: episodes[0]?.sessionId,
        idempotencyKey: `${job.sourceDigest}:${index}`
      });
      for (const event of result.events) {
        if (event.assertion?.source !== "user") continue;
        events.push({
          ...event,
          confidence: event.confidence ?? null,
          metadata: {
            ...event.metadata,
            dreamJobId: job.jobId,
            dreamTrigger: job.triggerKind,
            sourceEpisodeIds: job.sourceEpisodeIds,
            recurrenceDoesNotUpgradeConfidence: true,
            assistantNonAuthoritative: true
          }
        });
      }
    }
    return events;
  }
}

export function findRecurrenceCluster(
  episode: RecentEpisode,
  existing: readonly RecentEpisode[],
  budgets: MemoryHierarchyBudgets
): RecentEpisode[] {
  const seedTokens = tokenizeMemoryText(episode.userStatements.join(" "));
  if (seedTokens.length === 0) return [];
  const cluster = [episode];
  for (const candidate of existing) {
    if (candidate.id === episode.id) continue;
    if (candidate.userStatements.length === 0) continue;
    const similarity = jaccardSimilarity(
      seedTokens,
      tokenizeMemoryText(candidate.userStatements.join(" "))
    );
    if (similarity >= budgets.recurrenceMinSimilarity) cluster.push(candidate);
  }
  return cluster;
}

function hasExplicitImportance(episode: RecentEpisode): boolean {
  const text = episode.userStatements.join(" ");
  return /记住|重要|决定了|以后都|from now on|remember|important|decided/iu.test(text);
}

function hasExplicitRemember(episode: RecentEpisode): boolean {
  return /记住|please remember|记住：|记住:/iu.test(episode.userStatements.join(" "));
}

function isDue(job: DreamJob, nowMs: number): boolean {
  if (job.status === "pending") return true;
  if (job.status === "reconcile_required") return true;
  if (job.status === "processing") {
    return job.leaseExpiresAt !== null && Date.parse(job.leaseExpiresAt) <= nowMs;
  }
  return false;
}

function dedupeStatements(statements: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const statement of statements) {
    const key = statement.replace(/\s+/g, "").toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(statement);
  }
  return result;
}

function cloneJob(job: DreamJob): DreamJob {
  return {
    ...job,
    sourceEpisodeIds: [...job.sourceEpisodeIds],
    payload: { ...job.payload },
    resultEventPayloads: job.resultEventPayloads
      ? job.resultEventPayloads.map((event) => ({ ...event, metadata: { ...event.metadata } }))
      : null
  };
}

export class PostgresDreamJobStore implements DreamJobStore {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(connectionString: string | Pool) {
    this.ownsPool = typeof connectionString === "string";
    this.pool =
      typeof connectionString === "string"
        ? new Pool({
            connectionString: normalizePostgresConnectionString(connectionString),
            connectionTimeoutMillis: 10_000
          })
        : connectionString;
  }

  async upsertPending(job: DreamJob): Promise<DreamJob> {
    const existing = await this.getByDigest(job.sourceDigest);
    if (
      existing &&
      (existing.status === "complete" ||
        existing.status === "processing" ||
        existing.status === "pending")
    ) {
      return existing;
    }
    const result = await this.pool.query(
      `insert into dream_jobs (
        job_id, trigger_kind, status, memory_scope, persona_id, subject_user_id,
        source_episode_ids, source_digest, payload, result_event_payloads,
        result_summary, attempt_count, lease_owner, lease_expires_at,
        last_error_code, last_error_message, created_at, updated_at, completed_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19
      )
      on conflict (source_digest) do update set
        updated_at = dream_jobs.updated_at
      returning *`,
      bindJob(job)
    );
    return mapJobRow(result.rows[0]);
  }

  async getByDigest(sourceDigest: string): Promise<DreamJob | null> {
    const result = await this.pool.query(`select * from dream_jobs where source_digest = $1`, [
      sourceDigest
    ]);
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  async getById(jobId: string): Promise<DreamJob | null> {
    const result = await this.pool.query(`select * from dream_jobs where job_id = $1`, [jobId]);
    return result.rows[0] ? mapJobRow(result.rows[0]) : null;
  }

  async listDue(now: Date, limit: number): Promise<DreamJob[]> {
    const result = await this.pool.query(
      `select * from dream_jobs
       where status = 'pending'
          or status = 'reconcile_required'
          or (status = 'processing' and lease_expires_at is not null and lease_expires_at <= $1)
       order by created_at asc
       limit $2`,
      [now.toISOString(), limit]
    );
    return result.rows.map(mapJobRow);
  }

  async save(job: DreamJob): Promise<DreamJob> {
    const result = await this.pool.query(
      `insert into dream_jobs (
        job_id, trigger_kind, status, memory_scope, persona_id, subject_user_id,
        source_episode_ids, source_digest, payload, result_event_payloads,
        result_summary, attempt_count, lease_owner, lease_expires_at,
        last_error_code, last_error_message, created_at, updated_at, completed_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19
      )
      on conflict (job_id) do update set
        trigger_kind = excluded.trigger_kind,
        status = excluded.status,
        payload = excluded.payload,
        result_event_payloads = excluded.result_event_payloads,
        result_summary = excluded.result_summary,
        attempt_count = excluded.attempt_count,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        last_error_code = excluded.last_error_code,
        last_error_message = excluded.last_error_message,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
      returning *`,
      bindJob(job)
    );
    return mapJobRow(result.rows[0]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

function bindJob(job: DreamJob): unknown[] {
  return [
    job.jobId,
    job.triggerKind,
    job.status,
    job.memoryScope,
    job.personaId,
    job.subjectUserId,
    JSON.stringify(job.sourceEpisodeIds),
    job.sourceDigest,
    JSON.stringify(job.payload),
    job.resultEventPayloads ? JSON.stringify(job.resultEventPayloads) : null,
    job.resultSummary,
    job.attemptCount,
    job.leaseOwner,
    job.leaseExpiresAt,
    job.lastErrorCode,
    job.lastErrorMessage,
    job.createdAt,
    job.updatedAt,
    job.completedAt
  ];
}

function mapJobRow(row: QueryResultRow | undefined): DreamJob {
  if (!row) throw new Error("Dream job row was empty.");
  return {
    jobId: String(row["job_id"]),
    triggerKind: row["trigger_kind"] as DreamTriggerKind,
    status: row["status"] as DreamJobStatus,
    memoryScope: row["memory_scope"] ?? null,
    personaId: row["persona_id"] ?? null,
    subjectUserId: row["subject_user_id"] ?? null,
    sourceEpisodeIds: asJsonArray(row["source_episode_ids"]),
    sourceDigest: String(row["source_digest"]),
    payload: asJsonObject(row["payload"]),
    resultEventPayloads: row["result_event_payloads"]
      ? (asJsonValue(row["result_event_payloads"]) as MemoryWriteEventInput[])
      : null,
    resultSummary: row["result_summary"] ?? null,
    attemptCount: Number(row["attempt_count"] ?? 0),
    leaseOwner: row["lease_owner"] ?? null,
    leaseExpiresAt: row["lease_expires_at"]
      ? new Date(String(row["lease_expires_at"])).toISOString()
      : null,
    lastErrorCode: row["last_error_code"] ?? null,
    lastErrorMessage: row["last_error_message"] ?? null,
    createdAt: new Date(String(row["created_at"])).toISOString(),
    updatedAt: new Date(String(row["updated_at"])).toISOString(),
    completedAt: row["completed_at"] ? new Date(String(row["completed_at"])).toISOString() : null
  };
}

function asJsonArray(value: unknown): string[] {
  const parsed = asJsonValue(value);
  return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
}

function asJsonObject(value: unknown): Record<string, unknown> {
  const parsed = asJsonValue(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function asJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
