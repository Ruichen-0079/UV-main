import { describe, expect, it, vi } from "vitest";
import {
  FinalizedIngestionService,
  InMemoryFinalizedIngestionRepository
} from "./finalized-ingestion-ledger.js";
import { executeFinalizedIngestionEvent } from "./finalized-ingestion-executor.js";
import type { MemoryProvider } from "./provider.js";

const base = {
  finalizedTurnId: "finalized-turn:executor",
  assistantMessageId: "assistant:executor",
  sourceUserEventId: "user:executor",
  conversationId: "conversation:executor",
  traceId: "trace:executor",
  personaId: "alice",
  subjectUserId: "user-a",
  finalizedAt: "2026-08-12T00:00:00.000Z",
  ingestionRequested: true,
  userMessage: "I prefer concise replies.",
  assistantMessage: "Understood."
};

function provider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    retrieveRelevant: vi.fn(async () => ({
      status: "empty" as const,
      events: [],
      source: "test",
      limited: false
    })),
    getEvent: vi.fn(async () => null),
    writeEvent: vi.fn(async () => ({ status: "rejected" as const })),
    writeEventIdempotent: vi.fn(async () => ({ status: "written" as const, eventId: "mem0:one" })),
    ...overrides
  };
}

describe("shared finalized ingestion executor", () => {
  it("marks dispatch before one idempotent provider call and records the fenced outcome", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository).admit(base);
    const write = vi.fn(
      async (_input: Parameters<NonNullable<MemoryProvider["writeEventIdempotent"]>>[0]) => ({
        status: "written" as const,
        eventId: "mem0:one"
      })
    );
    const result = await executeFinalizedIngestionEvent({
      repository,
      provider: provider({ writeEventIdempotent: write }),
      event: admitted.events[0]!,
      leaseOwner: "worker-a",
      leaseSeconds: 30
    });
    expect(result).toMatchObject({
      claimed: true,
      dispatched: true,
      event: { status: "complete" }
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toMatchObject({
      idempotencyKey: admitted.events[0]!.backendIdempotencyKey,
      payloadDigest: admitted.events[0]!.eventPayload.payloadDigest
    });
  });

  it("fails closed when materialization has no exact payload digest", async () => {
    const sourceRepository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(sourceRepository).admit(base);
    const event = admitted.events[0]!;
    const payload = { ...event.eventPayload };
    delete payload.payloadDigest;
    const repository = new InMemoryFinalizedIngestionRepository();
    await repository.admit({
      turn: admitted.turn,
      events: [
        {
          eventId: event.eventId,
          eventKey: event.eventKey,
          backendIdempotencyKey: event.backendIdempotencyKey,
          eventPayload: payload
        }
      ]
    });
    const persistedEvent = (await repository.listEvents(admitted.turn.finalizedTurnId))[0]!;
    const write = vi.fn();
    const result = await executeFinalizedIngestionEvent({
      repository,
      provider: provider({ writeEventIdempotent: write }),
      event: persistedEvent,
      leaseOwner: "worker-a",
      leaseSeconds: 30
    });
    expect(write).not.toHaveBeenCalled();
    expect(result.event).toMatchObject({
      status: "terminal_failed",
      errorCode: "MEMORY_PAYLOAD_DIGEST_MISSING"
    });
  });

  it("fails closed when keyed backend submission is unavailable", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const admitted = await new FinalizedIngestionService(repository).admit(base);
    const unsupported = provider();
    delete unsupported.writeEventIdempotent;
    const result = await executeFinalizedIngestionEvent({
      repository,
      provider: unsupported,
      event: admitted.events[0]!,
      leaseOwner: "worker-a",
      leaseSeconds: 30
    });
    expect(result.event).toMatchObject({
      status: "terminal_failed",
      errorCode: "MEMORY_IDEMPOTENCY_UNSUPPORTED"
    });
  });
});
