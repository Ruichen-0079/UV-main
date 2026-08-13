import { createHash } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { parseMemoryRepositoryEnv, type MemoryRepositoryKind } from "./env.js";
import { MemoryIngestionPolicy, type MemoryIngestionInput } from "./ingestion.js";
import {
  buildChatMemoryScope,
  classifyMem0Turn,
  MEMORY_SCOPE_MISSING,
  resolveMem0ChatIdentity,
  type Mem0TurnKind
} from "./mem0-chat.js";
import { detectExplicitForgetRequest } from "./intent.js";
import { normalizePostgresConnectionString } from "./postgres-connection.js";
import type { MemoryWriteEventInput, MemoryWriteEventOutcome } from "./provider.js";

export const FINALIZED_INGESTION_POLICY_VERSION = "factual-v1/schema-1";

export type FinalizedIngestionTurnStatus =
  | "pending"
  | "processing"
  | "complete"
  | "partial"
  | "retryable_failed"
  | "reconcile_required"
  | "terminal_failed"
  | "skipped";

export type FinalizedIngestionEventStatus =
  | "pending"
  | "processing"
  | "complete"
  | "unchanged"
  | "retryable_failed"
  | "reconcile_required"
  | "terminal_failed"
  | "skipped";

export type FinalizedIngestionEventPayload = Omit<MemoryWriteEventInput, "signal">;

export type FinalizedIngestionEventOutcome =
  | MemoryWriteEventOutcome
  | { status: "ambiguous"; errorCode?: string | null; errorMessage?: string | null }
  | {
      status: "retryable_failed";
      errorCode?: string | null;
      errorMessage?: string | null;
      nextAttemptAt?: string | null;
    }
  | { status: "skipped"; errorCode?: string | null; errorMessage?: string | null };

export type FinalizedIngestionTurn = {
  finalizedTurnId: string;
  assistantMessageId: string;
  sourceUserEventId: string | null;
  conversationId: string;
  traceId: string;
  personaId: string | null;
  subjectUserId: string | null;
  memoryScope: string | null;
  finalizedAt: string;
  ingestionRequested: boolean;
  ingestionSkipReason: string | null;
  failureStage: "materialization" | null;
  status: FinalizedIngestionTurnStatus;
  policyVersion: string;
  sourceDigest: string;
  eligibleEventCount: number;
  pendingEventCount: number;
  processingEventCount: number;
  completeEventCount: number;
  unchangedEventCount: number;
  failedEventCount: number;
  ambiguousEventCount: number;
  skippedEventCount: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  completedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type FinalizedIngestionEvent = {
  eventId: string;
  finalizedTurnId: string;
  eventKey: string;
  backendIdempotencyKey: string;
  eventPayload: FinalizedIngestionEventPayload;
  status: FinalizedIngestionEventStatus;
  resultKind: "written" | "unchanged" | "rejected" | "ambiguous" | "skipped" | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  dispatchStartedAt: string | null;
  nextAttemptAt: string | null;
  backendMemoryId: string | null;
  backendOperation: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type FinalizedIngestionAdmissionInput = {
  finalizedTurnId: string;
  assistantMessageId: string;
  sourceUserEventId?: string | null | undefined;
  conversationId: string;
  traceId: string;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  finalizedAt: string;
  ingestionRequested: boolean;
  userMessage: string;
  assistantMessage: string;
  sessionId?: string | undefined;
  language?: string | null | undefined;
  turnKind?: Mem0TurnKind | undefined;
};

export type FinalizedIngestionAdmission = {
  turn: FinalizedIngestionTurn;
  events: FinalizedIngestionEvent[];
};

export type FinalizedIngestionRepositoryKind = MemoryRepositoryKind;

export type MissingFinalizedConversationTurn = {
  finalizedTurnId: string;
  assistantMessageId: string;
  sourceUserEventId: string | null;
  conversationId: string;
  traceId: string;
  personaId: string | null;
  subjectUserId: string | null;
  content: string;
  status: "completed";
  finalizedAt: string;
  ingestionRequested: boolean | null;
};

export type FinalizedIngestionRepository = {
  readonly kind: FinalizedIngestionRepositoryKind;
  admit(input: {
    turn: FinalizedIngestionTurn;
    events: Array<{
      eventId: string;
      eventKey: string;
      backendIdempotencyKey: string;
      eventPayload: FinalizedIngestionEventPayload;
    }>;
  }): Promise<FinalizedIngestionAdmission>;
  getTurn(finalizedTurnId: string): Promise<FinalizedIngestionTurn | null>;
  listEvents(finalizedTurnId: string): Promise<FinalizedIngestionEvent[]>;
  claimEvent(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    leaseSeconds: number;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent | null>;
  markEventDispatchStarted(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent | null>;
  recordEventOutcome(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    outcome: FinalizedIngestionEventOutcome;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent>;
  reclaimExpiredEvent(input: {
    finalizedTurnId: string;
    eventId: string;
    expectedVersion: number;
    now?: string | undefined;
  }): Promise<FinalizedIngestionEvent | null>;
  renewLease(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    expectedVersion: number;
    leaseSeconds: number;
  }): Promise<FinalizedIngestionEvent>;
  listMissingAdmissions(limit?: number): Promise<MissingFinalizedConversationTurn[]>;
  listNonTerminalTurns(limit?: number): Promise<FinalizedIngestionTurn[]>;
  close?(): Promise<void>;
};

export type FinalizedIngestionPort = {
  admit(input: FinalizedIngestionAdmissionInput): Promise<FinalizedIngestionAdmission>;
  claimEvent(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    leaseSeconds: number;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent | null>;
  markEventDispatchStarted(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent | null>;
  recordEventOutcome(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    outcome: FinalizedIngestionEventOutcome;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent>;
  reclaimExpiredEvent(input: {
    finalizedTurnId: string;
    eventId: string;
    expectedVersion: number;
    now?: string | undefined;
  }): Promise<FinalizedIngestionEvent | null>;
  renewLease(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    expectedVersion: number;
    leaseSeconds: number;
  }): Promise<FinalizedIngestionEvent>;
};

type QueryClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
};

type TransactionClient = QueryClient & {
  release(): void;
};

type DatabaseClient = QueryClient & {
  end(): Promise<void>;
  connect?(): Promise<TransactionClient>;
};

export class PostgresFinalizedIngestionRepository implements FinalizedIngestionRepository {
  readonly kind = "postgres";
  private readonly client: DatabaseClient;
  private readonly ownsClient: boolean;

  constructor(connectionString: string | DatabaseClient) {
    this.ownsClient = typeof connectionString === "string";
    this.client =
      typeof connectionString === "string"
        ? new Pool({
            connectionString: normalizePostgresConnectionString(connectionString),
            connectionTimeoutMillis: 10_000
          })
        : connectionString;
  }

  async admit(input: {
    turn: FinalizedIngestionTurn;
    events: Array<{
      eventId: string;
      eventKey: string;
      backendIdempotencyKey: string;
      eventPayload: FinalizedIngestionEventPayload;
    }>;
  }): Promise<FinalizedIngestionAdmission> {
    const turn = input.turn;
    return this.transaction(async (tx) => {
      const insertedTurn = await tx.query(
        `insert into finalized_ingestion_turns (
          finalized_turn_id, assistant_message_id, source_user_event_id, conversation_id,
          trace_id, persona_id, subject_user_id, memory_scope, finalized_at,
          ingestion_requested, ingestion_skip_reason, status, policy_version, source_digest,
          failure_stage,
          eligible_event_count, pending_event_count, skipped_event_count,
          completed_at, last_error_code, last_error_message, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, now()
        ) on conflict (finalized_turn_id) do nothing
          returning finalized_turn_id`,
        [
          turn.finalizedTurnId,
          turn.assistantMessageId,
          turn.sourceUserEventId,
          turn.conversationId,
          turn.traceId,
          turn.personaId,
          turn.subjectUserId,
          turn.memoryScope,
          turn.finalizedAt,
          turn.ingestionRequested,
          turn.ingestionSkipReason,
          turn.status,
          turn.policyVersion,
          turn.sourceDigest,
          turn.failureStage,
          turn.eligibleEventCount,
          turn.pendingEventCount,
          turn.skippedEventCount,
          turn.completedAt,
          turn.lastErrorCode,
          turn.lastErrorMessage
        ]
      );

      if (insertedTurn.rows.length === 0) {
        const existingTurn = await this.getTurnWithClient(turn.finalizedTurnId, tx);
        if (!existingTurn) {
          throw new Error(`Finalized ingestion turn '${turn.finalizedTurnId}' was not returned.`);
        }
        return {
          turn: existingTurn,
          events: await this.listEventsWithClient(turn.finalizedTurnId, tx)
        };
      }

      for (const event of input.events) {
        await tx.query(
          `insert into finalized_ingestion_events (
            event_id, finalized_turn_id, event_key, backend_idempotency_key, event_payload, status
          ) values ($1, $2, $3, $4, $5::jsonb, 'pending')
          on conflict (finalized_turn_id, event_key) do nothing`,
          [
            event.eventId,
            turn.finalizedTurnId,
            event.eventKey,
            event.backendIdempotencyKey,
            JSON.stringify(event.eventPayload)
          ]
        );
      }

      if (input.events.length > 0) {
        await this.refreshAggregate(turn.finalizedTurnId, tx);
      }
      const admittedTurn = await this.getTurnWithClient(turn.finalizedTurnId, tx);
      if (!admittedTurn) {
        throw new Error(`Finalized ingestion turn '${turn.finalizedTurnId}' was not returned.`);
      }
      return {
        turn: admittedTurn,
        events: await this.listEventsWithClient(turn.finalizedTurnId, tx)
      };
    });
  }

  async getTurn(finalizedTurnId: string): Promise<FinalizedIngestionTurn | null> {
    const result = await this.client.query(
      "select * from finalized_ingestion_turns where finalized_turn_id = $1",
      [finalizedTurnId]
    );
    return result.rows[0] ? mapTurnRow(result.rows[0]) : null;
  }

  async listEvents(finalizedTurnId: string): Promise<FinalizedIngestionEvent[]> {
    const result = await this.client.query(
      `select * from finalized_ingestion_events
       where finalized_turn_id = $1
       order by created_at asc, event_id asc`,
      [finalizedTurnId]
    );
    return result.rows.map(mapEventRow);
  }

  async claimEvent(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    leaseSeconds: number;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent | null> {
    return this.transaction(async (tx) => {
      await this.lockTurn(input.finalizedTurnId, tx);
      const result = await tx.query(
        `update finalized_ingestion_events
         set status = 'processing',
             lease_owner = $3,
             lease_expires_at = now() + ($4::int * interval '1 second'),
             dispatch_started_at = null,
             updated_at = now(),
             version = version + 1
         where finalized_turn_id = $1
           and event_id = $2
           and (status = 'pending' or (status = 'retryable_failed'
             and (next_attempt_at is null or next_attempt_at <= now())))
           and version = $5
         returning *`,
        [
          input.finalizedTurnId,
          input.eventId,
          input.leaseOwner,
          Math.max(1, Math.trunc(input.leaseSeconds)),
          input.expectedVersion
        ]
      );
      if (!result.rows[0]) return null;
      await this.refreshAggregate(input.finalizedTurnId, tx);
      return mapEventRow(result.rows[0]);
    });
  }

  async markEventDispatchStarted(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent | null> {
    return this.transaction(async (tx) => {
      await this.lockTurn(input.finalizedTurnId, tx);
      const result = await tx.query(
        `update finalized_ingestion_events
         set dispatch_started_at = now(),
             attempt_count = attempt_count + 1,
             last_attempt_at = now(),
             updated_at = now(),
             version = version + 1
         where finalized_turn_id = $1 and event_id = $2
           and status = 'processing'
           and lease_owner = $3
           and lease_expires_at > now()
           and dispatch_started_at is null
           and version = $4
         returning *`,
        [input.finalizedTurnId, input.eventId, input.leaseOwner, input.expectedVersion]
      );
      if (!result.rows[0]) return null;
      await tx.query(
        `update finalized_ingestion_turns
         set attempt_count = attempt_count + 1,
             last_attempt_at = now(),
             updated_at = now(),
             version = version + 1
         where finalized_turn_id = $1`,
        [input.finalizedTurnId]
      );
      await this.refreshAggregate(input.finalizedTurnId, tx);
      return mapEventRow(result.rows[0]);
    });
  }

  async recordEventOutcome(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    outcome: FinalizedIngestionEventOutcome;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent> {
    const mapped = mapOutcome(input.outcome);
    return this.transaction(async (tx) => {
      await this.lockTurn(input.finalizedTurnId, tx);
      const result = await tx.query(
        `update finalized_ingestion_events
         set status = $3,
             result_kind = $4,
             last_attempt_at = now(),
             backend_memory_id = $5,
            backend_operation = $6,
            error_code = $7,
            error_message = $8,
            next_attempt_at = $9,
            dispatch_started_at = null,
            lease_owner = null,
            lease_expires_at = null,
            updated_at = now(),
            version = version + 1
         where finalized_turn_id = $1 and event_id = $2
           and status = 'processing'
           and lease_owner = $10
           and version = $11
           and ($12::boolean = false or (dispatch_started_at is not null and attempt_count >= 1))
         returning *`,
        [
          input.finalizedTurnId,
          input.eventId,
          mapped.status,
          mapped.resultKind,
          mapped.backendMemoryId,
          mapped.backendOperation,
          mapped.errorCode,
          mapped.errorMessage,
          mapped.nextAttemptAt,
          input.leaseOwner,
          input.expectedVersion,
          outcomeRequiresDispatchMarker(input.outcome)
        ]
      );
      if (!result.rows[0]) {
        throw new Error(
          `Finalized ingestion event '${input.eventId}' was not found or changed for turn '${input.finalizedTurnId}'.`
        );
      }
      await this.refreshAggregate(input.finalizedTurnId, tx);
      const refreshed = await tx.query(
        `select * from finalized_ingestion_events where finalized_turn_id = $1 and event_id = $2`,
        [input.finalizedTurnId, input.eventId]
      );
      return mapEventRow(refreshed.rows[0] ?? result.rows[0]);
    });
  }

  async reclaimExpiredEvent(input: {
    finalizedTurnId: string;
    eventId: string;
    expectedVersion: number;
    now?: string | undefined;
  }): Promise<FinalizedIngestionEvent | null> {
    return this.transaction(async (tx) => {
      await this.lockTurn(input.finalizedTurnId, tx);
      const result = await tx.query(
        `update finalized_ingestion_events
         set status = case when dispatch_started_at is null then 'pending' else 'reconcile_required' end,
             result_kind = case when dispatch_started_at is null then null else 'ambiguous' end,
             error_code = case when dispatch_started_at is null then null else 'MEMORY_DISPATCH_EXPIRED' end,
             error_message = case when dispatch_started_at is null then null else 'Lease expired after dispatch began.' end,
             next_attempt_at = null,
             lease_owner = null,
             lease_expires_at = null,
             dispatch_started_at = null,
             updated_at = now(),
             version = version + 1
         where finalized_turn_id = $1 and event_id = $2
           and status = 'processing'
           and lease_expires_at <= coalesce($3::timestamptz, now())
           and version = $4
         returning *`,
        [input.finalizedTurnId, input.eventId, input.now ?? null, input.expectedVersion]
      );
      if (!result.rows[0]) return null;
      await this.refreshAggregate(input.finalizedTurnId, tx);
      return mapEventRow(result.rows[0]);
    });
  }

  async renewLease(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    expectedVersion: number;
    leaseSeconds: number;
  }): Promise<FinalizedIngestionEvent> {
    return this.transaction(async (tx) => {
      await this.lockTurn(input.finalizedTurnId, tx);
      const result = await tx.query(
        `update finalized_ingestion_events
         set lease_expires_at = now() + ($5::int * interval '1 second'),
             updated_at = now(),
             version = version + 1
         where finalized_turn_id = $1 and event_id = $2
           and status = 'processing'
           and lease_owner = $3
           and lease_expires_at > now()
           and version = $4
         returning *`,
        [
          input.finalizedTurnId,
          input.eventId,
          input.leaseOwner,
          input.expectedVersion,
          Math.max(1, Math.trunc(input.leaseSeconds))
        ]
      );
      if (!result.rows[0]) {
        throw new Error(`Finalized ingestion event '${input.eventId}' lease could not be renewed.`);
      }
      await this.refreshAggregate(input.finalizedTurnId, tx);
      return mapEventRow(result.rows[0]);
    });
  }

  async listMissingAdmissions(limit = 100): Promise<MissingFinalizedConversationTurn[]> {
    const result = await this.client.query(
      `select
         cm.id as assistant_message_id,
         cm.finalized_turn_id,
         cm.source_user_event_id,
         cm.session_id as conversation_id,
         cm.trace_id,
         cm.persona_id,
         cm.subject_user_id,
         cm.content,
         cm.status,
         coalesce(cm.completed_at, cm.created_at) as finalized_at,
         cm.ingestion_requested
       from conversation_messages cm
       left join finalized_ingestion_turns fit
         on fit.finalized_turn_id = cm.finalized_turn_id
       where cm.role = 'assistant'
         and cm.status = 'completed'
         and cm.ingestion_requested = true
         and nullif(btrim(cm.persona_id), '') is not null
         and nullif(btrim(cm.subject_user_id), '') is not null
         and cm.finalized_turn_id is not null
         and fit.finalized_turn_id is null
       order by coalesce(cm.completed_at, cm.created_at) asc
       limit $1`,
      [clampLimit(limit)]
    );
    return result.rows.map(mapMissingRow);
  }

  async listNonTerminalTurns(limit = 100): Promise<FinalizedIngestionTurn[]> {
    const result = await this.client.query(
      `select * from finalized_ingestion_turns
       where status not in ('complete', 'skipped', 'terminal_failed')
       order by updated_at asc
       limit $1`,
      [clampLimit(limit)]
    );
    return result.rows.map(mapTurnRow);
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client.end();
    }
  }

  private async refreshAggregate(
    finalizedTurnId: string,
    client: QueryClient = this.client
  ): Promise<void> {
    await client.query(
      `with counts as (
        select
          count(*)::int as eligible_event_count,
          count(*) filter (where status = 'pending')::int as pending_event_count,
          count(*) filter (where status = 'processing')::int as processing_event_count,
          count(*) filter (where status = 'complete')::int as complete_event_count,
          count(*) filter (where status = 'unchanged')::int as unchanged_event_count,
          count(*) filter (where status = 'retryable_failed')::int as retryable_failed_event_count,
          count(*) filter (where status = 'terminal_failed')::int as terminal_failed_event_count,
          count(*) filter (where status in ('retryable_failed', 'terminal_failed'))::int as failed_event_count,
          count(*) filter (where status = 'reconcile_required')::int as ambiguous_event_count,
          count(*) filter (where status = 'skipped')::int as skipped_event_count,
          max(error_code) filter (where error_code is not null) as last_error_code,
          max(error_message) filter (where error_message is not null) as last_error_message
        from finalized_ingestion_events
        where finalized_turn_id = $1
      )
      update finalized_ingestion_turns fit
      set eligible_event_count = counts.eligible_event_count,
          pending_event_count = counts.pending_event_count,
          processing_event_count = counts.processing_event_count,
          complete_event_count = counts.complete_event_count,
          unchanged_event_count = counts.unchanged_event_count,
          failed_event_count = counts.failed_event_count,
          ambiguous_event_count = counts.ambiguous_event_count,
          skipped_event_count = counts.skipped_event_count,
          status = case
            when fit.ingestion_requested = false then 'skipped'
            when fit.status = 'terminal_failed' and fit.last_error_code is not null then 'terminal_failed'
            when counts.eligible_event_count = 0 then 'skipped'
            when counts.ambiguous_event_count > 0 then 'reconcile_required'
            when counts.retryable_failed_event_count > 0 then 'retryable_failed'
            when counts.processing_event_count > 0 then 'processing'
            when counts.complete_event_count + counts.unchanged_event_count = counts.eligible_event_count then 'complete'
            when counts.complete_event_count + counts.unchanged_event_count + counts.skipped_event_count = counts.eligible_event_count
              and counts.complete_event_count + counts.unchanged_event_count = 0 then 'skipped'
            when counts.complete_event_count + counts.unchanged_event_count + counts.skipped_event_count = counts.eligible_event_count then 'partial'
            when counts.failed_event_count > 0 and counts.pending_event_count + counts.processing_event_count = 0
              then case when counts.complete_event_count + counts.unchanged_event_count > 0 then 'partial' else 'terminal_failed' end
            when counts.failed_event_count > 0 then 'partial'
            when counts.complete_event_count + counts.unchanged_event_count > 0 then 'partial'
            else 'pending'
          end,
          completed_at = case
            when counts.eligible_event_count > 0
              and counts.complete_event_count + counts.unchanged_event_count = counts.eligible_event_count
              then coalesce(fit.completed_at, now())
            when counts.eligible_event_count = 0 and fit.status = 'skipped'
              then coalesce(fit.completed_at, now())
            else fit.completed_at
          end,
          last_error_code = counts.last_error_code,
          last_error_message = counts.last_error_message,
          updated_at = now(),
          version = version + 1
      from counts
      where fit.finalized_turn_id = $1`,
      [finalizedTurnId]
    );
  }

  private async lockTurn(finalizedTurnId: string, client: QueryClient): Promise<void> {
    await client.query(
      `select finalized_turn_id
       from finalized_ingestion_turns
       where finalized_turn_id = $1
       for update`,
      [finalizedTurnId]
    );
  }

  private async getTurnWithClient(
    finalizedTurnId: string,
    client: QueryClient
  ): Promise<FinalizedIngestionTurn | null> {
    const result = await client.query(
      "select * from finalized_ingestion_turns where finalized_turn_id = $1",
      [finalizedTurnId]
    );
    return result.rows[0] ? mapTurnRow(result.rows[0]) : null;
  }

  private async listEventsWithClient(
    finalizedTurnId: string,
    client: QueryClient
  ): Promise<FinalizedIngestionEvent[]> {
    const result = await client.query(
      `select * from finalized_ingestion_events
       where finalized_turn_id = $1
       order by created_at asc, event_id asc`,
      [finalizedTurnId]
    );
    return result.rows.map(mapEventRow);
  }

  private async transaction<T>(work: (client: QueryClient) => Promise<T>): Promise<T> {
    if (!this.client.connect) {
      return work(this.client);
    }
    const client = await this.client.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export class InMemoryFinalizedIngestionRepository implements FinalizedIngestionRepository {
  readonly kind = "in-memory";
  private readonly turns = new Map<string, FinalizedIngestionTurn>();
  private readonly events = new Map<string, FinalizedIngestionEvent>();

  async admit(input: {
    turn: FinalizedIngestionTurn;
    events: Array<{
      eventId: string;
      eventKey: string;
      backendIdempotencyKey: string;
      eventPayload: FinalizedIngestionEventPayload;
    }>;
  }): Promise<FinalizedIngestionAdmission> {
    const existing = this.turns.get(input.turn.finalizedTurnId);
    if (!existing) {
      this.turns.set(input.turn.finalizedTurnId, cloneTurn(input.turn));
      for (const event of input.events) {
        this.events.set(event.eventId, {
          ...event,
          finalizedTurnId: input.turn.finalizedTurnId,
          status: "pending",
          resultKind: null,
          attemptCount: 0,
          lastAttemptAt: null,
          dispatchStartedAt: null,
          nextAttemptAt: null,
          backendMemoryId: null,
          backendOperation: null,
          errorCode: null,
          errorMessage: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          version: 1,
          createdAt: input.turn.createdAt,
          updatedAt: input.turn.updatedAt
        });
      }
      this.refreshAggregate(input.turn.finalizedTurnId);
    }
    return {
      turn: cloneTurn(this.turns.get(input.turn.finalizedTurnId)!),
      events: this.listEventsSync(input.turn.finalizedTurnId)
    };
  }

  async getTurn(finalizedTurnId: string): Promise<FinalizedIngestionTurn | null> {
    const turn = this.turns.get(finalizedTurnId);
    return turn ? cloneTurn(turn) : null;
  }

  async listEvents(finalizedTurnId: string): Promise<FinalizedIngestionEvent[]> {
    return this.listEventsSync(finalizedTurnId);
  }

  async claimEvent(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    leaseSeconds: number;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent | null> {
    const event = this.events.get(input.eventId);
    if (
      !event ||
      event.finalizedTurnId !== input.finalizedTurnId ||
      !["pending", "retryable_failed"].includes(event.status) ||
      (event.status === "retryable_failed" &&
        event.nextAttemptAt !== null &&
        new Date(event.nextAttemptAt).getTime() > Date.now()) ||
      input.expectedVersion !== event.version
    ) {
      return null;
    }
    const now = new Date();
    event.status = "processing";
    event.leaseOwner = input.leaseOwner;
    event.leaseExpiresAt = new Date(
      now.getTime() + Math.max(1, Math.trunc(input.leaseSeconds)) * 1000
    ).toISOString();
    event.dispatchStartedAt = null;
    event.updatedAt = now.toISOString();
    event.version += 1;
    const turn = this.turns.get(input.finalizedTurnId);
    if (turn) {
      turn.updatedAt = now.toISOString();
      turn.version += 1;
    }
    this.refreshAggregate(input.finalizedTurnId);
    return cloneEvent(event);
  }

  async markEventDispatchStarted(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent | null> {
    const event = this.events.get(input.eventId);
    if (
      !event ||
      event.finalizedTurnId !== input.finalizedTurnId ||
      event.status !== "processing" ||
      event.leaseOwner !== input.leaseOwner ||
      !event.leaseExpiresAt ||
      new Date(event.leaseExpiresAt).getTime() <= Date.now() ||
      event.dispatchStartedAt !== null ||
      event.version !== input.expectedVersion
    ) {
      return null;
    }
    const now = new Date().toISOString();
    event.dispatchStartedAt = now;
    event.attemptCount += 1;
    event.lastAttemptAt = now;
    event.updatedAt = now;
    event.version += 1;
    const turn = this.turns.get(input.finalizedTurnId);
    if (turn) {
      turn.attemptCount += 1;
      turn.lastAttemptAt = now;
      turn.updatedAt = now;
      turn.version += 1;
    }
    this.refreshAggregate(input.finalizedTurnId);
    return cloneEvent(event);
  }

  async recordEventOutcome(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    outcome: FinalizedIngestionEventOutcome;
    expectedVersion: number;
  }): Promise<FinalizedIngestionEvent> {
    const event = this.events.get(input.eventId);
    if (!event || event.finalizedTurnId !== input.finalizedTurnId) {
      throw new Error(`Finalized ingestion event '${input.eventId}' was not found.`);
    }
    if (
      event.status !== "processing" ||
      event.leaseOwner !== input.leaseOwner ||
      event.version !== input.expectedVersion
    ) {
      throw new Error(
        `Finalized ingestion event '${input.eventId}' changed before outcome recording.`
      );
    }
    if (
      outcomeRequiresDispatchMarker(input.outcome) &&
      (event.dispatchStartedAt === null || event.attemptCount < 1)
    ) {
      throw new Error(
        `Finalized ingestion event '${input.eventId}' changed before outcome recording: ` +
          "dispatch marker is missing."
      );
    }
    const mapped = mapOutcome(input.outcome);
    Object.assign(event, {
      status: mapped.status,
      resultKind: mapped.resultKind,
      attemptCount: event.attemptCount,
      lastAttemptAt: new Date().toISOString(),
      dispatchStartedAt: null,
      backendMemoryId: mapped.backendMemoryId,
      backendOperation: mapped.backendOperation,
      errorCode: mapped.errorCode,
      errorMessage: mapped.errorMessage,
      nextAttemptAt: mapped.nextAttemptAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date().toISOString(),
      version: event.version + 1
    });
    this.refreshAggregate(input.finalizedTurnId);
    return cloneEvent(event);
  }

  async reclaimExpiredEvent(input: {
    finalizedTurnId: string;
    eventId: string;
    expectedVersion: number;
    now?: string | undefined;
  }): Promise<FinalizedIngestionEvent | null> {
    const event = this.events.get(input.eventId);
    const now = input.now ? new Date(input.now).getTime() : Date.now();
    if (
      !event ||
      event.finalizedTurnId !== input.finalizedTurnId ||
      event.status !== "processing" ||
      !event.leaseExpiresAt ||
      new Date(event.leaseExpiresAt).getTime() > now ||
      event.version !== input.expectedVersion
    ) {
      return null;
    }
    const hadDispatch = event.dispatchStartedAt !== null;
    Object.assign(event, {
      status: hadDispatch ? "reconcile_required" : "pending",
      resultKind: hadDispatch ? "ambiguous" : null,
      errorCode: hadDispatch ? "MEMORY_DISPATCH_EXPIRED" : null,
      errorMessage: hadDispatch ? "Lease expired after dispatch began." : null,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      dispatchStartedAt: null,
      updatedAt: new Date().toISOString(),
      version: event.version + 1
    });
    this.refreshAggregate(input.finalizedTurnId);
    return cloneEvent(event);
  }

  async renewLease(input: {
    finalizedTurnId: string;
    eventId: string;
    leaseOwner: string;
    expectedVersion: number;
    leaseSeconds: number;
  }): Promise<FinalizedIngestionEvent> {
    const event = this.events.get(input.eventId);
    if (
      !event ||
      event.finalizedTurnId !== input.finalizedTurnId ||
      event.status !== "processing" ||
      event.leaseOwner !== input.leaseOwner ||
      !event.leaseExpiresAt ||
      new Date(event.leaseExpiresAt).getTime() <= Date.now() ||
      event.version !== input.expectedVersion
    ) {
      throw new Error(`Finalized ingestion event '${input.eventId}' lease could not be renewed.`);
    }
    event.leaseExpiresAt = new Date(
      Date.now() + Math.max(1, Math.trunc(input.leaseSeconds)) * 1000
    ).toISOString();
    event.updatedAt = new Date().toISOString();
    event.version += 1;
    this.refreshAggregate(input.finalizedTurnId);
    return cloneEvent(event);
  }

  async listMissingAdmissions(): Promise<MissingFinalizedConversationTurn[]> {
    return [];
  }

  async listNonTerminalTurns(_limit = 100): Promise<FinalizedIngestionTurn[]> {
    return Array.from(this.turns.values())
      .filter(
        (turn) =>
          turn.status !== "complete" &&
          turn.status !== "skipped" &&
          turn.status !== "terminal_failed"
      )
      .map(cloneTurn);
  }

  private listEventsSync(finalizedTurnId: string): FinalizedIngestionEvent[] {
    return Array.from(this.events.values())
      .filter((event) => event.finalizedTurnId === finalizedTurnId)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId)
      )
      .map(cloneEvent);
  }

  private refreshAggregate(finalizedTurnId: string): void {
    const turn = this.turns.get(finalizedTurnId);
    if (!turn) return;
    const events = this.listEventsSync(finalizedTurnId);
    turn.eligibleEventCount = events.length;
    turn.pendingEventCount = events.filter((event) => event.status === "pending").length;
    turn.processingEventCount = events.filter((event) => event.status === "processing").length;
    turn.completeEventCount = events.filter((event) => event.status === "complete").length;
    turn.unchangedEventCount = events.filter((event) => event.status === "unchanged").length;
    turn.failedEventCount = events.filter((event) =>
      ["retryable_failed", "terminal_failed"].includes(event.status)
    ).length;
    turn.ambiguousEventCount = events.filter(
      (event) => event.status === "reconcile_required"
    ).length;
    turn.skippedEventCount = events.filter((event) => event.status === "skipped").length;
    if (!turn.ingestionRequested) {
      turn.status = "skipped";
    } else if (turn.status === "terminal_failed" && turn.lastErrorCode) {
      turn.status = "terminal_failed";
    } else if (events.length === 0) {
      turn.status = "skipped";
    } else if (turn.ambiguousEventCount > 0) {
      turn.status = "reconcile_required";
    } else if (events.some((event) => event.status === "retryable_failed")) {
      turn.status = "retryable_failed";
    } else if (events.some((event) => event.status === "processing")) {
      turn.status = "processing";
    } else if (turn.completeEventCount + turn.unchangedEventCount === events.length) {
      turn.status = "complete";
      turn.completedAt ??= new Date().toISOString();
    } else if (
      turn.completeEventCount + turn.unchangedEventCount + turn.skippedEventCount ===
      events.length
    ) {
      turn.status =
        turn.completeEventCount + turn.unchangedEventCount === 0 ? "skipped" : "partial";
    } else if (
      turn.failedEventCount > 0 &&
      turn.pendingEventCount + turn.processingEventCount === 0
    ) {
      turn.status =
        turn.completeEventCount + turn.unchangedEventCount > 0 ? "partial" : "terminal_failed";
    } else if (
      turn.failedEventCount > 0 ||
      turn.completeEventCount + turn.unchangedEventCount > 0
    ) {
      turn.status = "partial";
    } else {
      turn.status = "pending";
    }
    turn.updatedAt = new Date().toISOString();
    turn.version += 1;
  }
}

export class FinalizedIngestionService implements FinalizedIngestionPort {
  constructor(
    private readonly repository: FinalizedIngestionRepository,
    private readonly ingestionPolicy: Pick<
      MemoryIngestionPolicy,
      "build"
    > = new MemoryIngestionPolicy()
  ) {}

  async admit(input: FinalizedIngestionAdmissionInput): Promise<FinalizedIngestionAdmission> {
    const existing = await this.repository.getTurn(input.finalizedTurnId);
    if (existing) {
      return {
        turn: existing,
        events: await this.repository.listEvents(input.finalizedTurnId)
      };
    }
    const now = new Date().toISOString();
    const identity = resolveMem0ChatIdentity({
      subjectUserId: input.subjectUserId,
      personaId: input.personaId
    });
    const memoryScope = identity.ok ? buildChatMemoryScope(identity.identity) : null;
    const sourceDigest = digestSource(input, memoryScope);
    const baseTurn = {
      finalizedTurnId: input.finalizedTurnId,
      assistantMessageId: input.assistantMessageId,
      sourceUserEventId: input.sourceUserEventId ?? null,
      conversationId: input.conversationId,
      traceId: input.traceId,
      personaId: input.personaId ?? null,
      subjectUserId: input.subjectUserId ?? null,
      memoryScope,
      finalizedAt: input.finalizedAt,
      ingestionRequested: input.ingestionRequested,
      ingestionSkipReason: null,
      failureStage: null,
      status: "pending" as FinalizedIngestionTurnStatus,
      policyVersion: FINALIZED_INGESTION_POLICY_VERSION,
      sourceDigest,
      eligibleEventCount: 0,
      pendingEventCount: 0,
      processingEventCount: 0,
      completeEventCount: 0,
      unchangedEventCount: 0,
      failedEventCount: 0,
      ambiguousEventCount: 0,
      skippedEventCount: 0,
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      completedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now
    } satisfies FinalizedIngestionTurn;

    if (!input.ingestionRequested) {
      return this.repository.admit({
        turn: {
          ...baseTurn,
          status: "skipped",
          ingestionSkipReason: "memory-disabled"
        },
        events: []
      });
    }

    const turnKind =
      input.turnKind ??
      classifyMem0Turn({
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        cancelledOrFailed: false
      });
    if (turnKind === "explicit_forget" || detectExplicitForgetRequest(input.userMessage)) {
      return this.repository.admit({
        turn: {
          ...baseTurn,
          status: "skipped",
          ingestionSkipReason: "explicit-forget-skips-add"
        },
        events: []
      });
    }

    if (!identity.ok) {
      return this.repository.admit({
        turn: {
          ...baseTurn,
          status: "terminal_failed",
          lastErrorCode: MEMORY_SCOPE_MISSING,
          lastErrorMessage: `Required memory identity is missing: ${identity.missing.join(", ")}.`
        },
        events: []
      });
    }

    const ingestionInput: MemoryIngestionInput = {
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      scope: memoryScope!,
      sessionId: input.sessionId ?? input.conversationId,
      personaId: input.personaId,
      subjectUserId: input.subjectUserId,
      userMessageId: input.sourceUserEventId,
      assistantMessageId: input.assistantMessageId,
      traceId: input.traceId,
      conversationId: input.conversationId,
      language: input.language,
      observedAt: input.finalizedAt,
      turnKind,
      idempotencyKey: input.finalizedTurnId
    };
    let extraction: Awaited<ReturnType<typeof this.ingestionPolicy.build>>;
    try {
      extraction = await this.ingestionPolicy.build(ingestionInput);
    } catch {
      return this.repository.admit({
        turn: {
          ...baseTurn,
          status: "terminal_failed",
          failureStage: "materialization",
          lastErrorCode: "MEMORY_MATERIALIZATION_FAILED",
          lastErrorMessage: "Memory materialization policy build failed."
        },
        events: []
      });
    }
    if (extraction.events.length === 0) {
      return this.repository.admit({
        turn: {
          ...baseTurn,
          status: "skipped",
          ingestionSkipReason: extraction.skippedReason ?? "no-factual-memory"
        },
        events: []
      });
    }

    const materialized = extraction.events.map((event) =>
      materializeEvent(input.finalizedTurnId, event)
    );
    return this.repository.admit({
      turn: {
        ...baseTurn,
        eligibleEventCount: materialized.length,
        pendingEventCount: materialized.length
      },
      events: materialized
    });
  }

  recordEventOutcome(input: Parameters<FinalizedIngestionRepository["recordEventOutcome"]>[0]) {
    return this.repository.recordEventOutcome(input);
  }

  claimEvent(input: Parameters<FinalizedIngestionRepository["claimEvent"]>[0]) {
    return this.repository.claimEvent(input);
  }

  markEventDispatchStarted(
    input: Parameters<FinalizedIngestionRepository["markEventDispatchStarted"]>[0]
  ) {
    return this.repository.markEventDispatchStarted(input);
  }

  reclaimExpiredEvent(input: Parameters<FinalizedIngestionRepository["reclaimExpiredEvent"]>[0]) {
    return this.repository.reclaimExpiredEvent(input);
  }

  renewLease(input: Parameters<FinalizedIngestionRepository["renewLease"]>[0]) {
    return this.repository.renewLease(input);
  }
}

export function createFinalizedIngestionRepositoryFromEnv(
  env: Record<string, string | undefined> = process.env,
  sharedClient?: DatabaseClient
): FinalizedIngestionRepository {
  const explicit = env["LEDGER_REPOSITORY"]?.trim().toLowerCase();
  const kind = explicit
    ? explicit === "postgres"
      ? "postgres"
      : explicit === "memory" || explicit === "in-memory"
        ? "in-memory"
        : (() => {
            throw new Error(
              `Invalid LEDGER_REPOSITORY value '${env["LEDGER_REPOSITORY"]?.trim()}'. Valid values are: in-memory, memory, postgres.`
            );
          })()
    : parseMemoryRepositoryEnv(env).kind;
  if (kind === "postgres") {
    if (sharedClient) return new PostgresFinalizedIngestionRepository(sharedClient);
    if (!env["DATABASE_URL"]) {
      throw new Error("LEDGER_REPOSITORY=postgres requires DATABASE_URL.");
    }
    return new PostgresFinalizedIngestionRepository(env["DATABASE_URL"]);
  }
  return new InMemoryFinalizedIngestionRepository();
}

function materializeEvent(
  finalizedTurnId: string,
  event: MemoryWriteEventInput
): {
  eventId: string;
  eventKey: string;
  backendIdempotencyKey: string;
  eventPayload: FinalizedIngestionEventPayload;
} {
  const payload = withoutSignal(event);
  const eventKey = `event:${sha256(canonicalJson(payload))}`;
  const eventId = `${finalizedTurnId}:${eventKey}`;
  return {
    eventId,
    eventKey,
    backendIdempotencyKey: `yuvi:finalized-turn:${finalizedTurnId}:event:${eventKey.slice("event:".length)}`,
    eventPayload: {
      ...payload,
      payloadDigest: sha256(canonicalJson(payload)),
      idempotencyKey: `yuvi:finalized-turn:${finalizedTurnId}:event:${eventKey.slice("event:".length)}`
    }
  };
}

function withoutSignal(event: MemoryWriteEventInput): FinalizedIngestionEventPayload {
  const { signal: _signal, ...payload } = event;
  return payload;
}

function digestSource(input: FinalizedIngestionAdmissionInput, memoryScope: string | null): string {
  return sha256(
    canonicalJson({
      finalizedTurnId: input.finalizedTurnId,
      assistantMessageId: input.assistantMessageId,
      sourceUserEventId: input.sourceUserEventId ?? null,
      conversationId: input.conversationId,
      traceId: input.traceId,
      personaId: input.personaId ?? null,
      subjectUserId: input.subjectUserId ?? null,
      memoryScope,
      finalizedAt: input.finalizedAt,
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      policyVersion: FINALIZED_INGESTION_POLICY_VERSION
    })
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapOutcome(
  outcome: Parameters<FinalizedIngestionRepository["recordEventOutcome"]>[0]["outcome"]
): {
  status: FinalizedIngestionEventStatus;
  resultKind: FinalizedIngestionEvent["resultKind"];
  backendMemoryId: string | null;
  backendOperation: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextAttemptAt: string | null;
} {
  if (outcome.status === "written") {
    return {
      status: "complete",
      resultKind: "written",
      backendMemoryId: outcome.eventId ?? null,
      backendOperation: outcome.status,
      errorCode: null,
      errorMessage: null,
      nextAttemptAt: null
    };
  }
  if (outcome.status === "unchanged") {
    return {
      status: "unchanged",
      resultKind: "unchanged",
      backendMemoryId: outcome.eventId ?? null,
      backendOperation: outcome.status,
      errorCode: null,
      errorMessage: null,
      nextAttemptAt: null
    };
  }
  if (outcome.status === "retryable_failed") {
    return {
      status: "retryable_failed",
      resultKind: "rejected",
      backendMemoryId: null,
      backendOperation: null,
      errorCode: outcome.errorCode ?? "MEMORY_WRITE_RETRYABLE_FAILED",
      errorMessage: outcome.errorMessage ?? null,
      nextAttemptAt: outcome.nextAttemptAt ?? null
    };
  }
  if (outcome.status === "ambiguous") {
    return {
      status: "reconcile_required",
      resultKind: "ambiguous",
      backendMemoryId: null,
      backendOperation: null,
      errorCode: outcome.errorCode ?? "MEMORY_WRITE_AMBIGUOUS",
      errorMessage: outcome.errorMessage ?? null,
      nextAttemptAt: null
    };
  }
  if (outcome.status === "skipped") {
    return {
      status: "skipped",
      resultKind: "skipped",
      backendMemoryId: null,
      backendOperation: null,
      errorCode: outcome.errorCode ?? null,
      errorMessage: outcome.errorMessage ?? null,
      nextAttemptAt: null
    };
  }
  if (outcome.failureClass === "ambiguous") {
    return {
      status: "reconcile_required",
      resultKind: "ambiguous",
      backendMemoryId: null,
      backendOperation: null,
      errorCode: outcome.errorCode ?? "MEMORY_WRITE_AMBIGUOUS",
      errorMessage: null,
      nextAttemptAt: null
    };
  }
  if (outcome.failureClass === "retryable_no_effect") {
    return {
      status: "retryable_failed",
      resultKind: "rejected",
      backendMemoryId: null,
      backendOperation: null,
      errorCode: outcome.errorCode ?? "MEMORY_WRITE_RETRYABLE_FAILED",
      errorMessage: null,
      nextAttemptAt: null
    };
  }
  return {
    status: "terminal_failed",
    resultKind: "rejected",
    backendMemoryId: null,
    backendOperation: null,
    errorCode: outcome.errorCode ?? "MEMORY_WRITE_REJECTED",
    errorMessage: null,
    nextAttemptAt: null
  };
}

/**
 * Delivery outcomes require the durable dispatch marker. Definitive rejection
 * and skipped outcomes are non-dispatch terminal transitions and may be
 * recorded immediately after claim.
 */
function outcomeRequiresDispatchMarker(
  outcome: Parameters<FinalizedIngestionRepository["recordEventOutcome"]>[0]["outcome"]
): boolean {
  return (
    outcome.status !== "skipped" &&
    !(outcome.status === "rejected" && outcome.failureClass === "definitive_rejection")
  );
}

function mapTurnRow(row: QueryResultRow): FinalizedIngestionTurn {
  return {
    finalizedTurnId: String(row["finalized_turn_id"]),
    assistantMessageId: String(row["assistant_message_id"]),
    sourceUserEventId: nullableString(row["source_user_event_id"]),
    conversationId: String(row["conversation_id"]),
    traceId: String(row["trace_id"]),
    personaId: nullableString(row["persona_id"]),
    subjectUserId: nullableString(row["subject_user_id"]),
    memoryScope: nullableString(row["memory_scope"]),
    finalizedAt: toIsoString(row["finalized_at"]),
    ingestionRequested: Boolean(row["ingestion_requested"]),
    ingestionSkipReason: nullableString(row["ingestion_skip_reason"]),
    failureStage:
      row["failure_stage"] === null || row["failure_stage"] === undefined
        ? null
        : (String(row["failure_stage"]) as "materialization"),
    status: row["status"] as FinalizedIngestionTurnStatus,
    policyVersion: String(row["policy_version"]),
    sourceDigest: String(row["source_digest"]),
    eligibleEventCount: Number(row["eligible_event_count"]),
    pendingEventCount: Number(row["pending_event_count"]),
    processingEventCount: Number(row["processing_event_count"]),
    completeEventCount: Number(row["complete_event_count"]),
    unchangedEventCount: Number(row["unchanged_event_count"]),
    failedEventCount: Number(row["failed_event_count"]),
    ambiguousEventCount: Number(row["ambiguous_event_count"]),
    skippedEventCount: Number(row["skipped_event_count"]),
    attemptCount: Number(row["attempt_count"]),
    lastAttemptAt: nullableIsoString(row["last_attempt_at"]),
    nextAttemptAt: nullableIsoString(row["next_attempt_at"]),
    completedAt: nullableIsoString(row["completed_at"]),
    lastErrorCode: nullableString(row["last_error_code"]),
    lastErrorMessage: nullableString(row["last_error_message"]),
    leaseOwner: nullableString(row["lease_owner"]),
    leaseExpiresAt: nullableIsoString(row["lease_expires_at"]),
    version: Number(row["version"]),
    createdAt: toIsoString(row["created_at"]),
    updatedAt: toIsoString(row["updated_at"])
  };
}

function mapEventRow(row: QueryResultRow): FinalizedIngestionEvent {
  return {
    eventId: String(row["event_id"]),
    finalizedTurnId: String(row["finalized_turn_id"]),
    eventKey: String(row["event_key"]),
    backendIdempotencyKey: String(row["backend_idempotency_key"]),
    eventPayload: parsePayload(row["event_payload"]),
    status: row["status"] as FinalizedIngestionEventStatus,
    resultKind: (row["result_kind"] as FinalizedIngestionEvent["resultKind"]) ?? null,
    attemptCount: Number(row["attempt_count"]),
    lastAttemptAt: nullableIsoString(row["last_attempt_at"]),
    dispatchStartedAt: nullableIsoString(row["dispatch_started_at"]),
    nextAttemptAt: nullableIsoString(row["next_attempt_at"]),
    backendMemoryId: nullableString(row["backend_memory_id"]),
    backendOperation: nullableString(row["backend_operation"]),
    errorCode: nullableString(row["error_code"]),
    errorMessage: nullableString(row["error_message"]),
    leaseOwner: nullableString(row["lease_owner"]),
    leaseExpiresAt: nullableIsoString(row["lease_expires_at"]),
    version: Number(row["version"]),
    createdAt: toIsoString(row["created_at"]),
    updatedAt: toIsoString(row["updated_at"])
  };
}

function mapMissingRow(row: QueryResultRow): MissingFinalizedConversationTurn {
  return {
    finalizedTurnId: String(row["finalized_turn_id"]),
    assistantMessageId: String(row["assistant_message_id"]),
    sourceUserEventId: nullableString(row["source_user_event_id"]),
    conversationId: String(row["conversation_id"]),
    traceId: String(row["trace_id"]),
    personaId: nullableString(row["persona_id"]),
    subjectUserId: nullableString(row["subject_user_id"]),
    content: String(row["content"]),
    status: "completed",
    finalizedAt: toIsoString(row["finalized_at"]),
    ingestionRequested:
      row["ingestion_requested"] === null || row["ingestion_requested"] === undefined
        ? null
        : Boolean(row["ingestion_requested"])
  };
}

function parsePayload(value: unknown): FinalizedIngestionEventPayload {
  if (typeof value === "string") return JSON.parse(value) as FinalizedIngestionEventPayload;
  return { ...(value as FinalizedIngestionEventPayload) };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toIsoString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIsoString(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoString(value);
}

function cloneTurn(turn: FinalizedIngestionTurn): FinalizedIngestionTurn {
  return { ...turn };
}

function cloneEvent(event: FinalizedIngestionEvent): FinalizedIngestionEvent {
  return { ...event, eventPayload: JSON.parse(JSON.stringify(event.eventPayload)) };
}

function clampLimit(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), 1000);
}
