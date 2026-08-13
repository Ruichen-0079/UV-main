import type {
  FinalizedIngestionEvent,
  FinalizedIngestionRepository,
  FinalizedIngestionEventOutcome
} from "./finalized-ingestion-ledger.js";
import type { MemoryProvider } from "./provider.js";

export type FinalizedIngestionDeliveryResult = {
  claimed: boolean;
  dispatched: boolean;
  event: FinalizedIngestionEvent | null;
  outcome: FinalizedIngestionEventOutcome | null;
};

export async function executeFinalizedIngestionEvent(input: {
  repository: Pick<
    FinalizedIngestionRepository,
    "claimEvent" | "markEventDispatchStarted" | "recordEventOutcome"
  >;
  provider: MemoryProvider;
  event: FinalizedIngestionEvent;
  leaseOwner: string;
  leaseSeconds: number;
}): Promise<FinalizedIngestionDeliveryResult> {
  const claimed = await input.repository.claimEvent({
    finalizedTurnId: input.event.finalizedTurnId,
    eventId: input.event.eventId,
    leaseOwner: input.leaseOwner,
    leaseSeconds: input.leaseSeconds,
    expectedVersion: input.event.version
  });
  if (!claimed) {
    return { claimed: false, dispatched: false, event: null, outcome: null };
  }

  if (!input.provider.writeEventIdempotent) {
    const outcome: FinalizedIngestionEventOutcome = {
      status: "rejected",
      errorCode: "MEMORY_IDEMPOTENCY_UNSUPPORTED",
      failureClass: "definitive_rejection"
    };
    const recorded = await input.repository.recordEventOutcome({
      finalizedTurnId: claimed.finalizedTurnId,
      eventId: claimed.eventId,
      leaseOwner: input.leaseOwner,
      expectedVersion: claimed.version,
      outcome
    });
    return { claimed: true, dispatched: false, event: recorded, outcome };
  }

  const payloadDigest = claimed.eventPayload.payloadDigest?.trim();
  if (!payloadDigest) {
    const outcome: FinalizedIngestionEventOutcome = {
      status: "rejected",
      errorCode: "MEMORY_PAYLOAD_DIGEST_MISSING",
      failureClass: "definitive_rejection"
    };
    const recorded = await input.repository.recordEventOutcome({
      finalizedTurnId: claimed.finalizedTurnId,
      eventId: claimed.eventId,
      leaseOwner: input.leaseOwner,
      expectedVersion: claimed.version,
      outcome
    });
    return { claimed: true, dispatched: false, event: recorded, outcome };
  }

  const dispatching = await input.repository.markEventDispatchStarted({
    finalizedTurnId: claimed.finalizedTurnId,
    eventId: claimed.eventId,
    leaseOwner: input.leaseOwner,
    expectedVersion: claimed.version
  });
  if (!dispatching) {
    return { claimed: true, dispatched: false, event: null, outcome: null };
  }

  let outcome: FinalizedIngestionEventOutcome;
  try {
    outcome = await input.provider.writeEventIdempotent({
      ...dispatching.eventPayload,
      idempotencyKey: dispatching.backendIdempotencyKey,
      payloadDigest
    });
  } catch (error) {
    outcome = {
      status: "ambiguous",
      errorCode: "MEMORY_WRITE_AMBIGUOUS",
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }

  const recorded = await input.repository.recordEventOutcome({
    finalizedTurnId: dispatching.finalizedTurnId,
    eventId: dispatching.eventId,
    leaseOwner: input.leaseOwner,
    expectedVersion: dispatching.version,
    outcome
  });
  return { claimed: true, dispatched: true, event: recorded, outcome };
}
