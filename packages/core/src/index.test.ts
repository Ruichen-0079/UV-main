import { InMemoryEventBus } from "@companion/event-bus";
import {
  InMemoryConversationRepository,
  FinalizedIngestionService,
  InMemoryFinalizedIngestionRepository,
  type MemoryConversationTurnWriteResult,
  type Memory,
  type MemoryCandidate,
  type MemoryWriteEventInput
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  ProviderError,
  ProviderErrorCode,
  FallbackChatProvider,
  createMockAssistantContinuationProvider,
  type ChatStreamEvent,
  type ChatOutput,
  type ChatProvider,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockStreamingChatProvider as createRawMockStreamingChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider,
  type ChatInput,
  type ChatStreamOptions,
  type AssistantContinuationInput,
  type MockStreamingChatProviderOptions,
  type ProactiveDecisionInput,
} from "@companion/providers";
import { createEvent, type RuntimeEvent } from "@companion/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeOrchestrator,
  type RuntimeMemoryPort,
  type RuntimeReplyStreamEvent
} from "./index.js";

async function collectRuntimeStream(
  stream: AsyncIterable<RuntimeReplyStreamEvent>,
  onEvent?: (event: RuntimeReplyStreamEvent) => void
): Promise<RuntimeReplyStreamEvent[]> {
  const events: RuntimeReplyStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value);
    },
    reject(reason?: unknown): void {
      rejectPromise?.(reason);
    }
  };
}

async function appendCompletedConversationMessage(
  conversation: InMemoryConversationRepository,
  input: {
    id: string;
    sessionId: string;
    traceId: string;
    role: "user" | "assistant";
    content: string;
    sourceUserEventId?: string | null;
    metadata?: Record<string, unknown>;
    timestampMs?: number;
  }
): Promise<void> {
  const timestamp = new Date(input.timestampMs ?? 0).toISOString();
  await conversation.ensureSession(input.sessionId);
  await conversation.appendMessage({
    id: input.id,
    sessionId: input.sessionId,
    traceId: input.traceId,
    parentMessageId: null,
    sourceUserEventId: input.sourceUserEventId ?? null,
    role: input.role,
    content: input.content,
    status: "completed",
    createdAt: timestamp,
    completedAt: timestamp,
    metadata: input.metadata ?? {}
  });
}

describe("RuntimeOrchestrator", () => {

  it("tracks one finalized non-stream Mem0 write with canonical IDs", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const writes: Array<Record<string, unknown>> = [];
    const memory = createMem0RecordingMemory(async (input) => {
      writes.push(input);
      return completeMemoryWrite(
        typeof input["idempotencyKey"] === "string" ? input["idempotencyKey"] : undefined
      );
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory,
      conversation: new InMemoryConversationRepository(),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "non-stream-finalized",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    const assistant = published.find((event) => event.type === "assistant.message");
    expect(assistant?.id).toBe(
      `assistant:${published.find((event) => event.type === "user.message")?.id}`
    );
    expect(published.find((event) => event.type === "agent.reply")?.id).toBe(
      `reply:${published.find((event) => event.type === "user.message")?.id}`
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      assistantMessageId: assistant?.id,
      idempotencyKey: `yuvi:finalized-turn:${assistant?.id}`,
      assistantMessage: reply.payload.content
    });
    expect(runtime.getLatestPromptPreview()).toMatchObject({ memoryWriteStatus: "complete" });
  });

  it("admits finalized memory through the ledger before publishing the assistant event", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const providerWrites: MemoryWriteEventInput[] = [];
    const memory = createMem0RecordingMemory(async () => completeMemoryWrite());
    memory.getMemoryProvider = () => ({
      async retrieveRelevant() {
        return { status: "empty", events: [], source: "test", limited: false };
      },
      async getEvent() {
        return null;
      },
      async writeEvent(input) {
        providerWrites.push(input);
        return { status: "written", eventId: "memory:ledger-test" };
      },
      async writeEventIdempotent(input) {
        providerWrites.push(input);
        return { status: "written", eventId: "memory:ledger-test" };
      }
    });
    const conversation = new InMemoryConversationRepository();
    const ledger = new InMemoryFinalizedIngestionRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory,
      conversation,
      finalizedIngestion: new FinalizedIngestionService(ledger),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "ledger-runtime-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    const sourceUserEventId = reply.parentId;
    const assistant = await conversation.getMessageById(`assistant:${sourceUserEventId}`);
    const turn = assistant?.finalizedTurnId
      ? await ledger.getTurn(assistant.finalizedTurnId)
      : null;
    expect(assistant?.finalizedTurnId).toBeTruthy();
    expect(turn?.status).toBe("complete");
    expect(providerWrites).toHaveLength(1);
    expect(
      providerWrites[0]?.idempotencyKey?.startsWith(
        `yuvi:finalized-turn:${assistant?.finalizedTurnId}:event:`
      )
    ).toBe(true);
    expect(published.findIndex((event) => event.type === "assistant.message")).toBeGreaterThan(
      published.findIndex((event) => event.type === "agent.reply")
    );
  });

  it("keeps assistant success independent when ledger materialization fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const ledger = new InMemoryFinalizedIngestionRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createMem0RecordingMemory(async () => completeMemoryWrite()),
      conversation: new InMemoryConversationRepository(),
      finalizedIngestion: new FinalizedIngestionService(ledger, {
        async build() {
          throw new Error("policy build failed");
        }
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await runtime.handleUserMessage({
      sessionId: "materialization-failure-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    expect(published.some((event) => event.type === "assistant.message")).toBe(true);
    expect(published.some((event) => event.type === "runtime.error")).toBe(true);
    expect(await ledger.listNonTerminalTurns()).toEqual([]);
  });

  it("submits every persisted child from a successful multi-event live turn", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const providerWrites: MemoryWriteEventInput[] = [];
    const memory = createMem0RecordingMemory(async () => completeMemoryWrite());
    memory.getMemoryProvider = () => ({
      async retrieveRelevant() {
        return { status: "empty", events: [], source: "test", limited: false };
      },
      async getEvent() {
        return null;
      },
      async writeEvent(input) {
        providerWrites.push(input);
        return { status: "written", eventId: `memory:${providerWrites.length}` };
      },
      async writeEventIdempotent(input) {
        providerWrites.push(input);
        return { status: "written", eventId: `memory:${providerWrites.length}` };
      }
    });
    const ledger = new InMemoryFinalizedIngestionRepository();
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory,
      conversation,
      finalizedIngestion: new FinalizedIngestionService(ledger, {
        async build() {
          return {
            turnKind: "normal" as const,
            events: [
              {
                kind: "fact" as const,
                content: "The user prefers concise replies.",
                scope: "user:user-a:persona:alice",
                metadata: {}
              },
              {
                kind: "fact" as const,
                content: "The user prefers written examples.",
                scope: "user:user-a:persona:alice",
                metadata: {}
              }
            ]
          };
        }
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "multi-event-live-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    const assistant = await conversation.getMessageById(`assistant:${reply.parentId}`);
    expect(assistant?.role).toBe("assistant");
    const turns = await ledger.listNonTerminalTurns();
    expect(providerWrites).toHaveLength(2);
    expect(new Set(providerWrites.map((input) => input.idempotencyKey)).size).toBe(2);
    expect(turns).toEqual([]);
    expect(reply.parentId).toBeTruthy();
  });

  it("keeps a durable reconcile_required child out of complete status on re-entry", async () => {
    const fixture = await createFinalizedStatusFixture("reconcile", 1);
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[0]!,
      {
        status: "ambiguous",
        errorCode: "MEMORY_WRITE_AMBIGUOUS"
      }
    );

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "partial", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
    expect((await fixture.repository.getTurn(fixture.turnId))?.status).toBe("reconcile_required");
  });

  it("keeps a durable processing child out of complete status on re-entry", async () => {
    const fixture = await createFinalizedStatusFixture("processing", 1);
    await fixture.repository.claimEvent({
      finalizedTurnId: fixture.turnId,
      eventId: fixture.admitted.events[0]!.eventId,
      leaseOwner: "live-owner",
      leaseSeconds: 300,
      expectedVersion: fixture.admitted.events[0]!.version
    });

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "partial", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
  });

  it("keeps a partial parent with one reconcile child out of complete status", async () => {
    const fixture = await createFinalizedStatusFixture("partial", 2);
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[0]!,
      {
        status: "written",
        eventId: "memory:complete-child"
      }
    );
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[1]!,
      {
        status: "ambiguous",
        errorCode: "MEMORY_WRITE_AMBIGUOUS"
      }
    );

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "partial", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
    expect((await fixture.repository.getTurn(fixture.turnId))?.status).toBe("reconcile_required");
  });

  it("keeps terminal_failed out of successful status", async () => {
    const repository = new InMemoryFinalizedIngestionRepository();
    const service = new FinalizedIngestionService(repository);
    const turnId = "finalized-turn:terminal";
    const admitted = await service.admit({
      ...finalizedStatusAdmission(turnId),
      personaId: null,
      ingestionRequested: true
    });
    const fixture = { repository, service, admitted, turnId };

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "failed", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
  });

  it("keeps a not-due retryable child out of complete status", async () => {
    const fixture = await createFinalizedStatusFixture("retryable", 1);
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[0]!,
      {
        status: "retryable_failed",
        errorCode: "MEMORY_WRITE_RETRYABLE_FAILED",
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString()
      }
    );

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "partial", ok: false });
    expect(result.status).not.toBe("complete");
    expect(result.ok).not.toBe(true);
  });

  it("keeps true durable complete status successful on re-entry", async () => {
    const fixture = await createFinalizedStatusFixture("complete", 1);
    await recordFinalizedEventOutcome(
      fixture.service,
      fixture.repository,
      fixture.admitted.events[0]!,
      {
        status: "written",
        eventId: "memory:complete"
      }
    );

    const result = await runFinalizedStatusSchedule(fixture);
    expect(result).toMatchObject({ status: "complete", ok: true });
  });

  it("deduplicates same finalized turn re-entry and drains delayed ingestion", async () => {
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Array<Record<string, unknown>> = [];
    const eventBus = new InMemoryEventBus({ development: false });
    const memory = createMem0RecordingMemory(async (input) => {
      calls.push(input);
      await delayed;
      return completeMemoryWrite(
        typeof input["idempotencyKey"] === "string" ? input["idempotencyKey"] : undefined
      );
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const userEvent = createEvent("user.message", {
      sessionId: "reentry-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });

    const first = runtime.handleUserMessage(userEvent);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const second = runtime.handleUserMessage(userEvent);
    await Promise.all([first, second]);
    expect(calls).toHaveLength(1);

    let drained = false;
    const drain = runtime.drainMemoryWrites().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await drain;
    expect(runtime.getLatestPromptPreview()).toMatchObject({ memoryWriteStatus: "complete" });
  });

  it("seals an in-flight runtime before reload and drains its late finalized write", async () => {
    let releaseReply!: () => void;
    const replyRelease = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    let replyPublished!: () => void;
    const replyEntered = new Promise<void>((resolve) => {
      replyPublished = resolve;
    });
    let releaseWrite!: () => void;
    const writeRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const writes: Array<Record<string, unknown>> = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("agent.reply", async () => {
      replyPublished();
      await replyRelease;
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        writeStarted();
        await writeRelease;
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const request = runtime.handleUserMessage({
      sessionId: "reload-race-session",
      content: "I prefer concise replies."
    });
    await replyEntered;
    const reload = runtime.sealAndDrainMemoryWrites();
    await Promise.resolve();
    expect(runtime.getLifecycleState()).toBe("sealing");
    expect(writes).toHaveLength(0);

    let reloaded = false;
    void reload.then(() => {
      reloaded = true;
    });
    releaseReply();
    await writeEntered;
    expect(writes).toHaveLength(1);
    expect(reloaded).toBe(false);
    releaseWrite();
    await expect(request).resolves.toMatchObject({ type: "agent.reply" });
    await reload;
    expect(reloaded).toBe(true);
    expect(runtime.getLifecycleState()).toBe("disposed");
    expect(writes).toHaveLength(1);
    await expect(runtime.drainMemoryWrites()).resolves.toEqual([]);
    await expect(
      runtime.handleUserMessage({
        sessionId: "replaced-runtime-session",
        content: "This runtime has been replaced."
      })
    ).rejects.toThrow("disposed");
  });

  it("lifecycle-guards direct maybeStoreMemory calls while active", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const { sourceEvent, reply } = createDirectMemoryTurn("direct-active-session");

    await expect(
      runtime.maybeStoreMemory(sourceEvent, reply, { readMemory: false, writeMemory: true })
    ).resolves.toMatchObject({ memoryWriteStatus: "complete" });
    expect(writes).toHaveLength(1);
    expect(runtime.getLifecycleState()).toBe("active");
  });

  it("waits for a direct maybeStoreMemory call that entered before sealing", async () => {
    let releaseWrite!: () => void;
    const writeRelease = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const writeEntered = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const writes: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        writeStarted();
        await writeRelease;
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const { sourceEvent, reply } = createDirectMemoryTurn("direct-seal-session");

    const directWrite = runtime.maybeStoreMemory(sourceEvent, reply);
    await writeEntered;
    const seal = runtime.sealAndDrainMemoryWrites();
    let sealed = false;
    void seal.then(() => {
      sealed = true;
    });
    await Promise.resolve();
    expect(runtime.getLifecycleState()).toBe("sealing");
    expect(sealed).toBe(false);
    expect(writes).toHaveLength(1);

    releaseWrite();
    await expect(directWrite).resolves.toMatchObject({ memoryWriteStatus: "complete" });
    await seal;
    expect(sealed).toBe(true);
    expect(runtime.getLifecycleState()).toBe("disposed");
    expect(writes).toHaveLength(1);
    await expect(runtime.drainMemoryWrites()).resolves.toEqual([]);
  });

  it("rejects direct maybeStoreMemory calls after sealing begins", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const { sourceEvent, reply } = createDirectMemoryTurn("direct-sealing-session");

    const seal = runtime.sealAndDrainMemoryWrites();
    await expect(runtime.maybeStoreMemory(sourceEvent, reply)).rejects.toThrow("sealing");
    expect(writes).toHaveLength(0);
    await seal;
    expect(runtime.getLifecycleState()).toBe("disposed");
  });

  it("rejects direct maybeStoreMemory calls after disposal", async () => {
    const writes: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    const { sourceEvent, reply } = createDirectMemoryTurn("direct-disposed-session");

    await runtime.sealAndDrainMemoryWrites();
    await expect(runtime.maybeStoreMemory(sourceEvent, reply)).rejects.toThrow("disposed");
    expect(writes).toHaveLength(0);
    await expect(runtime.drainMemoryWrites()).resolves.toEqual([]);
  });

  it("writes semantic memory once only after a successful stream finalizes", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        calls.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", { chunks: ["first", "second"] })
      }
    });
    const iterator = runtime
      .streamUserMessage(
        { sessionId: "stream-memory-session", content: "I prefer concise replies." },
        { readMemory: false, writeMemory: true }
      )
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text-delta", text: "first" }
    });
    expect(calls).toHaveLength(0);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text-delta", text: "second" }
    });
    const completed = await iterator.next();
    expect(completed.value).toMatchObject({ type: "completed", content: "firstsecond" });
    expect(calls).toHaveLength(1);
    await runtime.drainMemoryWrites();
    expect(runtime.getLatestPromptPreview()).toMatchObject({ memoryWriteStatus: "complete" });
  });

  it("performs one finalized ingestion after provider fallback before output", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const failing = createMockStreamingChatProvider("primary", {
      failBeforeFirst: new ProviderError({
        provider: "primary",
        capability: "chat",
        code: ProviderErrorCode.ProviderUnavailable,
        message: "primary unavailable"
      })
    });
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        calls.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          new FallbackChatProvider([
            failing,
            createMockStreamingChatProvider("backup", { chunks: ["ok"] })
          ])
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "fallback-memory-session", content: "I prefer concise replies." },
        { readMemory: false, writeMemory: true }
      )
    );
    await runtime.drainMemoryWrites();
    expect(events.at(-1)).toMatchObject({ type: "completed", content: "ok" });
    expect(calls).toHaveLength(1);
  });

  it("does not ingest partial or cancelled streams", async () => {
    const partialCalls: Array<Record<string, unknown>> = [];
    const partialRuntime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        partialCalls.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("primary", {
            chunks: ["partial", "ignored"],
            failAfterChunks: 1,
            failAfter: new ProviderError({
              provider: "primary",
              capability: "chat",
              code: ProviderErrorCode.NetworkError,
              message: "stream interrupted"
            })
          })
      }
    });
    await expect(
      collectRuntimeStream(
        partialRuntime.streamUserMessage(
          { sessionId: "partial-memory-session", content: "I prefer concise replies." },
          { readMemory: false, writeMemory: true }
        )
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.NetworkError });
    expect(partialCalls).toHaveLength(0);

    const cancellationCalls: Array<Record<string, unknown>> = [];
    const controller = new AbortController();
    const cancellationRuntime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMem0RecordingMemory(async (input) => {
        cancellationCalls.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", { chunks: ["first", "second"], delayMs: 5 })
      }
    });
    const iterator = cancellationRuntime
      .streamUserMessage(
        { sessionId: "cancelled-memory-session", content: "I prefer concise replies." },
        { signal: controller.signal, readMemory: false, writeMemory: true }
      )
      [Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(cancellationCalls).toHaveLength(0);
  });

  it("ingests once when cancellation arrives after assistant finalization", async () => {
    const controller = new AbortController();
    const writes: Array<Record<string, unknown>> = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("assistant.message", () => {
      controller.abort();
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createMem0RecordingMemory(async (input) => {
        writes.push(input);
        return completeMemoryWrite();
      }),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["final"] })
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "late-cancel-session", content: "I prefer concise replies." },
        { signal: controller.signal, readMemory: false, writeMemory: true }
      )
    );
    await runtime.drainMemoryWrites();

    expect(events.at(-1)).toMatchObject({ type: "completed", content: "final" });
    expect(writes).toHaveLength(1);
  });

  it("keeps assistant success distinct from a finalized memory failure", async () => {
    const diagnostics: RuntimeEvent[] = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("runtime.error", (event) => {
      diagnostics.push(event);
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createMem0RecordingMemory(async () => {
        throw new Error("Mem0 unavailable");
      }),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "memory-failure-session",
      content: "I prefer concise replies.",
      subjectUserId: "user-a",
      personaId: "alice"
    });
    await runtime.drainMemoryWrites();

    expect(reply.type).toBe("agent.reply");
    expect(runtime.getLatestPromptPreview()).toMatchObject({ memoryWriteStatus: "failed" });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.payload).toMatchObject({
      category: "memory",
      operation: "finalized_turn_ingestion"
    });
  });

  it("publishes no reply events when every chat provider fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const providers = createMockProviders();
    providers.getChatProvider = () => ({
      name: "failing-chat",
      async healthCheck() {
        return {
          provider: "failing-chat",
          status: "unavailable" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async generateReply() {
        throw new ProviderError({
          provider: "failing-chat",
          capability: "chat",
          code: ProviderErrorCode.ProviderUnavailable,
          message: "Chat provider is unavailable."
        });
      }
    });

    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      promptBuilder: new PromptBuilder(),
      providers
    });

    await expect(
      runtime.handleUserMessage({ sessionId: "failed-session", content: "hello" })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
    expect(published.filter((event) => event.type === "provider.error")).toHaveLength(1);
  });

  it("publishes one assistant message when memory retrieval fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const memory = createRecordingMemory([]);
    memory.retrieveRelevantMemoriesWithMetadata = async () => {
      throw new Error("memory read unavailable");
    };
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "read-failed-session",
      content: "hello"
    });

    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
    expect(published.find((event) => event.type === "assistant.message")?.payload).toMatchObject({
      content: reply.payload.content
    });
    expect(published.filter((event) => event.type === "runtime.error")).toHaveLength(1);
  });

  it("restores direct context from the repository when a Runtime is rebuilt", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtimeA = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await runtimeA.handleUserMessage(
      { sessionId: "persisted-session", content: "remember this direct context" },
      { readMemory: false, writeMemory: false }
    );

    const runtimeB = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await runtimeB.handleUserMessage(
      { sessionId: "persisted-session", content: "what did I say?" },
      { readMemory: false, writeMemory: false }
    );

    const restored = runtimeB
      .getLatestPromptPreview()
      ?.sections.find((section) => section.name === "DirectContext");
    expect(restored?.content).toContain("remember this direct context");

    const isolated = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await isolated.handleUserMessage(
      { sessionId: "other-session", content: "isolated" },
      { readMemory: false, writeMemory: false }
    );
    expect(
      isolated
        .getLatestPromptPreview()
        ?.sections.find((section) => section.name === "DirectContext")?.content
    ).not.toContain("remember this direct context");
  });

  it("blocks provider execution when the user message cannot be persisted", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let providerCalls = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation: {
        kind: "in-memory",
        async healthCheck() {
          return { status: "healthy" as const };
        },
        async ensureSession() {
          throw new Error("session store unavailable");
        },
        async appendMessage() {
          throw new Error("unreachable");
        },
        async appendMessageContent() {
          throw new Error("unreachable");
        },
        async completeMessage() {
          throw new Error("unreachable");
        },
        async failMessage() {
          throw new Error("unreachable");
        },
        async listRecentMessages() {
          return [];
        }
      },
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => {
          providerCalls += 1;
          return createMockProviders().getChatProvider();
        }
      }
    });

    await expect(
      runtime.handleUserMessage({ sessionId: "save-failed", content: "hello" })
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "session_create"
    });
    expect(providerCalls).toBe(0);
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
    expect(published.find((event) => event.type === "runtime.error")?.payload).toMatchObject({
      category: "persistence",
      operation: "session_create"
    });
  });

  it("does not publish or cache an assistant message when assistant persistence fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let appends = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation: {
        kind: "in-memory",
        async healthCheck() {
          return { status: "healthy" as const };
        },
        async ensureSession() {},
        async appendMessage(message) {
          appends += 1;
          if (appends > 1) {
            throw new Error("assistant store unavailable");
          }
          return { ...message, sequence: 1 };
        },
        async appendMessageContent() {
          throw new Error("unreachable");
        },
        async completeMessage() {
          throw new Error("unreachable");
        },
        async failMessage() {
          throw new Error("unreachable");
        },
        async listRecentMessages() {
          return [];
        }
      },
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await expect(
      runtime.handleUserMessage({
        sessionId: "assistant-save-failed",
        content: "hello"
      })
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_message_save"
    });
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(1);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("uses memory extractor candidates for runtime writes and skips ordinary turns", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const written: MemoryCandidate[] = [];
    const extractionInputs: string[] = [];
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: {
        async retrieveRelevantMemories() {
          return [];
        },
        scoreImportance() {
          return 0;
        },
        async extractCandidates(input) {
          extractionInputs.push(input.userMessage);
          if (input.userMessage.startsWith("记住")) {
            return [
              {
                type: "semantic",
                subtype: "path",
                content: "我的项目路径是 /home/administrator/uv-main/uv-main",
                summary: "我的项目路径是 /home/administrator/uv-main/uv-main",
                importance: 0.95,
                tags: ["path"],
                reason: "explicit-remember",
                sourceTraceId: input.sourceTraceId ?? null
              }
            ];
          }
          if (input.userMessage.startsWith("secret metadata")) {
            return [
              {
                type: "semantic",
                subtype: "fact",
                content: "apiKey=sk-super-secret should be redacted",
                summary: "authorization: Bearer secret should be redacted",
                importance: 0.2,
                tags: ["token=secret"],
                reason: "low-quality-secret-test",
                sourceTraceId: input.sourceTraceId ?? null,
                metadata: {
                  apiKey: "sk-super-secret",
                  nested: { authorization: "Bearer secret" }
                }
              }
            ];
          }
          return [];
        },
        async rememberCandidate(candidate): Promise<Memory> {
          written.push(candidate);
          return createMemory(candidate);
        },
        async rememberInteraction(): Promise<Memory> {
          throw new Error("legacy memory write should not be used");
        }
      },
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await runtime.handleUserMessage({
      sessionId: "test-session",
      content: "hi"
    });
    await runtime.handleUserMessage(
      {
        sessionId: "test-session",
        content: "记住：这个不应该写入，因为 writeMemory=false"
      },
      {
        writeMemory: false
      }
    );
    const reply = await runtime.handleUserMessage({
      sessionId: "test-session",
      content: "记住：我的项目路径是 /home/administrator/uv-main/uv-main"
    });
    await runtime.handleUserMessage({
      sessionId: "test-session",
      content: "secret metadata candidate"
    });

    expect(written).toHaveLength(1);
    expect(extractionInputs).toEqual([
      "hi",
      "记住：我的项目路径是 /home/administrator/uv-main/uv-main",
      "secret metadata candidate"
    ]);
    expect(written[0]).toMatchObject({
      type: "semantic",
      subtype: "path",
      reason: "explicit-remember",
      sourceTraceId: reply.traceId
    });
    const history = runtime.getRecentMemoryCandidates(5);
    expect(history.some((candidate) => candidate.decision === "stored")).toBe(true);
    const rejected = history.find((candidate) => candidate.reason === "low-quality-secret-test");
    expect(rejected).toMatchObject({
      decision: "rejected",
      rejectedReason: "runtime-threshold:low-quality-secret-test"
    });
    expect(JSON.stringify(rejected)).not.toContain("sk-super-secret");
    expect(JSON.stringify(rejected)).not.toContain("Bearer secret");
  });

  it("injects bounded same-session DirectContext without mixing unrelated sessions", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const written: MemoryCandidate[] = [];
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory(written),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders(),
      directContext: {
        enabled: true,
        maxTurns: 1,
        maxChars: 220
      }
    });

    await runtime.handleUserMessage(
      {
        sessionId: "session-a",
        content: "First context turn with token=super-secret-value"
      },
      { writeMemory: false }
    );
    await runtime.handleUserMessage(
      {
        sessionId: "session-b",
        content: "Unrelated session content should not appear"
      },
      { writeMemory: false }
    );
    await runtime.handleUserMessage(
      {
        sessionId: "session-a",
        content: "Second context turn"
      },
      { writeMemory: false }
    );
    const secondPreview = runtime.getLatestPromptPreview();
    const directContext = secondPreview?.sections.find(
      (section) => section.name === "DirectContext"
    );
    const relevantMemory = secondPreview?.sections.find(
      (section) => section.name === "RelevantMemory"
    );

    expect(directContext?.content).toContain("First context turn");
    expect(directContext?.content).not.toContain("super-secret-value");
    expect(directContext?.content).not.toContain("Unrelated session content");
    expect(relevantMemory?.content).toBe("No relevant memory retrieved.");
    expect(secondPreview).toMatchObject({
      directContextEnabled: true,
      directContextTurnCount: 1,
      directContextTruncated: false,
      directContextSource: "session-turns"
    });
    expect(secondPreview?.directContextCharCount).toBeGreaterThan(0);
    expect(written).toHaveLength(0);

    await runtime.handleUserMessage(
      {
        sessionId: "session-a",
        content: "Third context turn"
      },
      { writeMemory: false }
    );
    const thirdPreview = runtime.getLatestPromptPreview();
    const thirdDirectContext = thirdPreview?.sections.find(
      (section) => section.name === "DirectContext"
    );
    expect(thirdDirectContext?.content).not.toContain("First context turn");
    expect(thirdDirectContext?.content).toContain("Second context turn");
    expect(thirdPreview?.directContextTruncated).toBe(true);
  });

  it("streams an assistant-only turn without a user event, user row, or memory write", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const decisionInputs: ProactiveDecisionInput[] = [];
    const continuationInputs: AssistantContinuationInput[] = [];
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getProactiveDecisionProvider: () => ({
          name: "assistant-only-decision",
          async decide(input: ProactiveDecisionInput) {
            decisionInputs.push(input);
            return { decision: "REQUEST_TEXT" as const, model: "decision-model" };
          }
        }),
        getAssistantContinuationProvider: () => ({
          name: "assistant-only-continuation",
          async generateContinuation(input: AssistantContinuationInput) {
            continuationInputs.push(input);
            return {
              message: { role: "assistant" as const, content: "hello" },
              model: "text-model",
              finishReason: "stop" as const
            };
          }
        })
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "assistant-only-session",
        idempotencyKey: "decision-1",
        readMemory: false
      })
    );

    expect(events.map((event) => event.type)).toEqual([
      "proactive-decision",
      "text-delta",
      "completed"
    ]);
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(0);
    expect(published.find((event) => event.type === "agent.reply")).toMatchObject({
      payload: { turnOrigin: "assistant-initiated", idempotencyKey: "decision-1" }
    });
    expect(await conversation.listRecentMessages("assistant-only-session")).toMatchObject([
      {
        role: "assistant",
        content: "hello",
        parentMessageId: null,
        sourceUserEventId: null,
        finalizedTurnId: null,
        metadata: {
          origin: "assistant-initiated",
          idempotencyKey: "decision-1",
          modality: "text"
        }
      }
    ]);
    expect(decisionInputs).toHaveLength(1);
    expect(continuationInputs).toHaveLength(1);
    const proactivePrompt = decisionInputs[0]?.prompt ?? "";
    expect(proactivePrompt).toContain("ProactiveInstruction");
    expect(proactivePrompt).toContain("specific open conversational reason");
    expect(proactivePrompt).toContain("remains meaningfully open or unresolved");
    expect(proactivePrompt).toContain("adequately answered or closed");
    expect(proactivePrompt).toContain("merely elaborate on or repeat a completed answer");
    expect(proactivePrompt).toContain("generic greeting or check-in");
    expect(proactivePrompt).toContain("When uncertain, choose NO_OP.");
    expect(proactivePrompt).toContain("REQUEST_TEXT");
    expect(proactivePrompt).not.toContain("<UserMessage>");
    expect(continuationInputs[0]?.prompt).toContain("decision is already REQUEST_TEXT");
    expect(runtime.getLatestPromptPreview()).toMatchObject({
      turnOrigin: "assistant-initiated",
      proactiveInstruction: expect.any(String),
      writeMemory: false
    });
    expect(runtime.getLatestPromptPreview()).not.toHaveProperty("userMessage");

    await expect(
      collectRuntimeStream(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "assistant-only-session",
          idempotencyKey: "decision-1",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ name: "AssistantTurnConflictError" });
  });

  it("finalizes NO_OP successfully without assistant persistence or replay", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    const written: MemoryCandidate[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory(written),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getProactiveDecisionProvider: () => createMockProactiveDecisionProvider("NO_OP")
      }
    });

    const input = {
      sessionId: "no-op-session",
      idempotencyKey: "no-op-key",
      readMemory: false
    } as const;
    const events = await collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input));

    expect(events).toEqual([
      {
        type: "proactive-decision",
        decision: "NO_OP",
        sessionId: input.sessionId,
        traceId: expect.any(String)
      }
    ]);
    expect(await conversation.listRecentMessages(input.sessionId)).toHaveLength(0);
    expect(written).toHaveLength(0);
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(0);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
    await expect(
      collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input))
    ).rejects.toMatchObject({ name: "AssistantTurnConflictError" });
  });

  it("buffers proactive text and emits one validated full delta", async () => {
    const conversation = new InMemoryConversationRepository();
    const published: RuntimeEvent[] = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getAssistantContinuationProvider: () =>
          createMockAssistantContinuationProvider("hello", "buffered-continuation")
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "split-control-session",
        idempotencyKey: "split-control-key",
        readMemory: false
      })
    );

    expect(events.map((event) => event.type)).toEqual([
      "proactive-decision",
      "text-delta",
      "completed"
    ]);
    expect(
      events.filter((event) => event.type === "text-delta").map((event) => event.text)
    ).toEqual(["hello"]);
    expect((await conversation.listRecentMessages("split-control-session"))[0]).toMatchObject({
      role: "assistant",
      content: "hello"
    });
    expect(published.find((event) => event.type === "agent.reply")).toMatchObject({
      payload: { content: "hello" }
    });
  });

  it("fails closed when assistant text leaks a control label", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getAssistantContinuationProvider: () =>
          createMockAssistantContinuationProvider(
            "REQUEST_TEXT\nhello",
            "leaked-control-continuation"
          )
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "leaked-control-session",
          idempotencyKey: "leaked-control-key",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.MalformedResponse });
    expect(await conversation.listRecentMessages("leaked-control-session")).toHaveLength(0);
  });

  it("fails closed on malformed proactive control without persistence", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getProactiveDecisionProvider: () => ({
          name: "malformed-decision",
          async decide() {
            throw new ProviderError({
              provider: "malformed-decision",
              capability: "chat",
              code: ProviderErrorCode.MalformedResponse,
              message: "invalid decision",
              retryable: false
            });
          }
        })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "malformed-control-session",
          idempotencyKey: "malformed-control-key",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.MalformedResponse });
    expect(await conversation.listRecentMessages("malformed-control-session")).toHaveLength(0);
  });

  it("fails REQUEST_TEXT with no meaningful content", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getAssistantContinuationProvider: () =>
          createMockAssistantContinuationProvider("   ", "empty-continuation")
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "empty-request-text-session",
          idempotencyKey: "empty-request-text-key",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.MalformedResponse });
    expect(await conversation.listRecentMessages("empty-request-text-session")).toHaveLength(0);
  });

  it("fails REQUEST_TEXT when the bounded continuation is truncated", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getAssistantContinuationProvider: () => ({
          name: "truncated-continuation",
          async generateContinuation() {
            return {
              message: { role: "assistant" as const, content: "unfinished text" },
              finishReason: "length" as const
            };
          }
        })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "truncated-request-text-session",
          idempotencyKey: "truncated-request-text-key",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.MalformedResponse });
    expect(await conversation.listRecentMessages("truncated-request-text-session")).toHaveLength(0);
  });

  it("preserves cancellation before the proactive decision", async () => {
    const providerStarted = deferred<void>();
    const controller = new AbortController();
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getProactiveDecisionProvider: () => ({
          name: "cancelled-decision",
          async decide(_input: ProactiveDecisionInput, options?: ChatStreamOptions) {
            providerStarted.resolve();
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                resolve();
                return;
              }
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new ProviderError({
              provider: "cancelled-decision",
              capability: "chat",
              code: ProviderErrorCode.Cancelled,
              message: "cancelled before proactive decision",
              retryable: false
            });
          }
        })
      }
    });

    const pending = collectRuntimeStream(
      runtime.streamAssistantInitiatedTurn(
        {
          sessionId: "cancel-before-decision-session",
          idempotencyKey: "cancel-before-decision-key",
          readMemory: false
        },
        { signal: controller.signal }
      )
    );
    await providerStarted.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(await conversation.listRecentMessages("cancel-before-decision-session")).toHaveLength(0);
  });

  it("does not start proactive text after cancellation wins between stages", async () => {
    const controller = new AbortController();
    const conversation = new InMemoryConversationRepository();
    let continuationCalls = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getAssistantContinuationProvider: () => ({
          name: "must-not-start",
          async generateContinuation() {
            continuationCalls += 1;
            return {
              message: { role: "assistant" as const, content: "stale text" },
              finishReason: "stop" as const
            };
          }
        })
      }
    });
    const input = {
      sessionId: "cancel-between-stages-session",
      idempotencyKey: "cancel-between-stages-key",
      readMemory: false
    } as const;
    const iterator = runtime
      .streamAssistantInitiatedTurn(input, {
        signal: controller.signal
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "proactive-decision", decision: "REQUEST_TEXT" }
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });

    expect(continuationCalls).toBe(0);
    expect(await conversation.listRecentMessages(input.sessionId)).toHaveLength(0);
    await expect(
      collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input))
    ).rejects.toMatchObject({ name: "AssistantTurnConflictError" });
  });

  it("discards proactive text when cancellation wins during the text stage", async () => {
    const providerStarted = deferred<void>();
    const controller = new AbortController();
    const conversation = new InMemoryConversationRepository();
    const published: RuntimeEvent[] = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getAssistantContinuationProvider: () => ({
          name: "cancelled-continuation",
          async generateContinuation(
            _input: AssistantContinuationInput,
            options?: ChatStreamOptions
          ) {
            providerStarted.resolve();
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                resolve();
                return;
              }
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new ProviderError({
              provider: "cancelled-continuation",
              capability: "chat",
              code: ProviderErrorCode.Cancelled,
              message: "cancelled during proactive text",
              retryable: false
            });
          }
        })
      }
    });
    const input = {
      sessionId: "cancel-during-text-session",
      idempotencyKey: "cancel-during-text-key",
      readMemory: false
    } as const;
    const pending = collectRuntimeStream(
      runtime.streamAssistantInitiatedTurn(input, { signal: controller.signal })
    );

    await providerStarted.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });

    expect(await conversation.listRecentMessages(input.sessionId)).toHaveLength(0);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("restores assistant-only history without inventing a user message", async () => {
    const conversation = new InMemoryConversationRepository();
    const first = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getAssistantContinuationProvider: () =>
          createMockAssistantContinuationProvider("earlier", "first")
      }
    });
    await collectRuntimeStream(
      first.streamAssistantInitiatedTurn({
        sessionId: "restored-assistant-session",
        idempotencyKey: "decision-history-1",
        readMemory: false
      })
    );

    let restoredInput: ProactiveDecisionInput | undefined;
    const second = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getProactiveDecisionProvider: () => ({
          name: "second-decision",
          async decide(input: ProactiveDecisionInput) {
            restoredInput = input;
            return { decision: "REQUEST_TEXT" as const };
          }
        }),
        getAssistantContinuationProvider: () =>
          createMockAssistantContinuationProvider("later", "second")
      }
    });
    await collectRuntimeStream(
      second.streamAssistantInitiatedTurn({
        sessionId: "restored-assistant-session",
        idempotencyKey: "decision-history-2",
        readMemory: false
      })
    );

    expect(restoredInput?.prompt).toContain("earlier");
    expect(restoredInput?.prompt).not.toContain("<UserMessage>");
  });

  it("rejects a duplicate idempotency key while the first provider effect is running", async () => {
    const providerStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getProactiveDecisionProvider: () => ({
          name: "blocked-decision",
          async decide() {
            providerStarted.resolve();
            await releaseProvider.promise;
            return { decision: "REQUEST_TEXT" as const };
          }
        })
      }
    });

    const first = collectRuntimeStream(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "running-session",
        idempotencyKey: "running-decision",
        readMemory: false
      })
    );
    await providerStarted.promise;
    await expect(
      collectRuntimeStream(
        runtime.streamAssistantInitiatedTurn({
          sessionId: "running-session",
          idempotencyKey: "running-decision",
          readMemory: false
        })
      )
    ).rejects.toMatchObject({ name: "AssistantTurnConflictError" });
    releaseProvider.resolve();
    await expect(first).resolves.toHaveLength(3);
  });

  it("uses only actual direct context for proactive memory reads", async () => {
    const memory = createRecordingMemory([]);
    const baseRetrieve = memory.retrieveRelevantMemoriesWithMetadata!;
    const queries: string[] = [];
    memory.retrieveRelevantMemoriesWithMetadata = async (input) => {
      queries.push(input.text);
      return { ...(await baseRetrieve(input)), query: input.text };
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      conversation: new InMemoryConversationRepository(),
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("memory", { chunks: ["reply"] })
      }
    });

    await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "memory-context-session", content: "actual prior conversation" },
        { readMemory: false, writeMemory: false }
      )
    );
    await collectRuntimeStream(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "memory-context-session",
        idempotencyKey: "memory-context-decision",
        readMemory: true
      })
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("actual prior conversation");
    expect(queries[0]).not.toContain("assistant-initiated");
    expect(queries[0]).not.toBe("");
  });

  it("excludes the current persisted user by identity before building direct context", async () => {
    const conversation = new InMemoryConversationRepository();
    let providerInput: ChatInput | undefined;
    const provider = createMockStreamingChatProvider("current-user", { chunks: ["reply"] });
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => ({
          ...provider,
          async *streamReply(input: ChatInput, options?: ChatStreamOptions) {
            providerInput = input;
            yield* provider.streamReply!(input, options);
          }
        })
      }
    });

    await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "current-user-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      )
    );

    const systemMessage = providerInput?.messages.find((message) => message.role === "system");
    const currentMessage = providerInput?.messages.find((message) => message.role === "user");
    expect(systemMessage?.content).not.toContain("hello");
    expect(currentMessage?.content.match(/hello/g)).toHaveLength(1);
  });

  it("keeps historical proactive context while excluding a restored current user", async () => {
    const conversation = new InMemoryConversationRepository();
    const first = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("history-user", { chunks: ["first assistant"] }),
        getAssistantContinuationProvider: () =>
          createMockAssistantContinuationProvider("proactive assistant", "history-proactive")
      }
    });

    await collectRuntimeStream(
      first.streamUserMessage(
        { sessionId: "history-composition-session", content: "first user" },
        { readMemory: false, writeMemory: false }
      )
    );
    await collectRuntimeStream(
      first.streamAssistantInitiatedTurn({
        sessionId: "history-composition-session",
        idempotencyKey: "history-proactive",
        readMemory: false
      })
    );

    let restoredInput: ChatInput | undefined;
    const secondProvider = createMockStreamingChatProvider("current-user", {
      chunks: ["second assistant"]
    });
    const second = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => ({
          ...secondProvider,
          async *streamReply(input: ChatInput, options?: ChatStreamOptions) {
            restoredInput = input;
            yield* secondProvider.streamReply!(input, options);
          }
        })
      }
    });

    await collectRuntimeStream(
      second.streamUserMessage(
        { sessionId: "history-composition-session", content: "second user" },
        { readMemory: false, writeMemory: false }
      )
    );

    const systemMessage = restoredInput?.messages.find((message) => message.role === "system");
    const currentMessage = restoredInput?.messages.find((message) => message.role === "user");
    expect(systemMessage?.content).toContain("first user");
    expect(systemMessage?.content).toContain("first assistant");
    expect(systemMessage?.content).toContain("proactive assistant");
    expect(systemMessage?.content).not.toContain("second user");
    expect(currentMessage?.content.match(/second user/g)).toHaveLength(1);
  });

  it("preserves identical historical text and excludes only the current identity", async () => {
    const conversation = new InMemoryConversationRepository();
    await appendCompletedConversationMessage(conversation, {
      id: "user:historical-hello",
      sessionId: "identical-text-session",
      traceId: "trace:historical-hello",
      role: "user",
      content: "hello"
    });
    let providerInput: ChatInput | undefined;
    const provider = createMockStreamingChatProvider("identical-text", { chunks: ["reply"] });
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => ({
          ...provider,
          async *streamReply(input: ChatInput, options?: ChatStreamOptions) {
            providerInput = input;
            yield* provider.streamReply!(input, options);
          }
        })
      }
    });

    await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "identical-text-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      )
    );

    const systemMessage = providerInput?.messages.find((message) => message.role === "system");
    const currentMessage = providerInput?.messages.find((message) => message.role === "user");
    expect(systemMessage?.content.match(/hello/g)).toHaveLength(1);
    expect(currentMessage?.content.match(/hello/g)).toHaveLength(1);
  });

  it("excludes the current row before the direct-context entry budget", async () => {
    const conversation = new InMemoryConversationRepository();
    for (let index = 1; index <= 12; index += 1) {
      await appendCompletedConversationMessage(conversation, {
        id: `user:budget-${index}`,
        sessionId: "budget-session",
        traceId: `trace:budget-${index}`,
        role: "user",
        content: `historical-${index}`,
        timestampMs: index
      });
    }
    let providerInput: ChatInput | undefined;
    const provider = createMockStreamingChatProvider("budget", { chunks: ["reply"] });
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      directContext: { enabled: true, maxTurns: 4, maxChars: 5000 },
      providers: {
        ...createMockProviders(),
        getChatProvider: () => ({
          ...provider,
          async *streamReply(input: ChatInput, options?: ChatStreamOptions) {
            providerInput = input;
            yield* provider.streamReply!(input, options);
          }
        })
      }
    });

    await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "budget-session", content: "current-budget" },
        { readMemory: false, writeMemory: false }
      )
    );

    const systemMessage = providerInput?.messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain("historical-9");
    expect(systemMessage?.content).toContain("historical-12");
    expect(systemMessage?.content).not.toContain("current-budget");
  });

  it("pairs persisted assistants by source user identity before adjacency fallback", async () => {
    const conversation = new InMemoryConversationRepository();
    const sessionId = "source-link-session";
    await appendCompletedConversationMessage(conversation, {
      id: "user:source-1",
      sessionId,
      traceId: "trace:source-1",
      role: "user",
      content: "source-user-1",
      timestampMs: 1
    });
    await appendCompletedConversationMessage(conversation, {
      id: "user:source-2",
      sessionId,
      traceId: "trace:source-2",
      role: "user",
      content: "source-user-2",
      timestampMs: 2
    });
    await appendCompletedConversationMessage(conversation, {
      id: "assistant:source-1",
      sessionId,
      traceId: "trace:assistant-1",
      role: "assistant",
      content: "source-answer-1",
      sourceUserEventId: "user:source-1",
      timestampMs: 3
    });
    await appendCompletedConversationMessage(conversation, {
      id: "assistant:proactive-source",
      sessionId,
      traceId: "trace:proactive-source",
      role: "assistant",
      content: "proactive-history",
      metadata: { origin: "assistant-initiated" },
      timestampMs: 4
    });
    await appendCompletedConversationMessage(conversation, {
      id: "assistant:source-2",
      sessionId,
      traceId: "trace:assistant-2",
      role: "assistant",
      content: "source-answer-2",
      sourceUserEventId: "user:source-2",
      timestampMs: 5
    });
    await appendCompletedConversationMessage(conversation, {
      id: "user:source-3",
      sessionId,
      traceId: "trace:source-3",
      role: "user",
      content: "incomplete-historical-user",
      timestampMs: 6
    });

    let providerInput: ProactiveDecisionInput | undefined;
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getProactiveDecisionProvider: () => ({
          name: "source-link",
          async decide(input: ProactiveDecisionInput) {
            providerInput = input;
            return { decision: "REQUEST_TEXT" as const };
          }
        })
      }
    });

    await collectRuntimeStream(
      runtime.streamAssistantInitiatedTurn({
        sessionId,
        idempotencyKey: "source-link-probe",
        readMemory: false
      })
    );

    const systemContent = providerInput?.prompt;
    expect(systemContent).toContain("User: source-user-1\n  Assistant: source-answer-1");
    expect(systemContent).toContain("User: source-user-2\n  Assistant: source-answer-2");
    expect(systemContent).toContain("Assistant: proactive-history");
    expect(systemContent).toContain("User: incomplete-historical-user");
    expect(systemContent!.indexOf("User: source-user-1")).toBeLessThan(
      systemContent!.indexOf("User: source-user-2")
    );
    expect(systemContent!.indexOf("User: source-user-2")).toBeLessThan(
      systemContent!.indexOf("Assistant: proactive-history")
    );
    expect(systemContent!.indexOf("Assistant: proactive-history")).toBeLessThan(
      systemContent!.indexOf("User: incomplete-historical-user")
    );
  });

  it("uses deterministic adjacency fallback only for missing or invalid source links", async () => {
    const conversation = new InMemoryConversationRepository();
    const sessionId = "fallback-source-session";
    await appendCompletedConversationMessage(conversation, {
      id: "user:fallback-1",
      sessionId,
      traceId: "trace:fallback-1",
      role: "user",
      content: "fallback-user-1",
      timestampMs: 1
    });
    await appendCompletedConversationMessage(conversation, {
      id: "user:fallback-2",
      sessionId,
      traceId: "trace:fallback-2",
      role: "user",
      content: "fallback-user-2",
      timestampMs: 2
    });
    await appendCompletedConversationMessage(conversation, {
      id: "assistant:fallback-1",
      sessionId,
      traceId: "trace:fallback-1",
      role: "assistant",
      content: "fallback-answer-1",
      timestampMs: 3
    });
    await appendCompletedConversationMessage(conversation, {
      id: "assistant:fallback-2",
      sessionId,
      traceId: "trace:fallback-2",
      role: "assistant",
      content: "fallback-answer-2",
      sourceUserEventId: "user:does-not-exist",
      timestampMs: 4
    });

    let providerInput: ProactiveDecisionInput | undefined;
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getProactiveDecisionProvider: () => ({
          name: "fallback-source",
          async decide(input: ProactiveDecisionInput) {
            providerInput = input;
            return { decision: "REQUEST_TEXT" as const };
          }
        })
      }
    });

    await collectRuntimeStream(
      runtime.streamAssistantInitiatedTurn({
        sessionId,
        idempotencyKey: "fallback-source-probe",
        readMemory: false
      })
    );

    const systemContent = providerInput?.prompt;
    expect(systemContent).toContain("User: fallback-user-2\n  Assistant: fallback-answer-1");
    expect(systemContent).toContain("User: fallback-user-1\n  Assistant: fallback-answer-2");
  });

  it("allocates fresh assistant and reply identities when a retained key is reused", async () => {
    vi.useFakeTimers();
    try {
      const conversation = new InMemoryConversationRepository();
      const published: RuntimeEvent[] = [];
      const eventBus = new InMemoryEventBus({ development: false });
      eventBus.subscribe("*", (event) => {
        published.push(event);
      });
      let output = "first-output";
      let providerCalls = 0;
      const runtime = new RuntimeOrchestrator({
        eventBus,
        memory: createRecordingMemory([]),
        conversation,
        promptBuilder: new PromptBuilder(),
        providers: {
          ...createMockProviders(),
          getAssistantContinuationProvider: () => ({
            name: "effect-id",
            async generateContinuation() {
              providerCalls += 1;
              return {
                message: { role: "assistant" as const, content: output },
                finishReason: "stop" as const
              };
            }
          })
        }
      });
      const input = {
        sessionId: "effect-id-session",
        idempotencyKey: "reusable-key",
        readMemory: false
      } as const;

      await collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input));
      await expect(
        collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input))
      ).rejects.toMatchObject({
        name: "AssistantTurnConflictError"
      });
      const firstMessages = await conversation.listRecentMessages(input.sessionId);
      const firstAssistant = firstMessages.find((message) => message.role === "assistant")!;
      const firstReply = published.find((event) => event.type === "agent.reply")!;

      output = "second-output";
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      await collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input));

      const messages = await conversation.listRecentMessages(input.sessionId);
      const assistants = messages.filter((message) => message.role === "assistant");
      const replies = published.filter((event) => event.type === "agent.reply");
      expect(providerCalls).toBe(2);
      expect(assistants).toHaveLength(2);
      expect(new Set(assistants.map((message) => message.id)).size).toBe(2);
      expect(new Set(replies.map((event) => event.id)).size).toBe(2);
      expect(assistants.map((message) => message.content)).toEqual([
        "first-output",
        "second-output"
      ]);
      expect(
        assistants.every((message) => message.metadata["idempotencyKey"] === input.idempotencyKey)
      ).toBe(true);
      expect(firstAssistant.id).not.toBe(assistants[1]?.id);
      expect(firstReply.id).not.toBe(replies[1]?.id);
      expect(firstAssistant.id).not.toBe(input.idempotencyKey);
      expect(firstReply.id).not.toBe(input.idempotencyKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it("atomically admits one fresh effect when a key becomes reusable", async () => {
    vi.useFakeTimers();
    try {
      let providerCalls = 0;
      const runtime = new RuntimeOrchestrator({
        eventBus: new InMemoryEventBus({ development: false }),
        memory: createRecordingMemory([]),
        promptBuilder: new PromptBuilder(),
        providers: {
          ...createMockProviders(),
          getAssistantContinuationProvider: () => ({
            name: "race-id",
            async generateContinuation() {
              providerCalls += 1;
              return {
                message: { role: "assistant" as const, content: "race-output" },
                finishReason: "stop" as const
              };
            }
          })
        }
      });
      const input = {
        sessionId: "race-id-session",
        idempotencyKey: "race-reusable-key",
        readMemory: false
      } as const;

      await collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input));
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      const results = await Promise.allSettled([
        collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input)),
        collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input))
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(providerCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allocates fresh persistence identities after terminal-cap eviction", async () => {
    vi.useFakeTimers();
    try {
      const conversation = new InMemoryConversationRepository();
      let output = "cap-first";
      let providerCalls = 0;
      const runtime = new RuntimeOrchestrator({
        eventBus: new InMemoryEventBus({ development: false }),
        memory: createRecordingMemory([]),
        conversation,
        promptBuilder: new PromptBuilder(),
        providers: {
          ...createMockProviders(),
          getAssistantContinuationProvider: () => ({
            name: "cap-id",
            async generateContinuation() {
              providerCalls += 1;
              return {
                message: { role: "assistant" as const, content: output },
                finishReason: "stop" as const
              };
            }
          })
        }
      });
      const reusable = {
        sessionId: "cap-id-session",
        idempotencyKey: "cap-reusable-key",
        readMemory: false
      } as const;

      await collectRuntimeStream(runtime.streamAssistantInitiatedTurn(reusable));
      const firstAssistant = (
        await conversation.listRecentMessages(reusable.sessionId, { limit: 400 })
      ).find((message) => message.role === "assistant")!;

      for (let index = 0; index < 256; index += 1) {
        vi.advanceTimersByTime(1);
        await collectRuntimeStream(
          runtime.streamAssistantInitiatedTurn({
            sessionId: reusable.sessionId,
            idempotencyKey: `cap-filler-${index}`,
            readMemory: false
          })
        );
      }

      output = "cap-second";
      await collectRuntimeStream(runtime.streamAssistantInitiatedTurn(reusable));
      const assistants = (
        await conversation.listRecentMessages(reusable.sessionId, { limit: 400 })
      ).filter((message) => message.role === "assistant");
      const secondAssistant = assistants.find(
        (message) => message.metadata["idempotencyKey"] === reusable.idempotencyKey
      );

      expect(providerCalls).toBe(258);
      expect(firstAssistant.content).toBe("cap-first");
      expect(secondAssistant).toMatchObject({ content: "cap-second" });
      expect(firstAssistant.id).not.toBe(secondAssistant?.id);
      expect(firstAssistant.metadata["idempotencyKey"]).toBe(reusable.idempotencyKey);
      expect(secondAssistant?.metadata["idempotencyKey"]).toBe(reusable.idempotencyKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains terminal idempotency claims for fifteen minutes and bounds the terminal cache", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new RuntimeOrchestrator({
        eventBus: new InMemoryEventBus({ development: false }),
        memory: createRecordingMemory([]),
        promptBuilder: new PromptBuilder(),
        providers: createMockProviders()
      });
      const input = {
        sessionId: "retention-session",
        idempotencyKey: "retained-decision",
        readMemory: false
      } as const;

      await collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input));
      await expect(
        collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input))
      ).rejects.toMatchObject({ name: "AssistantTurnConflictError" });

      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      await expect(
        collectRuntimeStream(runtime.streamAssistantInitiatedTurn(input))
      ).resolves.toHaveLength(3);

      for (let index = 0; index < 257; index += 1) {
        await collectRuntimeStream(
          runtime.streamAssistantInitiatedTurn({
            sessionId: "retention-session",
            idempotencyKey: `bounded-${index}`,
            readMemory: false
          })
        );
      }
      await expect(
        collectRuntimeStream(
          runtime.streamAssistantInitiatedTurn({
            sessionId: "retention-session",
            idempotencyKey: "bounded-0",
            readMemory: false
          })
        )
      ).resolves.toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});


function createRecordingMemory(written: MemoryCandidate[]): RuntimeMemoryPort {
  return {
    async retrieveRelevantMemories() {
      return [];
    },
    async retrieveRelevantMemoriesWithMetadata() {
      return {
        query: "",
        keywords: [],
        rawCount: 0,
        count: 0,
        retrievalMode: "keyword",
        vectorEnabled: false,
        vectorUsed: false,
        queryEmbeddingGenerated: false,
        vectorResultCount: 0,
        keywordResultCount: 0,
        hybridResultCount: 0,
        fallbackUsed: false,
        retrievalScope: "user,project:yuvi-runtime",
        includedScopes: [{ scope: "user" }, { scope: "project", scopeId: "yuvi-runtime" }],
        includeArchived: false,
        includeSuperseded: false,
        includeExpired: false,
        currentTime: new Date().toISOString(),
        excludedByStatus: 0,
        excludedByTime: 0,
        excludedByScope: 0,
        rawMemories: [],
        memories: [],
        selectedMemories: []
      };
    },
    scoreImportance() {
      return 0;
    },
    async extractCandidates() {
      return [];
    },
    async rememberCandidate(candidate): Promise<Memory> {
      written.push(candidate);
      return createMemory(candidate);
    },
    async rememberInteraction(): Promise<Memory | null> {
      return null;
    }
  };
}

function completeMemoryWrite(idempotencyKey?: string): MemoryConversationTurnWriteResult {
  return {
    status: "complete",
    ok: true,
    attemptedCount: 1,
    writtenCount: 1,
    rejectedCount: 0,
    deduplicatedCount: 0,
    skippedCount: 0,
    memoryId: "memory-id",
    operation: "created",
    idempotencyKey
  };
}

function createDirectMemoryTurn(sessionId: string) {
  const sourceEvent = createEvent("user.message", {
    sessionId,
    content: "I prefer concise replies."
  });
  const reply = createEvent(
    "agent.reply",
    {
      sessionId,
      content: "Understood."
    },
    {
      traceId: sourceEvent.traceId,
      parentId: sourceEvent.id
    }
  );
  return { sourceEvent, reply };
}

type DirectMemoryTurn = ReturnType<typeof createDirectMemoryTurn>;

function createMem0RecordingMemory(
  store: (input: Record<string, unknown>) => Promise<MemoryConversationTurnWriteResult>
): RuntimeMemoryPort {
  return {
    async retrieveRelevantMemories() {
      return [];
    },
    scoreImportance() {
      return 0;
    },
    isMem0Backend() {
      return true;
    },
    async storeConversationTurn(input) {
      return store(input as unknown as Record<string, unknown>);
    },
    async rememberInteraction() {
      return null;
    }
  };
}

function finalizedStatusAdmission(finalizedTurnId: string) {
  return {
    finalizedTurnId,
    assistantMessageId: `assistant:${finalizedTurnId}`,
    sourceUserEventId: `user:${finalizedTurnId}`,
    conversationId: `conversation:${finalizedTurnId}`,
    traceId: `trace:${finalizedTurnId}`,
    personaId: "alice",
    subjectUserId: "user-a",
    finalizedAt: "2026-08-13T00:00:00.000Z",
    ingestionRequested: true,
    userMessage: "I prefer concise replies.",
    assistantMessage: "Understood.",
    sessionId: `session:${finalizedTurnId}`
  };
}

async function createFinalizedStatusFixture(finalizedTurnId: string, eventCount: number) {
  const repository = new InMemoryFinalizedIngestionRepository();
  const service = new FinalizedIngestionService(repository, {
    async build() {
      return {
        turnKind: "normal" as const,
        events: Array.from({ length: eventCount }, (_, index) => ({
          kind: "fact" as const,
          content: `fact-${index + 1}`,
          scope: "user:user-a:persona:alice",
          metadata: {}
        }))
      };
    }
  });
  const admitted = await service.admit(finalizedStatusAdmission(finalizedTurnId));
  return { repository, service, admitted, turnId: finalizedTurnId };
}

async function recordFinalizedEventOutcome(
  service: FinalizedIngestionService,
  repository: InMemoryFinalizedIngestionRepository,
  event: Awaited<ReturnType<FinalizedIngestionService["admit"]>>["events"][number],
  outcome: Parameters<FinalizedIngestionService["recordEventOutcome"]>[0]["outcome"]
): Promise<void> {
  const claimed = await repository.claimEvent({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner: "status-test-owner",
    leaseSeconds: 300,
    expectedVersion: event.version
  });
  if (!claimed) throw new Error(`Could not claim ${event.eventId} for status test.`);
  const dispatching = await repository.markEventDispatchStarted({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner: "status-test-owner",
    expectedVersion: claimed.version
  });
  if (!dispatching) throw new Error(`Could not mark ${event.eventId} for status test.`);
  await service.recordEventOutcome({
    finalizedTurnId: event.finalizedTurnId,
    eventId: event.eventId,
    leaseOwner: "status-test-owner",
    expectedVersion: dispatching.version,
    outcome
  });
}

async function runFinalizedStatusSchedule(fixture: {
  repository: InMemoryFinalizedIngestionRepository;
  service: FinalizedIngestionService;
  admitted: Awaited<ReturnType<FinalizedIngestionService["admit"]>>;
  turnId: string;
}): Promise<MemoryConversationTurnWriteResult> {
  const memory = createMem0RecordingMemory(async () => completeMemoryWrite());
  memory.getMemoryProvider = () => ({
    async retrieveRelevant() {
      return { status: "empty", events: [], source: "test", limited: false };
    },
    async getEvent() {
      return null;
    },
    async writeEvent() {
      return { status: "written", eventId: "memory:status-test" };
    },
    async writeEventIdempotent() {
      return { status: "written", eventId: "memory:status-test" };
    }
  });
  const runtime = new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory,
    finalizedIngestion: fixture.service,
    promptBuilder: new PromptBuilder(),
    providers: createMockProviders()
  });
  const { sourceEvent, reply } = createDirectMemoryTurn(`status-${fixture.turnId}`);
  const schedule = (
    runtime as unknown as {
      scheduleMem0TurnWrite: (
        sourceEvent: DirectMemoryTurn["sourceEvent"],
        reply: DirectMemoryTurn["reply"],
        assistantMessageId: string,
        finalizedTurnId: string
      ) => Promise<MemoryConversationTurnWriteResult>;
    }
  ).scheduleMem0TurnWrite.bind(runtime);
  return schedule(sourceEvent, reply, fixture.admitted.turn.assistantMessageId, fixture.turnId);
}

function createMockProviders() {
  return {
    getChatProvider: () => createAssistantAwareChatProvider(createMockChatProvider("mock-chat")),
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider("REQUEST_TEXT"),
    getAssistantContinuationProvider: () =>
      createMockAssistantContinuationProvider("Mock proactive continuation."),
    getReasoningProvider: () => createMockReasoningProvider("mock-reasoning"),
    getTTSProvider: () => ({
      name: "mock-tts",
      async healthCheck() {
        return {
          provider: "mock-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech() {
        return {
          audio: new Uint8Array(),
          audioBase64: "",
          mimeType: "audio/wav",
          durationMs: 0
        };
      }
    }),
    getSTTProvider: () => createMockSTTProvider("mock-stt"),
    getVisionProvider: () => createMockVisionProvider("mock-vision"),
    getEmbeddingProvider: () => ({
      name: "mock-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "mock-embedding",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async embedText() {
        return [0, 0, 0];
      },
      async embedBatch(texts: string[]) {
        return texts.map(() => [0, 0, 0]);
      }
    })
  };
}

function createExactStreamingChatProvider(name: string, events: ChatStreamEvent[]): ChatProvider {
  const completed = events.find((event) => event.type === "completed");
  return {
    name,
    async healthCheck() {
      return {
        provider: name,
        status: "healthy" as const,
        checkedAt: new Date().toISOString()
      };
    },
    async generateReply() {
      return completed?.type === "completed"
        ? completed.output
        : { message: { role: "assistant", content: "" } };
    },
    async *streamReply(): AsyncIterable<ChatStreamEvent> {
      yield* events;
    }
  };
}

function createMockStreamingChatProvider(
  name = "mock-stream-chat",
  options: MockStreamingChatProviderOptions = {}
): ChatProvider {
  return createAssistantAwareChatProvider(createRawMockStreamingChatProvider(name, options));
}

function createAssistantAwareChatProvider(provider: ChatProvider): ChatProvider {
  return {
    ...provider,
    async generateReply(input: ChatInput, options?: ChatStreamOptions): Promise<ChatOutput> {
      const output = await provider.generateReply(input, options);
      return isAssistantInitiatedInput(input) ? withProactiveControl(output) : output;
    },
    async *streamReply(
      input: ChatInput,
      options?: ChatStreamOptions
    ): AsyncIterable<ChatStreamEvent> {
      const proactive = isAssistantInitiatedInput(input);
      let controlEmitted = false;
      const stream = provider.streamReply
        ? provider.streamReply(input, options)
        : (async function* (): AsyncIterable<ChatStreamEvent> {
            const output = await provider.generateReply(input, options);
            if (output.message.content) {
              yield { type: "text-delta", text: output.message.content };
            }
            yield { type: "completed", output };
          })();
      for await (const event of stream) {
        if (!proactive) {
          yield event;
          continue;
        }
        if (event.type === "text-delta") {
          if (!controlEmitted) {
            controlEmitted = true;
            yield { type: "text-delta", text: "REQUEST_TEXT\n" };
          }
          yield event;
          continue;
        }
        if (!controlEmitted) {
          controlEmitted = true;
          yield { type: "text-delta", text: "REQUEST_TEXT\n" };
        }
        yield {
          ...event,
          output: withProactiveControl(event.output)
        };
      }
    }
  };
}

function isAssistantInitiatedInput(input: ChatInput): boolean {
  return input.metadata?.["turnOrigin"] === "assistant-initiated";
}

function withProactiveControl(output: ChatOutput): ChatOutput {
  return {
    ...output,
    message: {
      ...output.message,
      content: `REQUEST_TEXT\n${output.message.content}`
    }
  };
}

function createMemory(candidate: MemoryCandidate): Memory {
  const now = new Date();
  return {
    id: "memory-id",
    type: candidate.type,
    subtype: candidate.subtype ?? null,
    scope: candidate.scope ?? "user",
    scopeId: candidate.scopeId ?? null,
    memoryLayer: candidate.memoryLayer ?? "core",
    status: "active",
    content: candidate.content,
    summary: candidate.summary ?? null,
    embedding: null,
    embeddingModel: null,
    embeddingProvider: null,
    embeddingDimensions: null,
    embeddedAt: null,
    importance: candidate.importance,
    emotionValence: 0,
    emotionArousal: 0,
    source: "runtime",
    sourceTraceId: candidate.sourceTraceId ?? null,
    metadata: {},
    tags: candidate.tags,
    createdAt: now,
    updatedAt: now,
    observedAt: candidate.observedAt ? new Date(candidate.observedAt) : now,
    eventTime: null,
    validFrom: now,
    validUntil: null,
    expiresAt: null,
    lastAccessedAt: now,
    supersededAt: null,
    supersedes: [],
    supersededBy: null,
    contradicts: []
  };
}
