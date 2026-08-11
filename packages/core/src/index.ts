import type { EventBus } from "@companion/event-bus";
import type {
  ConversationMessage,
  ConversationMessageInput,
  ConversationRepository,
  Memory,
  MemoryCandidate,
  MemoryCandidateStorageResult,
  CurrentAffect,
  MemoryEvent,
  MemoryExtractorStatus,
  MemoryProvider,
  MemoryRetrievalMode,
  MemoryRetrievalResult,
  MemoryRetrievalStatus,
  RetrievedMemoryDebug
} from "@companion/memory";
import {
  detectCurrentAffect,
  detectExplicitForgetRequest,
  detectExplicitRememberRequest
} from "@companion/memory";
import type { PromptBuildInput, PromptBuildOutput } from "@companion/prompt-builder";
import type {
  AgentReplyEvent,
  AssistantMessageEvent,
  AvatarSpeakEvent,
  PerceptionVisionEvent,
  RuntimeEvent,
  UserMessageEvent,
  UserVoiceTranscriptEvent
} from "@companion/protocol";
import { createEvent } from "@companion/protocol";
import {
  ProviderError,
  ProviderErrorCode,
  type ChatInput,
  type ChatOutput,
  type ChatProvider,
  type ChatStreamEvent,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderMetadata,
  type ProviderResolver,
  type STTInput,
  type TokenUsage,
  type VisionInput
} from "@companion/providers";
import {
  deterministicMemoryEchoReason,
  MemoryContextBuilder,
  normalizeMemoryTextForDedupe,
  type MemoryContextBuildOptions,
  type MemoryContextDrop,
  type PromptMemoryCompatibility
} from "./memory-context.js";

export {
  MemoryContextBuilder,
  type MemoryContext,
  type MemoryContextBuildOptions,
  type MemoryContextDiagnostics,
  type MemoryContextDrop,
  type MemoryContextDropReason,
  type MemoryContextInput,
  type PromptMemoryCompatibility,
  deterministicMemoryEchoReason,
  normalizeMemoryTextForDedupe
} from "./memory-context.js";

export type RuntimeLogger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
};

export type RuntimeOrchestratorOptions = {
  eventBus: EventBus;
  memory: RuntimeMemoryPort;
  promptBuilder: RuntimePromptBuilderPort;
  providers: ProviderResolver;
  conversation?: ConversationRepository | undefined;
  memoryRepository?: string | undefined;
  directContext?: Partial<DirectContextConfig> | undefined;
  memoryContextBuilder?: Pick<MemoryContextBuilder, "build"> | undefined;
  logger?: RuntimeLogger;
};

export type ConversationPersistenceOperation =
  | "session_create"
  | "user_message_save"
  | "assistant_message_save"
  | "assistant_stream_create"
  | "assistant_stream_append"
  | "assistant_stream_complete"
  | "assistant_stream_fail"
  | "context_restore";

export class ConversationPersistenceError extends Error {
  readonly operation: ConversationPersistenceOperation;

  constructor(
    operation: ConversationPersistenceOperation,
    message = "Conversation persistence failed."
  ) {
    super(message);
    this.name = "ConversationPersistenceError";
    this.operation = operation;
  }
}

export type DirectContextConfig = {
  enabled: boolean;
  maxTurns: number;
  maxChars: number;
};

export type RuntimeMemoryPort = {
  retrieveRelevantMemories(input: {
    text: string;
    limit?: number;
    sessionId?: string;
    projectId?: string;
    personaId?: string;
    subjectUserId?: string;
    speakerId?: string;
  }): Promise<Memory[]>;
  /** Optional semantic provider used by the Runtime read path during migration. */
  getMemoryProvider?(): MemoryProvider | undefined;
  retrieveRelevantMemoriesWithMetadata?(input: {
    text: string;
    limit?: number;
    sessionId?: string;
    projectId?: string;
    personaId?: string;
    subjectUserId?: string;
    speakerId?: string;
  }): Promise<MemoryRetrievalResult>;
  scoreImportance(text: string): number;
  /** When true, formal LTM is Mem0 — Legacy extract/write must not run. */
  isMem0Backend?(): boolean;
  getBackendKind?(): "legacy" | "mem0";
  storeConversationTurn?(input: {
    userMessage: string;
    assistantMessage: string;
    sessionId?: string | undefined;
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
    userMessageId?: string | null | undefined;
    assistantMessageId?: string | null | undefined;
    traceId?: string | null | undefined;
    conversationId?: string | null | undefined;
    language?: string | null | undefined;
  }): Promise<{ ok: boolean; skippedReason?: string; memoryId?: string; operation?: string }>;
  forgetExplicitMemory?(input: {
    userMessage: string;
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
  }): Promise<{ deleted: number; notFound: boolean; memoryIds: string[]; query: string }>;
  extractCandidates?(input: {
    sessionId?: string | undefined;
    userMessage: string;
    assistantMessage?: string | undefined;
    sourceTraceId?: string | null | undefined;
    timestamp?: string | undefined;
    personaId?: string | null | undefined;
    subjectUserId?: string | null | undefined;
    createdByUserId?: string | null | undefined;
    speakerId?: string | null | undefined;
    voiceProfileId?: string | null | undefined;
    providerMetadata?: SafeProviderCallMetadata | undefined;
    memoryOptions?:
      | {
          readMemory: boolean;
          writeMemory: boolean;
        }
      | undefined;
  }): Promise<MemoryCandidate[]>;
  getExtractorStatus?(): MemoryExtractorStatus;
  rememberCandidate?(
    candidate: MemoryCandidate,
    options?: { source?: string; tags?: string[] }
  ): Promise<Memory>;
  processCandidateForStorage?(
    candidate: MemoryCandidate,
    options?: {
      source?: string;
      tags?: string[];
      skipAdmissionPolicy?: boolean;
      storageReason?: string;
    }
  ): Promise<MemoryCandidateStorageResult>;
  rememberInteraction(input: {
    userMessage: string;
    assistantMessage: string;
    source?: string;
    sourceTraceId?: string | null;
    tags?: string[];
  }): Promise<Memory | null>;
};

export type RuntimePromptBuilderPort = {
  buildPrompt(input: PromptBuildInput): PromptBuildOutput;
};

export type HandleUserMessageInput = {
  sessionId: string;
  content: string;
  voiceOutput?: boolean | undefined;
  traceId?: string | undefined;
  parentId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  createdByUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  voiceProfileId?: string | null | undefined;
};

export type HandleUserMessageOptions = {
  voiceOutput?: boolean | undefined;
  useMemory?: boolean | undefined;
  readMemory?: boolean | undefined;
  writeMemory?: boolean | undefined;
};

export type RuntimeReplyStreamEvent =
  | {
      type: "text-delta";
      text: string;
      messageId: string;
      sessionId: string;
      traceId: string;
    }
  | {
      type: "completed";
      messageId: string;
      sessionId: string;
      traceId: string;
      content: string;
      provider: string;
    };

export type StreamUserMessageOptions = HandleUserMessageOptions & {
  signal?: AbortSignal | undefined;
};

export type RuntimePromptPreview = {
  traceId: string;
  timestamp: string;
  userMessage: string;
  legacyUseMemory: boolean | undefined;
  useMemory: boolean;
  readMemory: boolean;
  writeMemory: boolean;
  memoryReadEnabled: boolean;
  memoryWriteEnabled: boolean;
  memoryRepository: string;
  retrievedMemoryCountRaw: number;
  retrievedMemoryCount: number;
  memoryProviderStatus?: MemoryRetrievalStatus | undefined;
  memoryFinalStatus?: MemoryRetrievalStatus | undefined;
  memoryProviderSource?: string | undefined;
  memoryProviderErrorCode?: string | null | undefined;
  memoryRetrievalLimited: boolean;
  memoryQueryLength: number;
  memoryRetrievalEventIds: string[];
  memoryRetrievalDroppedCount: number;
  memoryRetrievalDropped: MemoryContextDrop[];
  memoryMetadataPresent: boolean;
  memorySourceTurnLinkCount: number;
  memoryConversationLinked: boolean;
  memoryParticipantsCount: number;
  memoryFallbackProducedResults: boolean;
  memoryFallbackUsed: boolean;
  memoryFallbackReason?: string | undefined;
  memoryFallbackSource?: "legacy" | undefined;
  retrievalMode: MemoryRetrievalMode;
  vectorEnabled: boolean;
  vectorUsed: boolean;
  embeddingProvider?: string | undefined;
  embeddingModel?: string | undefined;
  embeddingDimensions?: number | undefined;
  semanticEmbedding?: boolean | undefined;
  embeddingNote?: string | undefined;
  queryEmbeddingGenerated: boolean;
  vectorResultCount: number;
  keywordResultCount: number;
  hybridResultCount: number;
  retrievalFallbackUsed: boolean;
  retrievalFallbackReason?: string | undefined;
  retrievalScope: string;
  includedScopes: Array<{ scope: string; scopeId?: string | null }>;
  includeArchived: boolean;
  includeSuperseded: boolean;
  includeExpired: boolean;
  currentTime: string;
  currentAffect?: CurrentAffect | undefined;
  directContextEnabled: boolean;
  directContextTurnCount: number;
  directContextCharCount: number;
  directContextTruncated: boolean;
  directContextSource: string;
  excludedByStatus: number;
  excludedByTime: number;
  excludedByScope: number;
  retrievedMemories: RetrievedMemoryDebug[];
  sections: PromptBuildOutput["sections"];
  finalMessages: PromptBuildOutput["messages"];
  finalPrompt: string;
  characterCount: number;
  estimatedTokens: number;
  truncated: boolean;
  providerName?: string | undefined;
  providerModel?: string | undefined;
  providerMock?: boolean | undefined;
  providerLatencyMs?: number | undefined;
  providerHealthStatus?: string | undefined;
  tokenUsage?: TokenUsage | undefined;
  memoryExtractorMode: string;
  memoryExtractorActive: string;
  memoryExtractorUsed: boolean;
  memoryExtractorProvider?: string | undefined;
  memoryExtractionCandidateCount: number;
  storedMemoryCount: number;
  rejectedMemoryCount: number;
  rejectedReasons: string[];
  fallbackUsed: boolean;
  llmExtractionError?: string | undefined;
  llmExtractionRawPreview?: string | undefined;
  validationIssues?: string[] | undefined;
  memoryCandidates: RuntimeMemoryCandidateReview[];
  memoryExtractionSkippedReason?: string | undefined;
};

export type RuntimeMemoryCandidateDecision = "stored" | "rejected";

export type RuntimeMemoryCandidateReview = {
  id: string;
  traceId: string;
  timestamp: string;
  type: MemoryCandidate["type"];
  subtype?: MemoryCandidate["subtype"];
  scope?: MemoryCandidate["scope"];
  scopeId?: MemoryCandidate["scopeId"];
  memoryLayer?: MemoryCandidate["memoryLayer"];
  content: string;
  contentPreview: string;
  summary?: string | null | undefined;
  importance: number;
  confidence?: number | undefined;
  tags: string[];
  reason: string;
  decision: RuntimeMemoryCandidateDecision;
  rejectedReason?: string | undefined;
  storageReason?: string | undefined;
  explicitRememberRequested?: boolean | undefined;
  correctionRequested?: boolean | undefined;
  originRole?: "user" | "assistant" | "mixed" | undefined;
  canonicalFingerprint?: string | undefined;
  canonicalEventKey?: string | undefined;
  temporalStatus?: "not-needed" | "normalized" | "unresolved" | undefined;
  temporalSuggestion?: string | undefined;
  source: "runtime" | "dashboard";
  sourceTraceId?: string | null | undefined;
  storedMemoryId?: string | undefined;
  createdAt: string;
  extractorMode: string;
  extractorProvider?: string | undefined;
  fallbackUsed: boolean;
  metadata?: Record<string, unknown> | undefined;
  retentionClass?: string | undefined;
  computedExpiresAt?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  observedAt?: string | undefined;
  eventTime?: string | null | undefined;
  validFrom?: string | undefined;
  validUntil?: string | null | undefined;
  expiresAt?: string | null | undefined;
  possibleSupersedes?: string[] | undefined;
  possibleContradictions?: string[] | undefined;
  relationshipConfidence?: number | undefined;
  relationshipReason?: string | undefined;
};

export type RuntimeMemoryCandidateAcceptResult =
  | {
      alreadyStored: false;
      memory: Memory;
      memoryId: string;
      message: string;
    }
  | {
      alreadyStored: true;
      memory: null;
      memoryId: string;
      message: string;
    };

export type SafeProviderCallMetadata = {
  name: string;
  capability: ProviderCapability;
  model?: string | undefined;
  mock: boolean;
  latencyMs?: number | undefined;
  tokenUsage?: TokenUsage | undefined;
  healthStatus?: ProviderHealth["status"] | undefined;
  fallbackUsed?: boolean | undefined;
  attemptedProviders?: ProviderMetadata["attemptedProviders"];
  finalProvider?: string | undefined;
};

type DirectContextTurn = {
  traceId: string;
  timestamp: string;
  userMessage: string;
  assistantReply: string;
};

type DirectContextBuildResult = {
  enabled: boolean;
  content: string;
  turnCount: number;
  charCount: number;
  truncated: boolean;
  source: string;
};

export type HandleAudioInputInput = STTInput & {
  sessionId: string;
  voiceOutput?: boolean | undefined;
  traceId?: string | undefined;
  parentId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  createdByUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  voiceProfileId?: string | null | undefined;
};

export type HandleImageInputInput = VisionInput & {
  sessionId: string;
  traceId?: string | undefined;
  parentId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  createdByUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  voiceProfileId?: string | null | undefined;
};

export class RuntimeOrchestrator {
  private latestPromptPreview: RuntimePromptPreview | null = null;
  private readonly memoryCandidateHistory: RuntimeMemoryCandidateReview[] = [];
  private readonly sessionTurns = new Map<string, DirectContextTurn[]>();
  private readonly directContextConfig: DirectContextConfig;
  private readonly memoryContextBuilder: Pick<MemoryContextBuilder, "build">;

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    this.directContextConfig = normalizeDirectContextConfig(options.directContext);
    this.memoryContextBuilder = options.memoryContextBuilder ?? new MemoryContextBuilder();
  }

  getLatestPromptPreview(): RuntimePromptPreview | null {
    return this.latestPromptPreview;
  }

  getRecentMemoryCandidates(limit = 20): RuntimeMemoryCandidateReview[] {
    return this.memoryCandidateHistory.slice(0, limit);
  }

  async acceptMemoryCandidate(
    id: string,
    patch: Partial<
      Pick<
        MemoryCandidate,
        | "type"
        | "subtype"
        | "scope"
        | "scopeId"
        | "memoryLayer"
        | "content"
        | "summary"
        | "importance"
        | "tags"
        | "observedAt"
        | "eventTime"
        | "validFrom"
        | "validUntil"
        | "expiresAt"
        | "possibleSupersedes"
        | "possibleContradictions"
      >
    > = {}
  ): Promise<RuntimeMemoryCandidateAcceptResult | null> {
    const review = this.memoryCandidateHistory.find((candidate) => candidate.id === id);
    if (!review || !this.options.memory.rememberCandidate) {
      return null;
    }
    if (review.storedMemoryId) {
      review.decision = "stored";
      review.rejectedReason = undefined;
      return {
        alreadyStored: true,
        memory: null,
        memoryId: review.storedMemoryId,
        message: "Memory candidate was already stored; no duplicate memory was created."
      };
    }

    const contentChanged =
      patch.content !== undefined && patch.content.trim() !== review.content.trim();
    const candidate: MemoryCandidate = {
      type: patch.type ?? review.type,
      content: patch.content ?? review.content,
      summary: patch.summary ?? review.summary ?? null,
      importance: patch.importance ?? review.importance,
      metadata: {
        ...(review.metadata ?? {}),
        acceptedBy: "dashboard",
        acceptedFromCandidateId: review.id,
        ...(contentChanged
          ? {
              temporalNormalized: false,
              canonicalEventDate: undefined,
              canonicalFingerprint: undefined,
              canonicalEventKey: undefined,
              temporalStatus: undefined,
              temporalSuggestion: undefined
            }
          : {})
      },
      tags: patch.tags ?? review.tags,
      reason: review.reason
    };
    const subtype = patch.subtype ?? review.subtype;
    if (subtype !== undefined) {
      candidate.subtype = subtype;
    }
    const scope = patch.scope ?? review.scope;
    if (scope !== undefined) {
      candidate.scope = scope;
    }
    if ((patch.scopeId ?? review.scopeId) !== undefined) {
      candidate.scopeId = patch.scopeId ?? review.scopeId ?? null;
    }
    const memoryLayer = patch.memoryLayer ?? review.memoryLayer;
    if (memoryLayer !== undefined) {
      candidate.memoryLayer = memoryLayer;
    }
    candidate.observedAt = patch.observedAt ?? review.observedAt ?? review.createdAt;
    if (contentChanged) {
      candidate.eventTime = patch.eventTime ?? null;
      candidate.validUntil = patch.validUntil ?? null;
      candidate.expiresAt = patch.expiresAt ?? null;
      if (patch.validFrom !== undefined) {
        candidate.validFrom = patch.validFrom;
      }
    } else {
      candidate.eventTime = patch.eventTime ?? review.eventTime ?? null;
      candidate.validFrom =
        patch.validFrom ?? review.validFrom ?? review.observedAt ?? review.createdAt;
      candidate.validUntil = patch.validUntil ?? review.validUntil ?? null;
      candidate.expiresAt = patch.expiresAt ?? review.expiresAt ?? null;
    }
    candidate.possibleSupersedes = patch.possibleSupersedes ?? review.possibleSupersedes ?? [];
    candidate.possibleContradictions =
      patch.possibleContradictions ?? review.possibleContradictions ?? [];
    if (review.confidence !== undefined) {
      candidate.confidence = review.confidence;
    }
    if (review.sourceTraceId !== undefined) {
      candidate.sourceTraceId = review.sourceTraceId;
    }

    if (this.options.memory.processCandidateForStorage) {
      const result = await this.options.memory.processCandidateForStorage(candidate, {
        source: "dashboard",
        tags: candidate.tags,
        skipAdmissionPolicy: true,
        storageReason: "manual-accept"
      });
      if (result.decision !== "stored" || !result.memory) {
        return null;
      }
      review.decision = "stored";
      review.storedMemoryId = result.memory.id;
      review.rejectedReason = undefined;
      review.storageReason = result.storageReason ?? "manual-accept";
      return {
        alreadyStored: false,
        memory: result.memory,
        memoryId: result.memory.id,
        message: "Memory candidate accepted and saved."
      };
    }

    const memory = await this.options.memory.rememberCandidate(candidate, {
      source: "dashboard",
      tags: candidate.tags
    });
    review.decision = "stored";
    review.storedMemoryId = memory.id;
    review.rejectedReason = undefined;
    review.storageReason = "manual-accept";
    return {
      alreadyStored: false,
      memory,
      memoryId: memory.id,
      message: "Memory candidate accepted and saved."
    };
  }

  rejectMemoryCandidate(
    id: string,
    reason = "Rejected in Dashboard."
  ): RuntimeMemoryCandidateReview | null {
    const review = this.memoryCandidateHistory.find((candidate) => candidate.id === id);
    if (!review) {
      return null;
    }
    if (review.storedMemoryId) {
      review.decision = "stored";
      review.rejectedReason = "Candidate is already stored and was not rejected.";
      return review;
    }
    review.decision = "rejected";
    review.rejectedReason = reason;
    return review;
  }

  async handleUserMessage(
    input: UserMessageEvent | HandleUserMessageInput,
    options: HandleUserMessageOptions = {}
  ): Promise<AgentReplyEvent> {
    const userEvent = isRuntimeUserMessageEvent(input)
      ? input
      : createEvent(
          "user.message",
          {
            sessionId: input.sessionId,
            content: input.content,
            ...identityPayload(input)
          },
          {
            traceId: input.traceId,
            parentId: input.parentId
          }
        );

    await this.persistUserMessage(userEvent);
    await this.options.eventBus.publish(userEvent);
    await this.restoreDirectContext(userEvent.payload.sessionId);
    const voiceOutput = isRuntimeUserMessageEvent(input)
      ? Boolean(options.voiceOutput)
      : Boolean(input.voiceOutput);
    const memoryOptions = resolveMemoryOptions(options);
    const reply = await this.generateReply(userEvent, {
      voiceOutput,
      readMemory: memoryOptions.readMemory,
      writeMemory: memoryOptions.writeMemory,
      publishAgentReply: false
    });
    // Persist the final text before publishing either reply event to transports. Later
    // direct-context, memory, and TTS side effects must not duplicate or retract it.
    await this.publishAssistantMessage(userEvent, reply);
    if (memoryOptions.writeMemory) {
      // Mem0: fire-and-forget so TTS/UI are never blocked by semantic ingestion.
      if (this.options.memory.isMem0Backend?.() && this.options.memory.storeConversationTurn) {
        this.scheduleMem0TurnWrite(userEvent, reply);
      } else {
        const extraction = await this.maybeStoreMemory(userEvent, reply, memoryOptions);
        this.updateLatestPromptPreviewExtraction(extraction);
      }
    } else {
      this.updateLatestPromptPreviewExtraction({
        ...this.getMemoryExtractorStatus(),
        used: false,
        skippedReason: "Memory write was disabled for this turn."
      });
    }
    await this.maybeSynthesizeSpeech(reply, voiceOutput);

    return reply;
  }

  async *streamUserMessage(
    input: UserMessageEvent | HandleUserMessageInput,
    options: StreamUserMessageOptions = {}
  ): AsyncIterable<RuntimeReplyStreamEvent> {
    if (options.signal?.aborted) {
      throw createRuntimeCancelledError();
    }

    const userEvent = isRuntimeUserMessageEvent(input)
      ? input
      : createEvent(
          "user.message",
          {
            sessionId: input.sessionId,
            content: input.content,
            ...identityPayload(input)
          },
          {
            traceId: input.traceId,
            parentId: input.parentId
          }
        );
    const agentReplyId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const voiceOutput = isRuntimeUserMessageEvent(input)
      ? Boolean(options.voiceOutput)
      : Boolean(input.voiceOutput ?? options.voiceOutput);

    await this.persistUserMessage(userEvent);
    await this.options.eventBus.publish(userEvent);
    await this.restoreDirectContext(userEvent.payload.sessionId);
    const { prompt, memoryOptions } = await this.prepareChatPrompt(userEvent, {
      voiceOutput,
      useMemory: options.useMemory,
      readMemory: options.readMemory,
      writeMemory: options.writeMemory
    });

    const chatProvider = this.options.providers.getChatProvider();
    const chatStatus = this.getProviderStatus("chat");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    let providerIterator: AsyncIterator<ChatStreamEvent> | undefined;
    let assistantCreated = false;
    let accumulatedText = "";
    let finalOutput: ChatOutput | undefined;
    let sawCompleted = false;
    let terminalStatus: "completed" | "failed" | "cancelled" | undefined;
    let finalized = false;
    let failure: unknown;
    const startedAt = performance.now();

    try {
      if (controller.signal.aborted) {
        throw createRuntimeCancelledError(chatProvider.name);
      }
      const providerStream = chatProvider.streamReply
        ? chatProvider.streamReply({ messages: prompt.messages }, { signal: controller.signal })
        : compatibleRuntimeStream(chatProvider, { messages: prompt.messages }, controller.signal);
      providerIterator = providerStream[Symbol.asyncIterator]();

      while (true) {
        let next: IteratorResult<ChatStreamEvent>;
        try {
          next = await providerIterator.next();
        } catch (error) {
          throw normalizeRuntimeStreamError(error, chatProvider.name, controller.signal);
        }
        if (next.done) {
          break;
        }
        const event = next.value;
        if (controller.signal.aborted) {
          throw createRuntimeCancelledError(chatProvider.name);
        }
        if (sawCompleted) {
          throw runtimeStreamProtocolError(
            chatProvider.name,
            "Provider emitted an event after completed."
          );
        }

        if (event.type === "text-delta") {
          if (!event.text) {
            throw runtimeStreamProtocolError(
              chatProvider.name,
              "Provider emitted an empty text delta."
            );
          }
          if (!assistantCreated && this.options.conversation) {
            await this.createStreamingAssistantMessage({
              id: assistantMessageId,
              sessionId: userEvent.payload.sessionId,
              traceId: userEvent.traceId,
              parentMessageId: agentReplyId,
              content: event.text,
              createdAt: new Date().toISOString()
            });
            assistantCreated = true;
          } else if (assistantCreated) {
            await this.appendStreamingAssistantContent(assistantMessageId, event.text);
          }
          accumulatedText += event.text;
          yield {
            type: "text-delta",
            text: event.text,
            messageId: assistantMessageId,
            sessionId: userEvent.payload.sessionId,
            traceId: userEvent.traceId
          };
          continue;
        }

        if (event.type === "completed") {
          if (sawCompleted) {
            throw runtimeStreamProtocolError(
              chatProvider.name,
              "Provider emitted multiple completed events."
            );
          }
          if (event.output.message.content !== accumulatedText) {
            throw runtimeStreamProtocolError(
              chatProvider.name,
              "Provider completed output did not match persisted text deltas."
            );
          }
          sawCompleted = true;
          finalOutput = event.output;
          continue;
        }

        throw runtimeStreamProtocolError(
          chatProvider.name,
          "Provider emitted an unknown stream event."
        );
      }

      if (!finalOutput || !sawCompleted) {
        throw runtimeStreamProtocolError(
          chatProvider.name,
          "Provider stream ended without completion."
        );
      }

      const providerMetadata = this.safeProviderCallMetadata(
        "chat",
        chatProvider.name,
        finalOutput,
        chatStatus
      );
      if (this.latestPromptPreview) {
        this.latestPromptPreview = {
          ...this.latestPromptPreview,
          providerName: providerMetadata.name,
          providerModel: providerMetadata.model,
          providerMock: providerMetadata.mock,
          providerLatencyMs: finalOutput.latencyMs ?? Math.round(performance.now() - startedAt),
          providerHealthStatus: providerMetadata.healthStatus,
          tokenUsage: providerMetadata.tokenUsage,
          ...this.extractorPreviewFields({
            ...this.getMemoryExtractorStatus(),
            used: false
          })
        };
      }

      if (this.options.conversation && !assistantCreated) {
        await this.createStreamingAssistantMessage({
          id: assistantMessageId,
          sessionId: userEvent.payload.sessionId,
          traceId: userEvent.traceId,
          parentMessageId: agentReplyId,
          content: accumulatedText,
          createdAt: new Date().toISOString()
        });
        assistantCreated = true;
      }
      if (this.options.conversation) {
        await this.completeStreamingAssistantMessage(assistantMessageId, {
          provider: providerMetadata,
          model: providerMetadata.model,
          tokenUsage: providerMetadata.tokenUsage
        });
      }

      const reply = this.createAgentReply(
        userEvent,
        finalOutput.message.content,
        providerMetadata,
        agentReplyId
      );
      await this.options.eventBus.publish(reply);
      this.recordDirectContextTurn(userEvent, reply);
      const assistantMessage = this.createAssistantMessageEvent(reply, assistantMessageId);
      await this.options.eventBus.publish(assistantMessage);

      // Final persistence and user-visible events establish the completed reply.
      // Optional post-processing must not move it back to failed/cancelled or
      // prevent the Runtime completed event from being delivered.
      finalized = true;
      terminalStatus = "completed";
      if (!options.signal?.aborted) {
        try {
          if (memoryOptions.writeMemory) {
            if (
              this.options.memory.isMem0Backend?.() &&
              this.options.memory.storeConversationTurn
            ) {
              this.scheduleMem0TurnWrite(userEvent, reply, assistantMessageId);
            } else {
              const extraction = await this.maybeStoreMemory(userEvent, reply, memoryOptions);
              this.updateLatestPromptPreviewExtraction(extraction);
            }
          } else {
            this.updateLatestPromptPreviewExtraction({
              ...this.getMemoryExtractorStatus(),
              used: false,
              skippedReason: "Memory write was disabled for this turn."
            });
          }
        } catch (error) {
          await this.publishRuntimeError("Optional memory post-processing failed.", error, {
            traceId: reply.traceId,
            parentId: reply.id
          });
          this.options.logger?.warn?.(
            "optional memory post-processing failed",
            this.errorLogContext(error, reply.traceId)
          );
        }
      }
      if (!options.signal?.aborted) {
        try {
          await this.maybeSynthesizeSpeech(reply, voiceOutput);
        } catch (error) {
          await this.publishRuntimeError("Optional TTS post-processing failed.", error, {
            traceId: reply.traceId,
            parentId: reply.id
          });
          this.options.logger?.warn?.(
            "optional TTS post-processing failed",
            this.errorLogContext(error, reply.traceId)
          );
        }
      }
      yield {
        type: "completed",
        messageId: assistantMessageId,
        sessionId: userEvent.payload.sessionId,
        traceId: userEvent.traceId,
        content: finalOutput.message.content,
        provider: providerMetadata.finalProvider ?? providerMetadata.name
      };
    } catch (error) {
      failure = error;
    } finally {
      controller.abort();
      try {
        await providerIterator?.return?.();
      } catch (closeError) {
        this.options.logger?.warn?.(
          "failed to close runtime provider stream",
          this.errorLogContext(closeError, userEvent.traceId)
        );
      }

      if (!finalized) {
        const cancelled =
          failure === undefined ||
          (failure instanceof ProviderError && failure.code === ProviderErrorCode.Cancelled);
        terminalStatus = cancelled ? "cancelled" : "failed";
        if (assistantCreated) {
          await this.failStreamingAssistantMessage(assistantMessageId, terminalStatus, {
            error:
              failure instanceof Error ? redactUnsafeText(safeErrorMessage(failure)) : undefined
          });
        }
        if (failure === undefined && terminalStatus === "cancelled") {
          failure = createRuntimeCancelledError(chatProvider.name);
        }
        if (failure !== undefined && !(failure instanceof ConversationPersistenceError)) {
          if (failure instanceof ProviderError) {
            await this.publishProviderError(failure, {
              capability: "chat",
              provider: chatProvider.name,
              latencyMs: Math.round(performance.now() - startedAt),
              traceId: userEvent.traceId,
              parentId: userEvent.id
            });
          } else {
            await this.publishRuntimeError("Runtime stream failed.", failure, {
              traceId: userEvent.traceId,
              parentId: userEvent.id,
              category: "stream"
            });
          }
        }
      }
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (failure !== undefined) {
      throw failure;
    }
  }

  async handleAudioInput(input: HandleAudioInputInput): Promise<AgentReplyEvent> {
    const sttProvider = this.options.providers.getSTTProvider();
    const transcript = await this.measureProvider(
      "stt",
      sttProvider.name,
      () => sttProvider.transcribeAudio(input),
      { traceId: input.traceId, parentId: input.parentId }
    );

    const transcriptEvent = createEvent(
      "user.voice.transcript",
      {
        sessionId: input.sessionId,
        content: transcript.text,
        language: transcript.language,
        confidence: transcript.confidence,
        ...identityPayload(input)
      },
      {
        traceId: input.traceId,
        parentId: input.parentId
      }
    );

    await this.options.eventBus.publish(transcriptEvent);
    const reply = await this.generateReply(transcriptEvent, {
      voiceOutput: Boolean(input.voiceOutput),
      readMemory: true,
      writeMemory: true
    });
    this.recordDirectContextTurn(transcriptEvent, reply);
    await this.maybeStoreMemory(transcriptEvent, reply);
    await this.maybeSynthesizeSpeech(reply, Boolean(input.voiceOutput));
    return reply;
  }

  async handleImageInput(input: HandleImageInputInput): Promise<PerceptionVisionEvent> {
    const visionProvider = this.options.providers.getVisionProvider();
    const vision = await this.measureProvider(
      "vision",
      visionProvider.name,
      () => visionProvider.analyzeImage(input),
      { traceId: input.traceId, parentId: input.parentId }
    );

    const event = createEvent(
      "perception.vision",
      {
        sessionId: input.sessionId,
        text: vision.text,
        objects: vision.objects,
        sceneSummary: vision.sceneSummary,
        confidence: vision.confidence
      },
      {
        traceId: input.traceId,
        parentId: input.parentId
      }
    );

    await this.options.eventBus.publish(event);
    return event;
  }

  private async prepareChatPrompt(
    event: UserMessageEvent | UserVoiceTranscriptEvent,
    options: {
      voiceOutput?: boolean | undefined;
      useMemory?: boolean | undefined;
      readMemory?: boolean | undefined;
      writeMemory?: boolean | undefined;
    } = {}
  ): Promise<{
    prompt: PromptBuildOutput;
    memoryOptions: ResolvedMemoryOptions;
  }> {
    const voiceOutput = Boolean(options.voiceOutput);
    const memoryOptions = resolveMemoryOptions(options);
    const currentAffect = detectCurrentAffect({
      text: event.payload.content,
      sourceTraceId: event.traceId
    });
    // Explicit forget runs before search so deleted facts are not re-injected.
    let forgetNote: string | undefined;
    if (
      memoryOptions.writeMemory &&
      this.options.memory.isMem0Backend?.() &&
      this.options.memory.forgetExplicitMemory &&
      detectExplicitForgetRequest(event.payload.content)
    ) {
      try {
        const forget = await this.options.memory.forgetExplicitMemory({
          userMessage: event.payload.content,
          personaId: event.payload.personaId,
          subjectUserId: event.payload.subjectUserId
        });
        forgetNote = forget.notFound
          ? "The user asked to forget something, but no matching memory was found in this scope."
          : `The user asked to forget something; deleted ${forget.deleted} related memor${forget.deleted === 1 ? "y" : "ies"} in the current scope only.`;
      } catch (error) {
        this.options.logger?.warn?.(
          "mem0 forget failed",
          this.errorLogContext(error, event.traceId)
        );
        forgetNote =
          "The user asked to forget something, but memory deletion failed; continue without claiming success.";
      }
    }
    const directContext = this.buildDirectContext(event.payload.sessionId);
    const memoryContext = memoryOptions.readMemory
      ? await this.retrieveMemories(event, {
          currentTurnText: event.payload.content,
          directContextText: directContext.content
        })
      : emptyMemoryContext();
    // Prompt only gets displayText content — never raw memoryId/score/metadata dumps.
    const promptMemories = memoryContext.promptMemories.map((memory) =>
      isPromptMemoryCompatibility(memory)
        ? memory
        : {
            content: memory.displayText,
            displayText: memory.displayText,
            importance: memory.importance,
            type: memory.type,
            subtype: memory.subtype,
            scope: memory.scope,
            scopeId: memory.scopeId,
            memoryLayer: memory.memoryLayer,
            status: memory.status,
            ...(memory.validFrom !== undefined ? { validFrom: memory.validFrom } : {}),
            ...(memory.eventTime !== undefined ? { eventTime: memory.eventTime } : {}),
            ...(memory.validUntil !== undefined ? { validUntil: memory.validUntil } : {}),
            ...(memory.expiresAt !== undefined ? { expiresAt: memory.expiresAt } : {}),
            createdAt: memory.createdAt,
            ...(memory.lastAccessedAt !== undefined
              ? { lastAccessedAt: memory.lastAccessedAt }
              : {})
          }
    );
    const situationParts = [
      voiceOutput
        ? "The user is interacting through voice."
        : "The user is interacting through text."
    ];
    if (forgetNote) {
      situationParts.push(forgetNote);
    }
    const prompt = this.options.promptBuilder.buildPrompt({
      systemIdentity:
        "You are YUVI, a local-first AI companion runtime agent. Unless the user clearly asks for another language, reply in natural spoken English by default.",
      characterStyle:
        "Warm, concise, conversational, and practical. Prefer short replies of about 1-3 sentences in ordinary chat and expand only when the user asks for detail. Do not default to Japanese or Chinese, do not auto-translate English into Japanese for voice, and do not produce bilingual replies. If the user mainly writes Chinese or Japanese, or explicitly requests Chinese or Japanese, reply in that language.",
      relationshipContext:
        "Use remembered context only when relevant. Do not pretend to remember details that were not retrieved.",
      retrievedMemories: promptMemories,
      memoryEnabled: memoryOptions.readMemory,
      currentTime: currentTimeContext(),
      ...(currentAffect ? { currentAffect: formatCurrentAffectForPrompt(currentAffect) } : {}),
      directContext: directContext.content,
      directContextEnabled: directContext.enabled,
      currentSituation: situationParts.join(" "),
      tools: [],
      userMessage: event.payload.content
    });
    this.latestPromptPreview = {
      traceId: event.traceId,
      timestamp: new Date().toISOString(),
      userMessage: event.payload.content,
      legacyUseMemory: memoryOptions.legacyUseMemory,
      useMemory: memoryOptions.readMemory && memoryOptions.writeMemory,
      readMemory: memoryOptions.readMemory,
      writeMemory: memoryOptions.writeMemory,
      memoryReadEnabled: memoryOptions.readMemory,
      memoryWriteEnabled: memoryOptions.writeMemory,
      memoryRepository: this.options.memoryRepository ?? "in-memory",
      retrievedMemoryCountRaw: memoryContext.retrievedMemoryCountRaw,
      retrievedMemoryCount: memoryContext.retrievedMemoryCount,
      ...(memoryContext.memoryProviderStatus !== undefined
        ? { memoryProviderStatus: memoryContext.memoryProviderStatus }
        : {}),
      ...(memoryContext.memoryFinalStatus !== undefined
        ? { memoryFinalStatus: memoryContext.memoryFinalStatus }
        : {}),
      ...(memoryContext.memoryProviderSource !== undefined
        ? { memoryProviderSource: memoryContext.memoryProviderSource }
        : {}),
      ...(memoryContext.memoryProviderErrorCode !== undefined
        ? { memoryProviderErrorCode: memoryContext.memoryProviderErrorCode }
        : {}),
      memoryRetrievalLimited: memoryContext.memoryRetrievalLimited,
      memoryQueryLength: memoryContext.memoryQueryLength,
      memoryRetrievalEventIds: memoryContext.memoryRetrievalEventIds,
      memoryRetrievalDroppedCount: memoryContext.memoryRetrievalDroppedCount,
      memoryRetrievalDropped: memoryContext.memoryRetrievalDropped,
      memoryMetadataPresent: memoryContext.memoryMetadataPresent,
      memorySourceTurnLinkCount: memoryContext.memorySourceTurnLinkCount,
      memoryConversationLinked: memoryContext.memoryConversationLinked,
      memoryParticipantsCount: memoryContext.memoryParticipantsCount,
      memoryFallbackProducedResults: memoryContext.memoryFallbackProducedResults,
      memoryFallbackUsed: memoryContext.memoryFallbackUsed,
      ...(memoryContext.memoryFallbackReason !== undefined
        ? { memoryFallbackReason: memoryContext.memoryFallbackReason }
        : {}),
      ...(memoryContext.memoryFallbackSource !== undefined
        ? { memoryFallbackSource: memoryContext.memoryFallbackSource }
        : {}),
      retrievalMode: memoryContext.retrievalMode,
      vectorEnabled: memoryContext.vectorEnabled,
      vectorUsed: memoryContext.vectorUsed,
      embeddingProvider: memoryContext.embeddingProvider,
      embeddingModel: memoryContext.embeddingModel,
      embeddingDimensions: memoryContext.embeddingDimensions,
      semanticEmbedding: memoryContext.semanticEmbedding,
      embeddingNote: memoryContext.embeddingNote,
      queryEmbeddingGenerated: memoryContext.queryEmbeddingGenerated,
      vectorResultCount: memoryContext.vectorResultCount,
      keywordResultCount: memoryContext.keywordResultCount,
      hybridResultCount: memoryContext.hybridResultCount,
      retrievalFallbackUsed: memoryContext.retrievalFallbackUsed,
      retrievalFallbackReason: memoryContext.retrievalFallbackReason,
      retrievedMemories: memoryContext.retrievedMemories,
      retrievalScope: memoryContext.retrievalScope,
      includedScopes: memoryContext.includedScopes,
      includeArchived: memoryContext.includeArchived,
      includeSuperseded: memoryContext.includeSuperseded,
      includeExpired: memoryContext.includeExpired,
      currentTime: memoryContext.currentTime,
      ...(currentAffect ? { currentAffect } : {}),
      directContextEnabled: directContext.enabled,
      directContextTurnCount: directContext.turnCount,
      directContextCharCount: directContext.charCount,
      directContextTruncated: directContext.truncated,
      directContextSource: directContext.source,
      excludedByStatus: memoryContext.excludedByStatus,
      excludedByTime: memoryContext.excludedByTime,
      excludedByScope: memoryContext.excludedByScope,
      sections: prompt.sections,
      finalMessages: prompt.messages,
      finalPrompt: prompt.prompt,
      characterCount: prompt.characterCount,
      estimatedTokens: prompt.estimatedTokens,
      truncated: prompt.truncated,
      ...this.extractorPreviewFields(
        this.getMemoryExtractorStatus(
          memoryOptions.writeMemory ? undefined : "Memory write was disabled for this turn."
        )
      )
    };

    return { prompt, memoryOptions };
  }

  async generateReply(
    event: UserMessageEvent | UserVoiceTranscriptEvent,
    options: {
      voiceOutput?: boolean | undefined;
      useMemory?: boolean | undefined;
      readMemory?: boolean | undefined;
      writeMemory?: boolean | undefined;
      publishAgentReply?: boolean | undefined;
    } = {}
  ): Promise<AgentReplyEvent> {
    const { prompt, memoryOptions } = await this.prepareChatPrompt(event, options);

    const chatProvider = this.options.providers.getChatProvider();
    const chatStatus = this.getProviderStatus("chat");
    const output = await this.measureProvider(
      "chat",
      chatProvider.name,
      () =>
        chatProvider.generateReply({
          messages: prompt.messages
        }),
      { traceId: event.traceId, parentId: event.id }
    );
    const providerMetadata = this.safeProviderCallMetadata(
      "chat",
      chatProvider.name,
      output,
      chatStatus
    );
    if (this.latestPromptPreview) {
      this.latestPromptPreview = {
        ...this.latestPromptPreview,
        providerName: providerMetadata.name,
        providerModel: providerMetadata.model,
        providerMock: providerMetadata.mock,
        providerLatencyMs: providerMetadata.latencyMs,
        providerHealthStatus: providerMetadata.healthStatus,
        tokenUsage: providerMetadata.tokenUsage,
        ...this.extractorPreviewFields({
          ...this.getMemoryExtractorStatus(),
          used: false
        })
      };
    }

    const reply = this.createAgentReply(event, output.message.content, providerMetadata);
    if (options.publishAgentReply !== false) {
      await this.options.eventBus.publish(reply);
    }
    return reply;
  }

  async maybeSynthesizeSpeech(
    reply: AgentReplyEvent,
    voiceOutput: boolean
  ): Promise<AvatarSpeakEvent | null> {
    if (!voiceOutput) {
      return null;
    }

    const ttsProvider = this.options.providers.getTTSProvider();
    try {
      const speech = await this.measureProvider(
        "tts",
        ttsProvider.name,
        () =>
          ttsProvider.synthesizeSpeech({
            text: reply.payload.content
          }),
        { traceId: reply.traceId, parentId: reply.id }
      );

      const event = createEvent(
        "avatar.speak",
        {
          sessionId: reply.payload.sessionId,
          text: reply.payload.content,
          audioBase64: speech.audioBase64,
          mimeType: speech.mimeType,
          durationMs: speech.durationMs
        },
        {
          traceId: reply.traceId,
          parentId: reply.id
        }
      );

      await this.options.eventBus.publish(event);
      return event;
    } catch (error) {
      this.options.logger?.warn?.(
        "optional tts synthesis failed",
        this.errorLogContext(error, reply.traceId)
      );
      return null;
    }
  }

  private scheduleMem0TurnWrite(
    sourceEvent: UserMessageEvent | UserVoiceTranscriptEvent,
    reply: AgentReplyEvent,
    assistantMessageId?: string
  ): void {
    const store = this.options.memory.storeConversationTurn;
    if (!store) {
      return;
    }
    // Skip cancelled/empty assistant content — streaming failure must not write.
    const assistantText = reply.payload.content?.trim() ?? "";
    if (!assistantText) {
      this.updateLatestPromptPreviewExtraction({
        ...this.getMemoryExtractorStatus(),
        used: false,
        skippedReason: "Mem0 write skipped: empty or failed assistant turn."
      });
      return;
    }
    // Explicit forget is handled on the read path only; never schedule add.
    if (detectExplicitForgetRequest(sourceEvent.payload.content)) {
      this.updateLatestPromptPreviewExtraction({
        ...this.getMemoryExtractorStatus(),
        used: false,
        skippedReason: "Mem0 write skipped: explicit_forget turn."
      });
      return;
    }
    const isRemember = detectExplicitRememberRequest(sourceEvent.payload.content);
    this.updateLatestPromptPreviewExtraction({
      ...this.getMemoryExtractorStatus(),
      used: true,
      candidateCount: 1,
      storedMemoryCount: 0,
      rejectedCount: 0,
      rejectedReasons: [],
      candidates: [],
      skippedReason: isRemember
        ? "Mem0 async factual write scheduled (explicit user claim)."
        : "Mem0 async factual write scheduled."
    });
    void store({
      userMessage: sourceEvent.payload.content,
      assistantMessage: assistantText,
      sessionId: sourceEvent.payload.sessionId,
      personaId: sourceEvent.payload.personaId,
      subjectUserId: sourceEvent.payload.subjectUserId,
      userMessageId: sourceEvent.id,
      assistantMessageId: assistantMessageId ?? reply.id,
      traceId: sourceEvent.traceId,
      conversationId: sourceEvent.payload.sessionId
    })
      .then((result) => {
        this.updateLatestPromptPreviewExtraction({
          ...this.getMemoryExtractorStatus(),
          used: true,
          candidateCount: 1,
          storedMemoryCount: result.ok ? 1 : 0,
          rejectedCount: result.ok ? 0 : 1,
          rejectedReasons: result.ok ? [] : [result.skippedReason ?? "mem0-write-failed"],
          candidates: [],
          ...(result.ok
            ? {}
            : { skippedReason: result.skippedReason ?? "Mem0 turn write failed." })
        });
      })
      .catch((error: unknown) => {
        this.options.logger?.warn?.(
          "mem0 async turn write failed",
          this.errorLogContext(error, reply.traceId)
        );
      });
  }

  async maybeStoreMemory(
    sourceEvent: UserMessageEvent | UserVoiceTranscriptEvent,
    reply: AgentReplyEvent,
    memoryOptions: { readMemory: boolean; writeMemory: boolean } = {
      readMemory: true,
      writeMemory: true
    }
  ): Promise<MemoryExtractionRuntimeDebug> {
    const initialExtractorStatus = this.getMemoryExtractorStatus();
    try {
      // Mem0 path: never run Legacy extract/dedupe/embed/repository write.
      if (this.options.memory.isMem0Backend?.()) {
        if (this.options.memory.storeConversationTurn) {
          const result = await this.options.memory.storeConversationTurn({
            userMessage: sourceEvent.payload.content,
            assistantMessage: reply.payload.content,
            sessionId: sourceEvent.payload.sessionId,
            personaId: sourceEvent.payload.personaId,
            subjectUserId: sourceEvent.payload.subjectUserId,
            userMessageId: sourceEvent.id,
            assistantMessageId: reply.id,
            traceId: sourceEvent.traceId,
            conversationId: sourceEvent.payload.sessionId
          });
          return {
            ...initialExtractorStatus,
            used: true,
            candidateCount: 1,
            storedMemoryCount: result.ok ? 1 : 0,
            rejectedCount: result.ok ? 0 : 1,
            rejectedReasons: result.ok ? [] : [result.skippedReason ?? "mem0-write-failed"],
            candidates: [],
            ...(result.ok
              ? {}
              : { skippedReason: result.skippedReason ?? "Mem0 turn write failed." })
          };
        }
        return {
          ...initialExtractorStatus,
          used: false,
          candidateCount: 0,
          storedMemoryCount: 0,
          rejectedCount: 0,
          rejectedReasons: [],
          candidates: [],
          skippedReason: "Mem0 backend has no storeConversationTurn handler."
        };
      }

      if (this.options.memory.extractCandidates) {
        const candidates = await this.options.memory.extractCandidates({
          sessionId: sourceEvent.payload.sessionId,
          userMessage: sourceEvent.payload.content,
          assistantMessage: reply.payload.content,
          sourceTraceId: sourceEvent.traceId,
          timestamp: new Date().toISOString(),
          ...identityPayload(sourceEvent.payload),
          providerMetadata: isSafeProviderCallMetadata(reply.payload.provider)
            ? reply.payload.provider
            : undefined,
          memoryOptions
        });
        const extractorStatus = this.getMemoryExtractorStatus();
        const decisions = await Promise.all(
          candidates.map((candidate) =>
            this.processCandidateForStorage(candidate, {
              source: "runtime",
              tags: [sourceEvent.payload.sessionId]
            })
          )
        );
        const selected = decisions
          .filter((decision) => decision.decision === "stored")
          .map((decision) => decision.candidate);
        const storedMemories = decisions
          .map((decision) => decision.memory)
          .filter((memory): memory is Memory => Boolean(memory));
        const rejectedReasons = [
          ...(extractorStatus.rejectedReasons ?? []),
          ...decisions
            .filter((decision) => decision.decision === "rejected")
            .map((decision) => decision.rejectedReason ?? "rejected")
        ];
        const reviewedCandidates = this.recordMemoryCandidates({
          candidates,
          decisions,
          storedMemories,
          sourceTraceId: sourceEvent.traceId,
          rejectedReasons,
          extractorStatus
        });
        return {
          ...extractorStatus,
          used: true,
          candidateCount: candidates.length,
          storedMemoryCount: selected.length,
          rejectedCount: decisions.filter((decision) => decision.decision === "rejected").length,
          rejectedReasons,
          candidates: reviewedCandidates,
          ...(selected.length > 0
            ? {}
            : { skippedReason: "Memory service rejected all extracted candidates." })
        };
      }

      const importance = this.options.memory.scoreImportance(
        `${sourceEvent.payload.content}\n${reply.payload.content}`
      );
      if (importance < 0.65) {
        return {
          ...initialExtractorStatus,
          used: false,
          candidateCount: 0,
          storedMemoryCount: 0,
          rejectedCount: 0,
          rejectedReasons: [],
          candidates: [],
          skippedReason: "Legacy memory score was below write threshold."
        };
      }

      await this.options.memory.rememberInteraction({
        userMessage: sourceEvent.payload.content,
        assistantMessage: reply.payload.content,
        source: "runtime",
        sourceTraceId: sourceEvent.traceId,
        tags: [sourceEvent.payload.sessionId]
      });
      return {
        ...initialExtractorStatus,
        used: true,
        candidateCount: 1,
        storedMemoryCount: 1,
        rejectedCount: 0,
        rejectedReasons: [],
        candidates: []
      };
    } catch (error) {
      await this.publishRuntimeError("Memory write failed after reply generation.", error, {
        traceId: reply.traceId,
        parentId: reply.id
      });
      this.options.logger?.warn?.(
        "optional memory write failed",
        this.errorLogContext(error, reply.traceId)
      );
      return {
        ...initialExtractorStatus,
        used: false,
        candidateCount: 0,
        storedMemoryCount: 0,
        rejectedCount: 0,
        rejectedReasons: [],
        candidates: [],
        error: safeErrorMessage(error),
        skippedReason: "Memory extraction failed and was skipped."
      };
    }
  }

  async publishAgentReply(
    sourceEvent: UserMessageEvent | UserVoiceTranscriptEvent,
    content: string,
    provider?: SafeProviderCallMetadata | undefined
  ): Promise<AgentReplyEvent> {
    const reply = this.createAgentReply(sourceEvent, content, provider);
    await this.options.eventBus.publish(reply);
    return reply;
  }

  private createAgentReply(
    sourceEvent: UserMessageEvent | UserVoiceTranscriptEvent,
    content: string,
    provider?: SafeProviderCallMetadata | undefined,
    id?: string | undefined
  ): AgentReplyEvent {
    const event = createEvent(
      "agent.reply",
      {
        sessionId: sourceEvent.payload.sessionId,
        content,
        ...(provider ? { provider } : {})
      },
      {
        traceId: sourceEvent.traceId,
        parentId: sourceEvent.id
      }
    );
    return id ? { ...event, id } : event;
  }

  private createAssistantMessageEvent(
    reply: AgentReplyEvent,
    id?: string | undefined
  ): AssistantMessageEvent {
    const event = createEvent(
      "assistant.message",
      {
        sessionId: reply.payload.sessionId,
        content: reply.payload.content,
        ...(reply.payload.provider ? { provider: reply.payload.provider } : {})
      },
      {
        traceId: reply.traceId,
        parentId: reply.id
      }
    );
    return id ? { ...event, id } : event;
  }

  private async publishAssistantMessage(
    sourceEvent: UserMessageEvent,
    reply: AgentReplyEvent
  ): Promise<AssistantMessageEvent> {
    const assistantMessage = this.createAssistantMessageEvent(reply);

    try {
      await this.options.conversation?.appendMessage(
        conversationMessageFromEvent(assistantMessage, "assistant", "completed")
      );
    } catch (error) {
      await this.publishPersistenceError(
        "assistant_message_save",
        "Assistant message persistence failed.",
        error,
        { traceId: reply.traceId, parentId: reply.id }
      );
      this.options.logger?.error?.("assistant message persistence failed", {
        ...this.errorLogContext(error, reply.traceId),
        operation: "assistant_message_save"
      });
      throw new ConversationPersistenceError(
        "assistant_message_save",
        "The assistant response could not be saved."
      );
    }

    // Persist the final text before exposing the compatibility reply to transports.
    await this.options.eventBus.publish(reply);
    this.recordDirectContextTurn(sourceEvent, reply);
    await this.options.eventBus.publish(assistantMessage);
    return assistantMessage;
  }

  private async createStreamingAssistantMessage(input: {
    id: string;
    sessionId: string;
    traceId: string;
    parentMessageId: string;
    content: string;
    createdAt: string;
  }): Promise<void> {
    const conversation = this.options.conversation;
    if (!conversation) {
      return;
    }
    try {
      await conversation.appendMessage({
        id: input.id,
        sessionId: input.sessionId,
        traceId: input.traceId,
        parentMessageId: input.parentMessageId,
        role: "assistant",
        content: input.content,
        status: "streaming",
        createdAt: input.createdAt,
        completedAt: null,
        metadata: {}
      });
    } catch (error) {
      await this.publishPersistenceError(
        "assistant_stream_create",
        "Streaming assistant message creation failed.",
        error,
        { traceId: input.traceId, parentId: input.parentMessageId }
      );
      throw new ConversationPersistenceError(
        "assistant_stream_create",
        "The streaming assistant response could not be created."
      );
    }
  }

  private async appendStreamingAssistantContent(messageId: string, delta: string): Promise<void> {
    const conversation = this.options.conversation;
    if (!conversation) {
      return;
    }
    try {
      await conversation.appendMessageContent(messageId, delta);
    } catch (error) {
      await this.publishPersistenceError(
        "assistant_stream_append",
        "Streaming assistant message append failed.",
        error,
        { traceId: undefined, parentId: messageId }
      );
      throw new ConversationPersistenceError(
        "assistant_stream_append",
        "The streaming assistant response could not be saved."
      );
    }
  }

  private async completeStreamingAssistantMessage(
    messageId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const conversation = this.options.conversation;
    if (!conversation) {
      return;
    }
    try {
      await conversation.completeMessage(messageId, metadata);
    } catch (error) {
      await this.publishPersistenceError(
        "assistant_stream_complete",
        "Streaming assistant message completion failed.",
        error,
        { traceId: undefined, parentId: messageId }
      );
      throw new ConversationPersistenceError(
        "assistant_stream_complete",
        "The streaming assistant response could not be finalized."
      );
    }
  }

  private async failStreamingAssistantMessage(
    messageId: string,
    status: "failed" | "cancelled",
    metadata: Record<string, unknown>
  ): Promise<void> {
    const conversation = this.options.conversation;
    if (!conversation) {
      return;
    }
    try {
      await conversation.failMessage(messageId, status, metadata);
    } catch (error) {
      await this.publishPersistenceError(
        "assistant_stream_fail",
        "Streaming assistant message failure state could not be saved.",
        error,
        { traceId: undefined, parentId: messageId }
      );
      this.options.logger?.warn?.(
        "streaming assistant failure state could not be saved",
        this.errorLogContext(error)
      );
    }
  }

  private async persistUserMessage(userEvent: UserMessageEvent): Promise<void> {
    if (!this.options.conversation) {
      return;
    }

    try {
      await this.options.conversation.ensureSession(userEvent.payload.sessionId);
    } catch (error) {
      await this.publishPersistenceError("session_create", "Session persistence failed.", error, {
        traceId: userEvent.traceId,
        parentId: userEvent.parentId
      });
      this.options.logger?.error?.("session persistence failed", {
        ...this.errorLogContext(error, userEvent.traceId),
        operation: "session_create"
      });
      throw new ConversationPersistenceError("session_create", "The session could not be saved.");
    }

    try {
      await this.options.conversation.appendMessage(
        conversationMessageFromEvent(userEvent, "user", "completed")
      );
    } catch (error) {
      await this.publishPersistenceError(
        "user_message_save",
        "User message persistence failed.",
        error,
        { traceId: userEvent.traceId, parentId: userEvent.parentId }
      );
      this.options.logger?.error?.("user message persistence failed", {
        ...this.errorLogContext(error, userEvent.traceId),
        operation: "user_message_save"
      });
      throw new ConversationPersistenceError(
        "user_message_save",
        "The user message could not be saved."
      );
    }
  }

  private async restoreDirectContext(sessionId: string): Promise<void> {
    const conversation = this.options.conversation;
    if (!conversation || !this.directContextConfig.enabled || this.sessionTurns.has(sessionId)) {
      return;
    }

    try {
      const maxStoredTurns = Math.max(this.directContextConfig.maxTurns * 3, 12);
      const messages = await conversation.listRecentMessages(sessionId, {
        limit: maxStoredTurns * 2,
        maxCharacters: this.directContextConfig.maxChars * 2
      });
      const turns = buildDirectContextTurns(messages).slice(-maxStoredTurns);
      this.sessionTurns.set(sessionId, turns);
    } catch (error) {
      await this.publishPersistenceError(
        "context_restore",
        "Conversation context restore failed; continuing without persisted context.",
        error,
        { traceId: undefined, parentId: undefined }
      );
      this.options.logger?.warn?.("conversation context restore failed", {
        ...this.errorLogContext(error),
        operation: "context_restore",
        sessionId
      });
      this.sessionTurns.set(sessionId, []);
    }
  }

  async maybeGenerateReasoning(input: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    purpose: "planning" | "reflection" | "memory_consolidation";
  }): Promise<string> {
    const reasoningProvider = this.options.providers.getReasoningProvider();
    const output = await this.measureProvider("reasoning", reasoningProvider.name, () =>
      reasoningProvider.generateReasoning({
        messages: input.messages,
        effort: input.purpose === "planning" ? "high" : "medium"
      })
    );

    return output.reasoning;
  }

  private async retrieveMemories(
    event: UserMessageEvent | UserVoiceTranscriptEvent,
    options: MemoryContextBuildOptions = {}
  ): Promise<MemoryContext> {
    let memoryContext: MemoryContext;
    const provider = this.options.memory.getMemoryProvider?.();
    let providerOutcome: Awaited<ReturnType<MemoryProvider["retrieveRelevant"]>> | undefined;
    try {
      if (provider) {
        providerOutcome = await this.retrieveFromProvider(provider, event);
        if (isUsableProviderOutcome(providerOutcome.status)) {
          memoryContext = this.buildProviderMemoryContext(providerOutcome, options);
        } else {
          memoryContext = await this.retrieveLegacyMemories(event);
          memoryContext = dedupeLegacyMemoryContext(memoryContext, options);
          memoryContext = annotateProviderFallback(memoryContext, providerOutcome);
        }
      } else {
        memoryContext = await this.retrieveLegacyMemories(event);
        memoryContext = dedupeLegacyMemoryContext(memoryContext, options);
        memoryContext.memoryFallbackUsed = true;
        memoryContext.memoryFallbackProducedResults = memoryContext.retrievedMemoryCountRaw > 0;
        memoryContext.memoryFallbackReason = "provider-not-configured";
        memoryContext.memoryFallbackSource = "legacy";
      }
    } catch (error) {
      memoryContext = emptyMemoryContext();
      if (providerOutcome && !isUsableProviderOutcome(providerOutcome.status)) {
        memoryContext = annotateProviderFallback(memoryContext, providerOutcome);
      }
      await this.publishRuntimeError(
        "Memory retrieval failed; continuing without retrieved memories.",
        error,
        {
          traceId: event.traceId,
          parentId: event.id
        }
      );
      this.options.logger?.warn?.(
        "memory retrieval failed",
        this.errorLogContext(error, event.traceId)
      );
      memoryContext.memoryQueryLength = event.payload.content.length;
      return memoryContext;
    }

    memoryContext.memoryQueryLength = event.payload.content.length;

    await this.options.eventBus.publish(
      createEvent(
        "memory.retrieved",
        {
          sessionId: event.payload.sessionId,
          count: memoryContext.retrievedMemoryCount,
          rawCount: memoryContext.retrievedMemoryCountRaw,
          retrievalMode: memoryContext.retrievalMode,
          status: memoryContext.memoryFinalStatus,
          providerStatus: memoryContext.memoryProviderStatus,
          providerSource: memoryContext.memoryProviderSource,
          queryLength: memoryContext.memoryQueryLength,
          eventCount: memoryContext.memoryRetrievalEventIds.length,
          selectedCount: memoryContext.retrievedMemoryCount,
          droppedCount: memoryContext.memoryRetrievalDroppedCount,
          limited: memoryContext.memoryRetrievalLimited,
          fallbackUsed: memoryContext.memoryFallbackUsed,
          fallbackSource: memoryContext.memoryFallbackSource,
          fallbackReason: memoryContext.memoryFallbackReason,
          errorCode: memoryContext.memoryProviderErrorCode,
          metadataPresent: memoryContext.memoryMetadataPresent,
          sourceTurnLinkCount: memoryContext.memorySourceTurnLinkCount,
          conversationLinked: memoryContext.memoryConversationLinked,
          participantsCount: memoryContext.memoryParticipantsCount,
          eventIds: memoryContext.memoryRetrievalEventIds,
          dropped: memoryContext.memoryRetrievalDropped.map(({ id, reason }) => ({ id, reason }))
        },
        {
          traceId: event.traceId,
          parentId: event.id
        }
      )
    );

    return memoryContext;
  }

  private async retrieveFromProvider(
    provider: MemoryProvider,
    event: UserMessageEvent | UserVoiceTranscriptEvent
  ): Promise<Awaited<ReturnType<MemoryProvider["retrieveRelevant"]>>> {
    try {
      return await provider.retrieveRelevant({
        text: event.payload.content,
        limit: 5,
        sessionId: event.payload.sessionId,
        ...retrievalIdentityPayload(event.payload)
      });
    } catch {
      return {
        status: "error",
        events: [],
        source: "memory-provider",
        limited: false,
        errorCode: "MEMORY_PROVIDER_ERROR"
      };
    }
  }

  private buildProviderMemoryContext(
    outcome: Awaited<ReturnType<MemoryProvider["retrieveRelevant"]>>,
    options: MemoryContextBuildOptions = {}
  ): MemoryContext {
    const built = this.memoryContextBuilder.build(outcome, options);
    const context = emptyMemoryContext();
    context.retrievedMemoryCountRaw = outcome.rawCount ?? outcome.events.length;
    context.retrievedMemoryCount = built.diagnostics.selectedCount;
    context.memoryProviderStatus = outcome.status;
    context.memoryFinalStatus = outcome.status;
    context.memoryProviderSource = outcome.source;
    context.memoryProviderErrorCode = outcome.errorCode ?? null;
    context.memoryRetrievalLimited = outcome.limited;
    context.memoryRetrievalEventIds = built.diagnostics.eventIds ?? built.events.map((event) => event.id);
    context.memoryRetrievalDroppedCount = built.diagnostics.droppedCount;
    context.memoryRetrievalDropped = built.diagnostics.dropped ?? [];
    context.memoryMetadataPresent = built.diagnostics.metadataPresent ?? false;
    context.memorySourceTurnLinkCount = built.diagnostics.sourceTurnLinkCount ?? 0;
    context.memoryConversationLinked = built.diagnostics.conversationLinked ?? false;
    context.memoryParticipantsCount = built.diagnostics.participantsCount ?? 0;
    context.memoryFallbackProducedResults = false;
    context.promptMemories = built.promptMemories;
    context.keywordResultCount = built.diagnostics.selectedCount;
    context.hybridResultCount = built.diagnostics.selectedCount;
    return context;
  }

  private async retrieveLegacyMemories(
    event: UserMessageEvent | UserVoiceTranscriptEvent
  ): Promise<MemoryContext> {
    if (this.options.memory.retrieveRelevantMemoriesWithMetadata) {
      const result = await this.options.memory.retrieveRelevantMemoriesWithMetadata({
        text: event.payload.content,
        limit: 5,
        sessionId: event.payload.sessionId,
        projectId: "yuvi-runtime",
        ...retrievalIdentityPayload(event.payload)
      });
      return finalizeLegacyMemoryContext({
        ...emptyMemoryContext(),
        retrievedMemoryCountRaw: result.rawCount,
        retrievedMemoryCount: result.count,
        retrievalMode: result.retrievalMode,
        vectorEnabled: result.vectorEnabled,
        vectorUsed: result.vectorUsed,
        embeddingProvider: result.embeddingProvider,
        embeddingModel: result.embeddingModel,
        embeddingDimensions: result.embeddingDimensions,
        semanticEmbedding: result.semanticEmbedding,
        embeddingNote: result.embeddingNote,
        queryEmbeddingGenerated: result.queryEmbeddingGenerated,
        vectorResultCount: result.vectorResultCount,
        keywordResultCount: result.keywordResultCount,
        hybridResultCount: result.hybridResultCount,
        retrievalFallbackUsed: result.fallbackUsed,
        retrievalFallbackReason: result.fallbackReason,
        retrievalScope: result.retrievalScope,
        includedScopes: result.includedScopes,
        includeArchived: result.includeArchived,
        includeSuperseded: result.includeSuperseded,
        includeExpired: result.includeExpired,
        currentTime: result.currentTime,
        excludedByStatus: result.excludedByStatus,
        excludedByTime: result.excludedByTime,
        excludedByScope: result.excludedByScope,
        retrievedMemories: result.rawMemories,
        promptMemories: result.memories,
        memoryFallbackUsed: false
      });
    }

    const memories = await this.options.memory.retrieveRelevantMemories({
      text: event.payload.content,
      limit: 5,
      sessionId: event.payload.sessionId,
      projectId: "yuvi-runtime",
      ...retrievalIdentityPayload(event.payload)
    });
    return finalizeLegacyMemoryContext({
      ...emptyMemoryContext(),
      retrievedMemoryCountRaw: memories.length,
      retrievedMemoryCount: memories.length,
      keywordResultCount: memories.length,
      hybridResultCount: memories.length,
      retrievedMemories: memories.map(memoryToDebug),
      promptMemories: memories.map(memoryToDebug)
    });
  }

  private async processCandidateForStorage(
    candidate: MemoryCandidate,
    options: { source?: string; tags?: string[] }
  ): Promise<MemoryCandidateStorageResult> {
    if (this.options.memory.processCandidateForStorage) {
      return this.options.memory.processCandidateForStorage(candidate, options);
    }
    if (!this.options.memory.rememberCandidate) {
      return {
        decision: "rejected",
        candidate,
        rejectedReason: "memory service cannot store candidates"
      };
    }
    if (candidate.importance < 0.65) {
      return {
        decision: "rejected",
        candidate,
        rejectedReason: `runtime-threshold:${candidate.reason}`
      };
    }
    const memory = await this.options.memory.rememberCandidate(candidate, options);
    return {
      decision: "stored",
      candidate,
      memory,
      storageReason: "legacy importance threshold"
    };
  }

  private buildDirectContext(sessionId: string): DirectContextBuildResult {
    if (!this.directContextConfig.enabled) {
      return {
        enabled: false,
        content: "",
        turnCount: 0,
        charCount: 0,
        truncated: false,
        source: "disabled"
      };
    }

    const turns = this.sessionTurns.get(sessionId) ?? [];
    if (this.directContextConfig.maxTurns === 0) {
      return {
        enabled: true,
        content: "",
        turnCount: 0,
        charCount: 0,
        truncated: turns.length > 0,
        source: "session-turns"
      };
    }

    const selected = turns.slice(-this.directContextConfig.maxTurns);
    const lines = selected.map(formatDirectContextTurn);
    let content = lines.join("\n");
    let truncated = selected.length < turns.length;

    while (content.length > this.directContextConfig.maxChars && lines.length > 0) {
      lines.shift();
      content = lines.join("\n");
      truncated = true;
    }

    if (content.length > this.directContextConfig.maxChars) {
      content = content.slice(-this.directContextConfig.maxChars).trimStart();
      truncated = true;
    }

    return {
      enabled: true,
      content,
      turnCount: lines.length,
      charCount: content.length,
      truncated,
      source: "session-turns"
    };
  }

  private recordDirectContextTurn(
    userEvent: UserMessageEvent | UserVoiceTranscriptEvent,
    reply: AgentReplyEvent
  ): void {
    if (!this.directContextConfig.enabled) {
      return;
    }

    const sessionId = userEvent.payload.sessionId;
    const turns = this.sessionTurns.get(sessionId) ?? [];
    if (this.directContextConfig.maxTurns === 0) {
      this.sessionTurns.set(sessionId, []);
      return;
    }

    turns.push({
      traceId: userEvent.traceId,
      timestamp: new Date().toISOString(),
      userMessage: redactUnsafeText(userEvent.payload.content),
      assistantReply: redactUnsafeText(reply.payload.content)
    });

    const maxStoredTurns = Math.max(this.directContextConfig.maxTurns * 3, 12);
    this.sessionTurns.set(sessionId, turns.slice(-maxStoredTurns));
  }

  private async measureProvider<TOutput>(
    capability: string,
    provider: string,
    operation: () => Promise<TOutput>,
    eventContext: { traceId?: string | undefined; parentId?: string | undefined } = {}
  ): Promise<TOutput> {
    const startedAt = performance.now();
    try {
      const output = await operation();
      const latencyMs = Math.round(performance.now() - startedAt);
      this.options.logger?.info("provider call completed", {
        capability,
        provider,
        latencyMs,
        traceId: eventContext.traceId
      });
      return output;
    } catch (error) {
      const latencyMs = Math.round(performance.now() - startedAt);
      await this.publishProviderError(error, {
        capability,
        provider,
        latencyMs,
        traceId: eventContext.traceId,
        parentId: eventContext.parentId
      });
      throw error;
    }
  }

  private async publishProviderError(
    error: unknown,
    context: {
      capability: string;
      provider: string;
      latencyMs: number;
      traceId?: string | undefined;
      parentId?: string | undefined;
    }
  ): Promise<void> {
    const providerError = error instanceof ProviderError ? error : null;
    await this.publishDiagnosticEvent(
      createEvent(
        "provider.error",
        {
          provider: providerError?.provider ?? context.provider,
          capability: providerError?.capability ?? context.capability,
          code: providerError?.code ?? "PROVIDER_UNAVAILABLE",
          message: providerError?.message ?? safeErrorMessage(error),
          retryable: providerError?.retryable ?? false,
          statusCode: providerError?.statusCode,
          latencyMs: context.latencyMs
        },
        {
          traceId: context.traceId,
          parentId: context.parentId
        }
      )
    );
    this.options.logger?.warn?.("provider call failed", {
      provider: providerError?.provider ?? context.provider,
      capability: providerError?.capability ?? context.capability,
      code: providerError?.code,
      latencyMs: context.latencyMs,
      traceId: context.traceId
    });
  }

  private async publishRuntimeError(
    message: string,
    error: unknown,
    context: {
      traceId?: string | undefined;
      parentId?: string | undefined;
      category?: string | undefined;
      operation?: string | undefined;
    }
  ): Promise<void> {
    await this.publishDiagnosticEvent(
      createEvent(
        "runtime.error",
        {
          message,
          detail: redactUnsafeText(safeErrorMessage(error)),
          ...(context.category ? { category: context.category } : {}),
          ...(context.operation ? { operation: context.operation } : {})
        },
        context
      )
    );
  }

  private async publishPersistenceError(
    operation: ConversationPersistenceOperation,
    message: string,
    error: unknown,
    context: { traceId?: string | undefined; parentId?: string | undefined }
  ): Promise<void> {
    await this.publishRuntimeError(message, error, {
      ...context,
      category: "persistence",
      operation
    });
  }

  private async publishDiagnosticEvent(event: RuntimeEvent): Promise<void> {
    try {
      await this.options.eventBus.publish(event);
    } catch (publishError) {
      this.options.logger?.error?.(
        "failed to publish diagnostic event",
        this.errorLogContext(publishError, event.traceId)
      );
    }
  }

  private errorLogContext(error: unknown, traceId?: string | undefined): Record<string, unknown> {
    return {
      traceId,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: safeErrorMessage(error)
    };
  }

  private getProviderStatus(capability: ProviderCapability): ProviderHealth | undefined {
    const status = this.options.providers.getStatus?.();
    return status?.providers[capability];
  }

  private safeProviderCallMetadata(
    capability: ProviderCapability,
    providerName: string,
    output: ProviderMetadata,
    status: ProviderHealth | undefined
  ): SafeProviderCallMetadata {
    const mock = Boolean(status?.mock);
    return {
      name: mock ? "mock" : providerName,
      capability,
      model: output.model ?? status?.model,
      mock,
      latencyMs: output.latencyMs,
      tokenUsage: output.tokenUsage,
      healthStatus: status?.status,
      ...(output.fallbackUsed !== undefined ? { fallbackUsed: output.fallbackUsed } : {}),
      ...(output.attemptedProviders ? { attemptedProviders: output.attemptedProviders } : {}),
      ...(output.finalProvider ? { finalProvider: output.finalProvider } : {})
    };
  }

  private getMemoryExtractorStatus(
    skippedReason?: string | undefined
  ): MemoryExtractionRuntimeDebug {
    const status = this.options.memory.getExtractorStatus?.() ?? {
      mode: "rule-based",
      active: "rule-based",
      enabled: true
    };
    const reason = skippedReason ?? status.skippedReason;
    return {
      ...status,
      used: false,
      ...(reason ? { skippedReason: reason } : {})
    };
  }

  private extractorPreviewFields(
    debug: MemoryExtractionRuntimeDebug
  ): Pick<
    RuntimePromptPreview,
    | "memoryExtractorMode"
    | "memoryExtractorActive"
    | "memoryExtractorUsed"
    | "memoryExtractorProvider"
    | "memoryExtractionCandidateCount"
    | "storedMemoryCount"
    | "rejectedMemoryCount"
    | "rejectedReasons"
    | "fallbackUsed"
    | "llmExtractionError"
    | "llmExtractionRawPreview"
    | "validationIssues"
    | "memoryCandidates"
    | "memoryExtractionSkippedReason"
  > {
    return {
      memoryExtractorMode: debug.mode,
      memoryExtractorActive: debug.active,
      memoryExtractorUsed: debug.used,
      memoryExtractionCandidateCount: debug.candidateCount ?? 0,
      storedMemoryCount: debug.storedMemoryCount ?? 0,
      rejectedMemoryCount: debug.rejectedCount ?? 0,
      rejectedReasons: debug.rejectedReasons ?? [],
      fallbackUsed: Boolean(debug.fallbackUsed),
      memoryCandidates: debug.candidates ?? [],
      ...(debug.provider ? { memoryExtractorProvider: debug.provider } : {}),
      ...(debug.error ? { llmExtractionError: debug.error } : {}),
      ...(debug.rawPreview ? { llmExtractionRawPreview: debug.rawPreview } : {}),
      ...(debug.validationIssues ? { validationIssues: debug.validationIssues } : {}),
      ...(debug.skippedReason ? { memoryExtractionSkippedReason: debug.skippedReason } : {})
    };
  }

  private updateLatestPromptPreviewExtraction(debug: MemoryExtractionRuntimeDebug): void {
    if (!this.latestPromptPreview) {
      return;
    }

    this.latestPromptPreview = {
      ...this.latestPromptPreview,
      ...this.extractorPreviewFields(debug)
    };
  }

  private recordMemoryCandidates(input: {
    candidates: MemoryCandidate[];
    decisions: MemoryCandidateStorageResult[];
    storedMemories: Memory[];
    sourceTraceId: string;
    rejectedReasons: string[];
    extractorStatus: MemoryExtractionRuntimeDebug;
  }): RuntimeMemoryCandidateReview[] {
    const storedMemories = [...input.storedMemories];
    const reviews = input.candidates.map((candidate, index) => {
      const decision = input.decisions[index];
      const stored = decision?.decision === "stored";
      const storedMemory = stored ? storedMemories.shift() : undefined;
      const rejectedReason = stored
        ? undefined
        : (decision?.rejectedReason ??
          input.rejectedReasons.find((reason) => reason.includes(candidate.reason)) ??
          "rejected");
      return toMemoryCandidateReview({
        candidate: decision?.candidate ?? candidate,
        decision: stored ? "stored" : "rejected",
        rejectedReason,
        storageReason: decision?.storageReason,
        sourceTraceId: input.sourceTraceId,
        storedMemoryId: storedMemory?.id,
        extractorStatus: input.extractorStatus
      });
    });

    this.memoryCandidateHistory.unshift(...reviews);
    this.memoryCandidateHistory.splice(50);
    return reviews;
  }
}

type MemoryExtractionRuntimeDebug = MemoryExtractorStatus & {
  used: boolean;
  storedMemoryCount?: number | undefined;
  skippedReason?: string | undefined;
  candidates?: RuntimeMemoryCandidateReview[] | undefined;
};

type MemoryContext = {
  retrievedMemoryCountRaw: number;
  retrievedMemoryCount: number;
  memoryProviderStatus?: MemoryRetrievalStatus | undefined;
  memoryFinalStatus?: MemoryRetrievalStatus | undefined;
  memoryProviderSource?: string | undefined;
  memoryProviderErrorCode?: string | null | undefined;
  memoryRetrievalLimited: boolean;
  memoryQueryLength: number;
  memoryRetrievalEventIds: string[];
  memoryRetrievalDroppedCount: number;
  memoryRetrievalDropped: MemoryContextDrop[];
  memoryMetadataPresent: boolean;
  memorySourceTurnLinkCount: number;
  memoryConversationLinked: boolean;
  memoryParticipantsCount: number;
  memoryFallbackProducedResults: boolean;
  memoryFallbackUsed: boolean;
  memoryFallbackReason?: string | undefined;
  memoryFallbackSource?: "legacy" | undefined;
  retrievalMode: MemoryRetrievalMode;
  vectorEnabled: boolean;
  vectorUsed: boolean;
  embeddingProvider?: string | undefined;
  embeddingModel?: string | undefined;
  embeddingDimensions?: number | undefined;
  semanticEmbedding?: boolean | undefined;
  embeddingNote?: string | undefined;
  queryEmbeddingGenerated: boolean;
  vectorResultCount: number;
  keywordResultCount: number;
  hybridResultCount: number;
  retrievalFallbackUsed: boolean;
  retrievalFallbackReason?: string | undefined;
  retrievalScope: string;
  includedScopes: Array<{ scope: string; scopeId?: string | null }>;
  includeArchived: boolean;
  includeSuperseded: boolean;
  includeExpired: boolean;
  currentTime: string;
  excludedByStatus: number;
  excludedByTime: number;
  excludedByScope: number;
  retrievedMemories: RetrievedMemoryDebug[];
  promptMemories: Array<RetrievedMemoryDebug | PromptMemoryCompatibility>;
};

type ResolvedMemoryOptions = {
  legacyUseMemory: boolean | undefined;
  readMemory: boolean;
  writeMemory: boolean;
};

function resolveMemoryOptions(options: {
  useMemory?: boolean | undefined;
  readMemory?: boolean | undefined;
  writeMemory?: boolean | undefined;
}): ResolvedMemoryOptions {
  const defaultEnabled = options.useMemory ?? true;
  return {
    legacyUseMemory: options.useMemory,
    readMemory: options.readMemory ?? defaultEnabled,
    writeMemory: options.writeMemory ?? defaultEnabled
  };
}

function emptyMemoryContext(): MemoryContext {
  return {
    retrievedMemoryCountRaw: 0,
    retrievedMemoryCount: 0,
    memoryFallbackUsed: false,
    memoryRetrievalLimited: false,
    memoryQueryLength: 0,
    memoryRetrievalEventIds: [],
    memoryRetrievalDroppedCount: 0,
    memoryRetrievalDropped: [],
    memoryMetadataPresent: false,
    memorySourceTurnLinkCount: 0,
    memoryConversationLinked: false,
    memoryParticipantsCount: 0,
    memoryFallbackProducedResults: false,
    retrievalMode: "keyword",
    vectorEnabled: false,
    vectorUsed: false,
    queryEmbeddingGenerated: false,
    vectorResultCount: 0,
    keywordResultCount: 0,
    hybridResultCount: 0,
    retrievalFallbackUsed: false,
    retrievalScope: "user,project:yuvi-runtime",
    includedScopes: [{ scope: "user" }, { scope: "project", scopeId: "yuvi-runtime" }],
    includeArchived: false,
    includeSuperseded: false,
    includeExpired: false,
    currentTime: new Date().toISOString(),
    excludedByStatus: 0,
    excludedByTime: 0,
    excludedByScope: 0,
    retrievedMemories: [],
    promptMemories: []
  };
}

async function* compatibleRuntimeStream(
  provider: ChatProvider,
  input: ChatInput,
  signal: AbortSignal
): AsyncIterable<ChatStreamEvent> {
  if (signal.aborted) {
    throw createRuntimeCancelledError(provider.name);
  }
  // A compatible provider may not be able to physically abort generateReply().
  // Runtime cancellation therefore only suppresses output, fallback, and completion.
  const output = await provider.generateReply(input);
  if (signal.aborted) {
    throw createRuntimeCancelledError(provider.name);
  }
  if (output.message.content) {
    yield { type: "text-delta", text: output.message.content };
  }
  if (signal.aborted) {
    throw createRuntimeCancelledError(provider.name);
  }
  yield { type: "completed", output };
}

function normalizeRuntimeStreamError(
  error: unknown,
  provider: string,
  signal: AbortSignal
): ProviderError {
  if (signal.aborted) {
    return createRuntimeCancelledError(provider, error);
  }
  if (error instanceof ProviderError) {
    return error;
  }
  return new ProviderError({
    provider,
    capability: "chat",
    code: ProviderErrorCode.NetworkError,
    message: "Chat stream failed.",
    cause: error
  });
}

function createRuntimeCancelledError(provider = "chat", cause?: unknown): ProviderError {
  return new ProviderError({
    provider,
    capability: "chat",
    code: ProviderErrorCode.Cancelled,
    message: "Chat stream was cancelled.",
    retryable: false,
    cause
  });
}

function runtimeStreamProtocolError(provider: string, message: string): ProviderError {
  return new ProviderError({
    provider,
    capability: "chat",
    code: ProviderErrorCode.MalformedResponse,
    message,
    retryable: false
  });
}

function memoryToDebug(memory: Memory): RetrievedMemoryDebug {
  const semanticEmbedding =
    memory.embeddingProvider === null || memory.embeddingProvider === undefined
      ? undefined
      : memory.embeddingProvider !== "mock";
  return {
    id: memory.id,
    type: memory.type,
    subtype: memory.subtype,
    scope: memory.scope,
    scopeId: memory.scopeId,
    memoryLayer: memory.memoryLayer,
    status: memory.status,
    source: memory.source,
    sourceTraceId: memory.sourceTraceId,
    metadata: memory.metadata,
    importance: memory.importance,
    createdAt: memory.createdAt,
    observedAt: memory.observedAt,
    eventTime: memory.eventTime,
    validFrom: memory.validFrom,
    validUntil: memory.validUntil,
    expiresAt: memory.expiresAt,
    supersededAt: memory.supersededAt,
    displayText: memory.summary ?? memory.content,
    matchedBy: "content",
    hasEmbedding: Boolean(memory.embedding?.length),
    embeddingProvider: memory.embeddingProvider,
    embeddingModel: memory.embeddingModel,
    embeddingDimensions: memory.embeddingDimensions,
    embeddedAt: memory.embeddedAt,
    ...(semanticEmbedding !== undefined ? { semanticEmbedding } : {}),
    score: memory.importance
  };
}

function toMemoryCandidateReview(input: {
  candidate: MemoryCandidate;
  decision: RuntimeMemoryCandidateDecision;
  rejectedReason?: string | undefined;
  storageReason?: string | undefined;
  sourceTraceId: string;
  storedMemoryId?: string | undefined;
  extractorStatus: MemoryExtractionRuntimeDebug;
}): RuntimeMemoryCandidateReview {
  const content = redactUnsafeText(input.candidate.content);
  const timestamp = new Date().toISOString();
  const metadata = redactUnsafeMetadata(input.candidate.metadata);
  return {
    id: crypto.randomUUID(),
    traceId: input.sourceTraceId,
    timestamp,
    type: input.candidate.type,
    subtype: input.candidate.subtype,
    ...(input.candidate.scope ? { scope: input.candidate.scope } : {}),
    ...(input.candidate.scopeId !== undefined ? { scopeId: input.candidate.scopeId } : {}),
    ...(input.candidate.memoryLayer ? { memoryLayer: input.candidate.memoryLayer } : {}),
    content,
    contentPreview: previewText(content),
    summary: input.candidate.summary ? redactUnsafeText(input.candidate.summary) : null,
    importance: input.candidate.importance,
    confidence: input.candidate.confidence,
    tags: input.candidate.tags.map(redactUnsafeText),
    reason: redactUnsafeText(input.candidate.reason),
    decision: input.decision,
    rejectedReason: input.rejectedReason,
    storageReason: input.storageReason,
    explicitRememberRequested: Boolean(
      input.candidate.explicitRememberRequested ??
      input.candidate.metadata?.["explicitRememberRequested"]
    ),
    originRole:
      input.candidate.originRole ??
      (typeof input.candidate.metadata?.["originRole"] === "string"
        ? (input.candidate.metadata["originRole"] as "user" | "assistant" | "mixed")
        : undefined),
    canonicalFingerprint:
      typeof input.candidate.metadata?.["canonicalFingerprint"] === "string"
        ? input.candidate.metadata["canonicalFingerprint"]
        : undefined,
    canonicalEventKey:
      typeof input.candidate.metadata?.["canonicalEventKey"] === "string"
        ? input.candidate.metadata["canonicalEventKey"]
        : undefined,
    correctionRequested: Boolean(
      input.candidate.correctionRequested ?? input.candidate.metadata?.["correctionRequested"]
    ),
    temporalStatus:
      input.candidate.metadata?.["temporalStatus"] === "not-needed" ||
      input.candidate.metadata?.["temporalStatus"] === "normalized" ||
      input.candidate.metadata?.["temporalStatus"] === "unresolved"
        ? input.candidate.metadata["temporalStatus"]
        : undefined,
    temporalSuggestion:
      typeof input.candidate.metadata?.["temporalSuggestion"] === "string"
        ? input.candidate.metadata["temporalSuggestion"]
        : undefined,
    source: "runtime",
    sourceTraceId: input.candidate.sourceTraceId ?? input.sourceTraceId,
    storedMemoryId: input.storedMemoryId,
    createdAt: timestamp,
    extractorMode: input.extractorStatus.mode,
    ...(input.extractorStatus.provider
      ? { extractorProvider: redactUnsafeText(input.extractorStatus.provider) }
      : {}),
    fallbackUsed: Boolean(input.extractorStatus.fallbackUsed),
    ...(metadata ? { metadata } : {}),
    ...(typeof metadata?.["retentionClass"] === "string"
      ? { retentionClass: metadata["retentionClass"] }
      : {}),
    ...(typeof metadata?.["computedExpiresAt"] === "string" ||
    metadata?.["computedExpiresAt"] === null
      ? { computedExpiresAt: metadata["computedExpiresAt"] as string | null }
      : {}),
    ...(input.candidate.subjectUserId !== undefined
      ? { subjectUserId: input.candidate.subjectUserId }
      : {}),
    ...(input.candidate.speakerId !== undefined ? { speakerId: input.candidate.speakerId } : {}),
    ...optionalIsoField("observedAt", input.candidate.observedAt),
    ...optionalIsoField("eventTime", input.candidate.eventTime),
    ...optionalIsoField("validFrom", input.candidate.validFrom),
    ...optionalIsoField("validUntil", input.candidate.validUntil),
    ...optionalIsoField("expiresAt", input.candidate.expiresAt),
    ...(input.candidate.possibleSupersedes
      ? { possibleSupersedes: input.candidate.possibleSupersedes }
      : {}),
    ...(input.candidate.possibleContradictions
      ? { possibleContradictions: input.candidate.possibleContradictions }
      : {}),
    ...(input.candidate.relationshipConfidence !== undefined
      ? { relationshipConfidence: input.candidate.relationshipConfidence }
      : {}),
    ...(input.candidate.relationshipReason
      ? { relationshipReason: redactUnsafeText(input.candidate.relationshipReason) }
      : {})
  };
}

function optionalIsoField(
  key: "observedAt" | "eventTime" | "validFrom" | "validUntil" | "expiresAt",
  value: Date | string | null | undefined
): Partial<Record<typeof key, string>> {
  const iso = toIsoString(value);
  return iso === undefined || iso === null ? {} : { [key]: iso };
}

function currentTimeContext(): NonNullable<PromptBuildInput["currentTime"]> {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    isoTimestamp: now.toISOString(),
    timezone,
    localDate: now.toLocaleDateString("en-CA", { timeZone: timezone })
  };
}

function formatCurrentAffectForPrompt(affect: CurrentAffect): string {
  const tentative = affect.confidence < 0.75 ? "Tentative: " : "";
  return [
    `${tentative}User appears ${affect.affectLabel} in the current turn.`,
    `Valence: ${affect.affectValence.toFixed(2)}; arousal: ${affect.affectArousal.toFixed(2)}; confidence: ${affect.confidence.toFixed(2)}.`,
    affect.promptHint
  ].join("\n");
}

function normalizeDirectContextConfig(
  input: Partial<DirectContextConfig> | undefined
): DirectContextConfig {
  return {
    enabled: input?.enabled ?? true,
    maxTurns: clampInteger(input?.maxTurns ?? 6, 0, 20),
    maxChars: clampInteger(input?.maxChars ?? 6000, 500, 20_000)
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function conversationMessageFromEvent(
  event: UserMessageEvent | AssistantMessageEvent,
  role: "user" | "assistant",
  status: ConversationMessage["status"]
): ConversationMessageInput {
  return {
    id: event.id,
    sessionId: event.payload.sessionId,
    traceId: event.traceId,
    parentMessageId: event.parentId ?? null,
    role,
    content: event.payload.content,
    status,
    createdAt: event.timestamp,
    completedAt: status === "completed" ? event.timestamp : null,
    metadata: {}
  };
}

function buildDirectContextTurns(messages: ConversationMessage[]): DirectContextTurn[] {
  const turns: DirectContextTurn[] = [];
  let pendingUser: ConversationMessage | undefined;

  for (const message of messages) {
    if (message.status !== "completed") {
      continue;
    }
    if (message.role === "user") {
      pendingUser = message;
      continue;
    }
    if (!pendingUser) {
      continue;
    }

    turns.push({
      traceId: pendingUser.traceId,
      timestamp: message.completedAt ?? message.createdAt,
      userMessage: redactUnsafeText(pendingUser.content),
      assistantReply: redactUnsafeText(message.content)
    });
    pendingUser = undefined;
  }

  return turns;
}

function formatDirectContextTurn(turn: DirectContextTurn): string {
  return [
    `- Previous turn (${turn.timestamp}, trace ${turn.traceId.slice(0, 8)}):`,
    `  User: ${truncateDirectContextLine(turn.userMessage)}`,
    `  Assistant: ${truncateDirectContextLine(turn.assistantReply)}`
  ].join("\n");
}

function truncateDirectContextLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 800 ? `${normalized.slice(0, 797)}...` : normalized;
}

function toIsoString(value: Date | string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type RuntimeIdentityPayload = {
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  createdByUserId?: string | null | undefined;
  speakerId?: string | null | undefined;
  voiceProfileId?: string | null | undefined;
};

function identityPayload(input: RuntimeIdentityPayload): RuntimeIdentityPayload {
  return {
    ...(input.personaId !== undefined ? { personaId: input.personaId } : {}),
    ...(input.subjectUserId !== undefined ? { subjectUserId: input.subjectUserId } : {}),
    ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
    ...(input.speakerId !== undefined ? { speakerId: input.speakerId } : {}),
    ...(input.voiceProfileId !== undefined ? { voiceProfileId: input.voiceProfileId } : {})
  };
}

function retrievalIdentityPayload(input: RuntimeIdentityPayload): {
  personaId?: string;
  subjectUserId?: string;
  speakerId?: string;
} {
  return {
    ...(typeof input.personaId === "string" ? { personaId: input.personaId } : {}),
    ...(typeof input.subjectUserId === "string" ? { subjectUserId: input.subjectUserId } : {}),
    ...(typeof input.speakerId === "string" ? { speakerId: input.speakerId } : {})
  };
}

function previewText(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function redactUnsafeText(text: string): string {
  return text
    .replace(
      /(api[-_]?key|authorization|bearer|token|password|secret|database[_-]?url|connection[_-]?string)\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(/\b(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]");
}

function redactUnsafeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      /api[-_]?key|authorization|bearer|token|password|secret|database[_-]?url|connection[_-]?string/i.test(
        key
      )
    ) {
      output[key] = "[redacted]";
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      output[key] = redactUnsafeMetadata(child) ?? {};
    } else if (typeof child === "string") {
      output[key] = redactUnsafeText(child);
    } else {
      output[key] = child;
    }
  }
  return output;
}

function isRuntimeUserMessageEvent(
  input: UserMessageEvent | HandleUserMessageInput
): input is UserMessageEvent {
  return "type" in input && input.type === "user.message";
}

function isSafeProviderCallMetadata(value: unknown): value is SafeProviderCallMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SafeProviderCallMetadata>;
  return typeof candidate.name === "string" && isProviderCapability(candidate.capability);
}

function isProviderCapability(value: unknown): value is ProviderCapability {
  return (
    value === "chat" ||
    value === "reasoning" ||
    value === "tts" ||
    value === "stt" ||
    value === "vision" ||
    value === "embedding"
  );
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown runtime error.";
}

function isPromptMemoryCompatibility(
  memory: RetrievedMemoryDebug | PromptMemoryCompatibility
): memory is PromptMemoryCompatibility {
  return (
    typeof (memory as Partial<PromptMemoryCompatibility>).provenanceId === "string" &&
    typeof (memory as Partial<PromptMemoryCompatibility>).sourceRecordId === "string"
  );
}

function isUsableProviderOutcome(status: MemoryRetrievalStatus): boolean {
  return status === "ok" || status === "empty" || status === "partial";
}

function finalizeLegacyMemoryContext(context: MemoryContext): MemoryContext {
  return {
    ...context,
    memoryFinalStatus: context.retrievedMemoryCountRaw > 0 ? "ok" : "empty",
    memoryRetrievalLimited: false,
    memoryRetrievalEventIds: context.retrievedMemories.map((memory) => memory.id),
    memoryFallbackProducedResults: false
  };
}

function dedupeLegacyMemoryContext(
  context: MemoryContext,
  options: MemoryContextBuildOptions
): MemoryContext {
  const seen = new Set<string>();
  const dropped: MemoryContextDrop[] = [...context.memoryRetrievalDropped];
  let droppedCount = context.memoryRetrievalDroppedCount;
  const promptMemories: Array<RetrievedMemoryDebug | PromptMemoryCompatibility> = [];

  for (const memory of context.promptMemories) {
    const content = isPromptMemoryCompatibility(memory) ? memory.content : memory.displayText;
    const id = isPromptMemoryCompatibility(memory) ? memory.provenanceId : memory.id;
    const source = memory.source;
    const reason = deterministicMemoryEchoReason(content, options);
    const normalized = normalizeMemoryTextForDedupe(content);
    const dropReason = reason ?? (seen.has(normalized) ? "duplicate_memory" : undefined);
    if (dropReason) {
      droppedCount += 1;
      dropped.push({ id, reason: dropReason, source });
      continue;
    }
    seen.add(normalized);
    promptMemories.push(memory);
  }

  return {
    ...context,
    retrievedMemoryCount: promptMemories.length,
    promptMemories,
    memoryRetrievalDroppedCount: droppedCount,
    memoryRetrievalDropped: dropped
  };
}

function annotateProviderFallback(
  context: MemoryContext,
  outcome: Awaited<ReturnType<MemoryProvider["retrieveRelevant"]>>
): MemoryContext {
  return {
    ...context,
    memoryProviderStatus: outcome.status,
    memoryProviderSource: outcome.source,
    memoryProviderErrorCode: outcome.errorCode ?? null,
    memoryRetrievalLimited: outcome.limited,
    memoryFallbackProducedResults: context.retrievedMemoryCountRaw > 0,
    memoryFallbackUsed: true,
    memoryFallbackReason: outcome.errorCode ?? `provider-status:${outcome.status}`,
    memoryFallbackSource: "legacy"
  };
}
