/**
 * Vendor-neutral, runtime-facing memory contracts.
 *
 * MemoryBackend remains the storage contract. These types describe evidence
 * that a Runtime can retrieve and write without depending on Mem0, a sidecar
 * DTO, PromptBuilder, or any Runtime state engine.
 *
 * Memory is evidence about what happened. It is not authoritative Persona,
 * Affect, Relationship, Interest, or Commitment state.
 */

/**
 * Opaque canonical identity for a MemoryEvent.
 *
 * The concrete encoding is intentionally not frozen here. Providers must keep
 * it stable, deterministic, resolvable, and independent of rank, array
 * position, or prompt position.
 */
export type MemoryEventId = string;

/** Evidence-oriented kinds; authoritative Runtime state is deliberately absent. */
export type MemoryEventKind =
  | "episodic"
  | "fact"
  | "user_claim"
  | "interaction"
  | "correction"
  | "commitment_evidence";

/** Stable provider/source identifier, such as "mem0" or "legacy". */
export type MemoryEventSource = string;

export type MemoryEventAssertionSource = "user" | "assistant" | "mixed" | "system" | "unknown";

export type MemoryEventVerification = "unverified" | "verified" | "unknown";

export type MemoryEventAssertion = {
  source: MemoryEventAssertionSource;
  verification: MemoryEventVerification;
};

/**
 * Canonical evidence object.
 *
 * Timestamps are optional because an absent source timestamp is unknown; it
 * must never be replaced with the current time. Metadata is preservation
 * metadata only and must not be treated as authoritative Runtime state.
 */
export type MemoryEvent = {
  id: MemoryEventId;
  kind: MemoryEventKind;
  content: string;

  source: MemoryEventSource;
  sourceRecordId: string;
  scope?: string | null;

  /** Time the source recorded this evidence, when the source supplied one. */
  recordedAt?: string | null;
  observedAt?: string | null;
  occurredAt?: string | null;

  sourceTurnIds?: string[];
  conversationId?: string | null;
  participants?: string[];

  assertion?: MemoryEventAssertion;
  confidence?: number | null;

  /** Non-authoritative evidence metadata; never Runtime state. */
  metadata: Record<string, unknown>;
};

export type MemoryRetrievalInput = {
  text: string;
  limit?: number;
  scope?: string | null;
  personaId?: string | null;
  subjectUserId?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
  signal?: AbortSignal;
};

export type MemoryGetEventInput = {
  id: MemoryEventId;
  /** Required so a provider can enforce tenant/character isolation on reads. */
  scope: string;
  signal?: AbortSignal;
};

export type MemoryRetrievalStatus = "ok" | "empty" | "unavailable" | "error" | "partial";

/**
 * Retrieval result plus its epistemic status.
 *
 * "empty" means this retrieval completed without a relevant hit. It does not
 * assert that the database contains no matching memory. "unavailable" and
 * "error" must not be collapsed into "empty" by a Runtime caller.
 */
export type MemoryRetrievalOutcome = {
  status: MemoryRetrievalStatus;
  events: MemoryEvent[];
  source: MemoryEventSource;
  limited: boolean;
  limitReason?: string | null;
  rawCount?: number;
  selectedCount?: number;
  errorCode?: string | null;
};

export type MemoryWriteEventInput = {
  kind: MemoryEventKind;
  content: string;
  scope: string;
  observedAt?: string | null;
  occurredAt?: string | null;
  sourceTurnIds?: string[];
  conversationId?: string | null;
  idempotencyKey?: string | null;
  participants?: string[];
  assertion?: MemoryEventAssertion;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type MemoryWriteEventStatus = "written" | "unchanged" | "rejected";

export type MemoryWriteEventOutcome = {
  status: MemoryWriteEventStatus;
  /** Stable provider identity is retained even when the backend omits a record. */
  eventId?: MemoryEventId;
  event?: MemoryEvent | null;
  errorCode?: string | null;
};

/** Outcome of a completed runtime conversation turn crossing semantic memory. */
export type MemoryConversationTurnWriteStatus = "complete" | "partial" | "failed" | "skipped";

/**
 * `ok` is retained for compatibility, but is true only when every eligible
 * event was written or deduplicated. Partial persistence is never success.
 */
export type MemoryConversationTurnWriteResult = {
  status: MemoryConversationTurnWriteStatus;
  ok: boolean;
  attemptedCount: number;
  writtenCount: number;
  rejectedCount: number;
  deduplicatedCount: number;
  skippedCount: number;
  skippedReason?: string | undefined;
  errorCode?: string | undefined;
  rejectedReasons?: string[] | undefined;
  /** Compatibility alias for the total persisted (written or unchanged) count. */
  storedCount?: number | undefined;
  memoryId?: string | undefined;
  operation?: string | undefined;
  turnKind?: string | undefined;
  infer?: boolean | undefined;
  /** Runtime-lifetime idempotency identity, when supplied by the caller. */
  idempotencyKey?: string | undefined;
};

/**
 * Runtime-facing semantic memory boundary.
 *
 * This interface intentionally excludes physical admin delete, repair,
 * rollback, history maintenance, PromptBuilder, and vendor-specific types.
 */
export interface MemoryProvider {
  retrieveRelevant(input: MemoryRetrievalInput): Promise<MemoryRetrievalOutcome>;
  getEvent(input: MemoryGetEventInput): Promise<MemoryEvent | null>;
  writeEvent(input: MemoryWriteEventInput): Promise<MemoryWriteEventOutcome>;
}
