import type { EventBus } from "@companion/event-bus";
import type {
  Memory,
  MemoryCandidate,
  MemoryCandidateStorageResult,
  CurrentAffect,
  MemoryExtractorStatus,
  MemoryRetrievalMode,
  MemoryRetrievalResult,
  RetrievedMemoryDebug
} from "@companion/memory";
import { detectCurrentAffect } from "@companion/memory";
import type { PromptBuildInput, PromptBuildOutput } from "@companion/prompt-builder";
import type {
  AgentReplyEvent,
  AvatarSpeakEvent,
  PerceptionVisionEvent,
  RuntimeEvent,
  UserMessageEvent,
  UserVoiceTranscriptEvent
} from "@companion/protocol";
import { createEvent } from "@companion/protocol";
import {
  ProviderError,
  type ProviderCapability,
  type ProviderHealth,
  type ProviderMetadata,
  type ProviderResolver,
  type STTInput,
  type TokenUsage,
  type VisionInput
} from "@companion/providers";

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
  memoryRepository?: string | undefined;
  directContext?: Partial<DirectContextConfig> | undefined;
  logger?: RuntimeLogger;
};

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
  }): Promise<Memory[]>;
  retrieveRelevantMemoriesWithMetadata?(input: {
    text: string;
    limit?: number;
    sessionId?: string;
    projectId?: string;
  }): Promise<MemoryRetrievalResult>;
  scoreImportance(text: string): number;
  extractCandidates?(input: {
    sessionId?: string | undefined;
    userMessage: string;
    assistantMessage?: string | undefined;
    sourceTraceId?: string | null | undefined;
    timestamp?: string | undefined;
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
    options?: { source?: string; tags?: string[] }
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
};

export type HandleUserMessageOptions = {
  voiceOutput?: boolean | undefined;
  useMemory?: boolean | undefined;
  readMemory?: boolean | undefined;
  writeMemory?: boolean | undefined;
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
};

export type HandleImageInputInput = VisionInput & {
  sessionId: string;
  traceId?: string | undefined;
  parentId?: string | undefined;
};

export class RuntimeOrchestrator {
  private latestPromptPreview: RuntimePromptPreview | null = null;
  private readonly memoryCandidateHistory: RuntimeMemoryCandidateReview[] = [];
  private readonly sessionTurns = new Map<string, DirectContextTurn[]>();
  private readonly directContextConfig: DirectContextConfig;

  constructor(private readonly options: RuntimeOrchestratorOptions) {
    this.directContextConfig = normalizeDirectContextConfig(options.directContext);
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

    const candidate: MemoryCandidate = {
      type: patch.type ?? review.type,
      content: patch.content ?? review.content,
      summary: patch.summary ?? review.summary ?? null,
      importance: patch.importance ?? review.importance,
      metadata: {
        ...(review.metadata ?? {}),
        acceptedBy: "dashboard",
        acceptedFromCandidateId: review.id
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
    candidate.eventTime = patch.eventTime ?? review.eventTime ?? null;
    candidate.validFrom =
      patch.validFrom ?? review.validFrom ?? review.observedAt ?? review.createdAt;
    candidate.validUntil = patch.validUntil ?? review.validUntil ?? null;
    candidate.expiresAt = patch.expiresAt ?? review.expiresAt ?? null;
    candidate.possibleSupersedes = patch.possibleSupersedes ?? review.possibleSupersedes ?? [];
    candidate.possibleContradictions =
      patch.possibleContradictions ?? review.possibleContradictions ?? [];
    if (review.confidence !== undefined) {
      candidate.confidence = review.confidence;
    }
    if (review.sourceTraceId !== undefined) {
      candidate.sourceTraceId = review.sourceTraceId;
    }

    const memory = await this.options.memory.rememberCandidate(candidate, {
      source: "dashboard",
      tags: candidate.tags
    });
    review.decision = "stored";
    review.storedMemoryId = memory.id;
    review.rejectedReason = undefined;
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
            content: input.content
          },
          {
            traceId: input.traceId,
            parentId: input.parentId
          }
        );

    await this.options.eventBus.publish(userEvent);
    const voiceOutput = isRuntimeUserMessageEvent(input)
      ? Boolean(options.voiceOutput)
      : Boolean(input.voiceOutput);
    const memoryOptions = resolveMemoryOptions(options);
    const reply = await this.generateReply(userEvent, {
      voiceOutput,
      readMemory: memoryOptions.readMemory,
      writeMemory: memoryOptions.writeMemory
    });
    if (memoryOptions.writeMemory) {
      const extraction = await this.maybeStoreMemory(userEvent, reply, memoryOptions);
      this.updateLatestPromptPreviewExtraction(extraction);
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
        confidence: transcript.confidence
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

  async generateReply(
    event: UserMessageEvent | UserVoiceTranscriptEvent,
    options: {
      voiceOutput?: boolean | undefined;
      useMemory?: boolean | undefined;
      readMemory?: boolean | undefined;
      writeMemory?: boolean | undefined;
    } = {}
  ): Promise<AgentReplyEvent> {
    const voiceOutput = Boolean(options.voiceOutput);
    const memoryOptions = resolveMemoryOptions(options);
    const currentAffect = detectCurrentAffect({
      text: event.payload.content,
      sourceTraceId: event.traceId
    });
    const memoryContext = memoryOptions.readMemory
      ? await this.retrieveMemories(event)
      : emptyMemoryContext();
    const directContext = this.buildDirectContext(event.payload.sessionId);
    const prompt = this.options.promptBuilder.buildPrompt({
      systemIdentity: "You are Companion, a local-first AI companion runtime agent.",
      characterStyle: "Warm, concise, emotionally aware, and practical.",
      relationshipContext:
        "Use remembered context only when relevant. Do not pretend to remember details that were not retrieved.",
      retrievedMemories: memoryContext.promptMemories.map((memory) => ({
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
        ...(memory.lastAccessedAt !== undefined ? { lastAccessedAt: memory.lastAccessedAt } : {})
      })),
      memoryEnabled: memoryOptions.readMemory,
      currentTime: currentTimeContext(),
      ...(currentAffect ? { currentAffect: formatCurrentAffectForPrompt(currentAffect) } : {}),
      directContext: directContext.content,
      directContextEnabled: directContext.enabled,
      currentSituation: voiceOutput
        ? "The user is interacting through voice."
        : "The user is interacting through text.",
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

    const reply = await this.publishAgentReply(event, output.message.content, providerMetadata);
    this.recordDirectContextTurn(event, reply);
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
      if (this.options.memory.extractCandidates) {
        const candidates = await this.options.memory.extractCandidates({
          sessionId: sourceEvent.payload.sessionId,
          userMessage: sourceEvent.payload.content,
          assistantMessage: reply.payload.content,
          sourceTraceId: sourceEvent.traceId,
          timestamp: new Date().toISOString(),
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
    const reply = createEvent(
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

    await this.options.eventBus.publish(reply);
    return reply;
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
    event: UserMessageEvent | UserVoiceTranscriptEvent
  ): Promise<MemoryContext> {
    let memoryContext: MemoryContext;
    try {
      if (this.options.memory.retrieveRelevantMemoriesWithMetadata) {
        const result = await this.options.memory.retrieveRelevantMemoriesWithMetadata({
          text: event.payload.content,
          limit: 5,
          sessionId: event.payload.sessionId,
          projectId: "yuvi-runtime"
        });
        memoryContext = {
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
          promptMemories: result.memories
        };
      } else {
        const memories = await this.options.memory.retrieveRelevantMemories({
          text: event.payload.content,
          limit: 5,
          sessionId: event.payload.sessionId,
          projectId: "yuvi-runtime"
        });
        memoryContext = {
          ...emptyMemoryContext(),
          retrievedMemoryCountRaw: memories.length,
          retrievedMemoryCount: memories.length,
          retrievalMode: "keyword",
          vectorEnabled: false,
          vectorUsed: false,
          queryEmbeddingGenerated: false,
          vectorResultCount: 0,
          keywordResultCount: memories.length,
          hybridResultCount: memories.length,
          retrievalFallbackUsed: false,
          retrievedMemories: memories.map(memoryToDebug),
          promptMemories: memories.map(memoryToDebug)
        };
      }
    } catch (error) {
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
      return emptyMemoryContext();
    }

    await this.options.eventBus.publish(
      createEvent(
        "memory.retrieved",
        {
          sessionId: event.payload.sessionId,
          count: memoryContext.retrievedMemoryCount,
          rawCount: memoryContext.retrievedMemoryCountRaw,
          retrievalMode: memoryContext.retrievalMode
        },
        {
          traceId: event.traceId,
          parentId: event.id
        }
      )
    );

    return memoryContext;
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
    context: { traceId?: string | undefined; parentId?: string | undefined }
  ): Promise<void> {
    await this.publishDiagnosticEvent(
      createEvent(
        "runtime.error",
        {
          message,
          detail: safeErrorMessage(error)
        },
        context
      )
    );
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
  promptMemories: RetrievedMemoryDebug[];
};

function resolveMemoryOptions(options: {
  useMemory?: boolean | undefined;
  readMemory?: boolean | undefined;
  writeMemory?: boolean | undefined;
}): { legacyUseMemory: boolean | undefined; readMemory: boolean; writeMemory: boolean } {
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

function previewText(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function redactUnsafeText(text: string): string {
  return text
    .replace(
      /(api[-_]?key|authorization|bearer|token|password|secret)\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]");
}

function redactUnsafeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/api[-_]?key|authorization|bearer|token|password|secret/i.test(key)) {
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
