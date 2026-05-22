import type { EventBus } from "@companion/event-bus";
import type {
  Memory,
  MemoryCandidate,
  MemoryExtractorStatus,
  MemoryRetrievalMode,
  MemoryRetrievalResult,
  RetrievedMemoryDebug
} from "@companion/memory";
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
  logger?: RuntimeLogger;
};

export type RuntimeMemoryPort = {
  retrieveRelevantMemories(input: { text: string; limit?: number }): Promise<Memory[]>;
  retrieveRelevantMemoriesWithMetadata?(input: {
    text: string;
    limit?: number;
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

export type RuntimeMemoryCandidateDecision = "candidate" | "stored" | "rejected";

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
  observedAt?: string | undefined;
  eventTime?: string | null | undefined;
  validFrom?: string | undefined;
  validUntil?: string | null | undefined;
  expiresAt?: string | null | undefined;
  possibleSupersedes?: string[] | undefined;
  possibleContradictions?: string[] | undefined;
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

  constructor(private readonly options: RuntimeOrchestratorOptions) {}

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
    const memoryContext = memoryOptions.readMemory
      ? await this.retrieveMemories(event)
      : emptyMemoryContext();
    const prompt = this.options.promptBuilder.buildPrompt({
      systemIdentity: "You are Companion, a local-first AI companion runtime agent.",
      characterStyle: "Warm, concise, emotionally aware, and practical.",
      relationshipContext:
        "Use remembered context only when relevant. Do not pretend to remember details that were not retrieved.",
      retrievedMemories: memoryContext.promptMemories.map((memory) => ({
        content: memory.displayText,
        displayText: memory.displayText,
        importance: memory.importance,
        createdAt: memory.createdAt
      })),
      memoryEnabled: memoryOptions.readMemory,
      currentTime: currentTimeContext(),
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
      retrievedMemories: memoryContext.retrievedMemories,
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

    return this.publishAgentReply(event, output.message.content, providerMetadata);
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
      if (this.options.memory.extractCandidates && this.options.memory.rememberCandidate) {
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
        const selected = candidates.filter((candidate) => candidate.importance >= 0.65);
        const extractorStatus = this.getMemoryExtractorStatus();
        const rejectedReasons = [
          ...(extractorStatus.rejectedReasons ?? []),
          ...candidates
            .filter((candidate) => candidate.importance < 0.65)
            .map((candidate) => `runtime-threshold:${candidate.reason}`)
        ];
        const storedMemories = await Promise.all(
          selected.map((candidate) =>
            this.options.memory.rememberCandidate?.(candidate, {
              source: "runtime",
              tags: [sourceEvent.payload.sessionId]
            })
          )
        );
        const reviewedCandidates = this.recordMemoryCandidates({
          candidates,
          selected,
          storedMemories: storedMemories.filter((memory): memory is Memory => Boolean(memory)),
          sourceTraceId: sourceEvent.traceId,
          rejectedReasons,
          extractorStatus
        });
        return {
          ...extractorStatus,
          used: true,
          candidateCount: candidates.length,
          storedMemoryCount: selected.length,
          rejectedCount: Math.max(candidates.length - selected.length, 0),
          rejectedReasons,
          candidates: reviewedCandidates,
          ...(selected.length > 0
            ? {}
            : { skippedReason: "Extractor produced no candidates above threshold." })
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
          limit: 5
        });
        memoryContext = {
          retrievedMemoryCountRaw: result.rawCount,
          retrievedMemoryCount: result.count,
          retrievalMode: result.retrievalMode,
          retrievedMemories: result.rawMemories,
          promptMemories: result.memories
        };
      } else {
        const memories = await this.options.memory.retrieveRelevantMemories({
          text: event.payload.content,
          limit: 5
        });
        memoryContext = {
          retrievedMemoryCountRaw: memories.length,
          retrievedMemoryCount: memories.length,
          retrievalMode: "keyword",
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
      healthStatus: status?.status
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
    selected: MemoryCandidate[];
    storedMemories: Memory[];
    sourceTraceId: string;
    rejectedReasons: string[];
    extractorStatus: MemoryExtractionRuntimeDebug;
  }): RuntimeMemoryCandidateReview[] {
    const storedMemories = [...input.storedMemories];
    const reviews = input.candidates.map((candidate) => {
      const stored = input.selected.includes(candidate);
      const storedMemory = stored ? storedMemories.shift() : undefined;
      const rejectedReason = stored
        ? undefined
        : (input.rejectedReasons.find((reason) => reason.includes(candidate.reason)) ??
          `runtime-threshold:${candidate.reason}`);
      return toMemoryCandidateReview({
        candidate,
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
    retrievedMemories: [],
    promptMemories: []
  };
}

function memoryToDebug(memory: Memory): RetrievedMemoryDebug {
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
    validFrom: memory.validFrom,
    validUntil: memory.validUntil,
    expiresAt: memory.expiresAt,
    supersededAt: memory.supersededAt,
    displayText: memory.summary ?? memory.content,
    matchedBy: "content",
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
