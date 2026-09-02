import type { EventBus } from "@companion/event-bus";
import type {
  ConversationRepository,
  CurrentAffect,
  DreamWriter,
  FinalizedIngestionPort,
  Memory,
  MemoryCandidate,
  MemoryCandidateStorageResult,
  MemoryConversationTurnWriteResult,
  MemoryExtractorStatus,
  MemoryIngestionCoordinatorPort,
  MemoryProvider,
  MemoryRetrievalMode,
  MemoryRetrievalResult,
  MemoryRetrievalStatus,
  RecentEpisodeStore,
  DreamJobStore,
  RetrievedMemoryDebug
} from "@companion/memory";
import type { PromptBuildInput, PromptBuildOutput } from "@companion/prompt-builder";
import type {
  EmbodiedPresentationOutcomeReport,
  EmbodiedPresentationRequest,
  RuntimeEvent,
  TurnOrigin
} from "@companion/protocol";
import type { RuntimeEmbodiedEffectRecordInitializationDecision } from "./runtime-embodied-effect-record-initialization.js";
import type {
  ChatInput,
  ChatOutput,
  ProviderCallOptions,
  ProviderCapability,
  ProviderHealth,
  ProviderMetadata,
  ProviderResolver,
  STTInput,
  TokenUsage,
  VisionInput
} from "@companion/providers";
import type { MemoryContextBuilder, MemoryContextDrop } from "./memory-context.js";

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
  finalizedIngestion?: FinalizedIngestionPort | undefined;
  memoryIngestionCoordinator?: MemoryIngestionCoordinatorPort | undefined;
  memoryRepository?: string | undefined;
  directContext?: Partial<DirectContextConfig> | undefined;
  memoryContextBuilder?: Pick<MemoryContextBuilder, "build"> | undefined;
  recentEpisodeStore?: RecentEpisodeStore | undefined;
  dreamJobStore?: DreamJobStore | undefined;
  dreamWriter?: DreamWriter | undefined;
  dreamProvider?: MemoryProvider | undefined;
  logger?: RuntimeLogger;
  /** Runtime-owned Character generation and its bounded cognition callback. */
  character?: RuntimeCharacterPort | undefined;
  characterCognition?: RuntimeCharacterCognitionExecutor | undefined;
  /** Optional production Character -> Runtime -> Presentation composition. */
  embodiedPresentation?: RuntimeEmbodiedPresentationPort | undefined;
};

export type RuntimeCharacterCognitionExecutor = (
  request: unknown,
  problem: string,
  options?: Readonly<{ signal?: AbortSignal | undefined }>
) => Promise<unknown>;

export type RuntimeCharacterGenerationResult = Readonly<{
  content: string;
  providerMetadata: Pick<
    ProviderMetadata,
    "model" | "latencyMs" | "tokenUsage" | "fallbackUsed" | "attemptedProviders" | "finalProvider"
  >;
}>;

/**
 * Narrow Runtime-to-Character port. Runtime supplies the selected Chat call
 * and the existing Cognition executor; the Character adapter owns only
 * semantic proposal handling and expression.
 */
export type RuntimeCharacterPort = Readonly<{
  generate(
    input: Readonly<{
      prompt: PromptBuildOutput;
      userMessage: string;
      signal?: AbortSignal | undefined;
      generateChat(
        input: ChatInput,
        options?: ProviderCallOptions | undefined
      ): Promise<ChatOutput>;
      executeCognition(
        request: unknown,
        problem: string,
        options?: Readonly<{ signal?: AbortSignal | undefined }>
      ): Promise<unknown>;
    }>
  ): Promise<RuntimeCharacterGenerationResult>;
}>;

export type RuntimeEmbodiedPresentationPort = Readonly<{
  propose(
    reply: RuntimeEventLikeAssistantReply
  ): RuntimeEmbodiedEffectRecordInitializationDecision | null;
  present(
    request: EmbodiedPresentationRequest,
    traceAnchor: RuntimeEvent
  ): EmbodiedPresentationOutcomeReport | Promise<EmbodiedPresentationOutcomeReport>;
}>;

export type RuntimeEventLikeAssistantReply = RuntimeEvent<
  "agent.reply",
  { content: string; sessionId?: string }
>;

export type ConversationPersistenceOperation =
  | "session_create"
  | "user_message_save"
  | "assistant_message_save"
  | "assistant_stream_create"
  | "assistant_stream_append"
  | "assistant_stream_complete"
  | "assistant_stream_fail"
  | "stream_recovery"
  | "context_restore";

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
    idempotencyKey?: string | null | undefined;
  }): Promise<MemoryConversationTurnWriteResult>;
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

export type AssistantInitiatedTurnInput = {
  sessionId: string;
  idempotencyKey: string;
  readMemory: boolean;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
};

export type AssistantInitiatedTurnOptions = {
  signal?: AbortSignal | undefined;
  promptPreview?: boolean | undefined;
};

export type ProactiveShouldSpeak = "NO_OP" | "REQUEST_TEXT";

export type MaybeSynthesizeSpeechOptions = {
  signal?: AbortSignal | undefined;
};

export type RuntimeReplyStreamEvent =
  | {
      type: "proactive-decision";
      decision: ProactiveShouldSpeak;
      sessionId: string;
      traceId: string;
    }
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
  turnOrigin: TurnOrigin;
  userMessage?: string | undefined;
  proactiveInstruction?: string | undefined;
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
  recentEpisodicCount?: number | undefined;
  associativeCount?: number | undefined;
  associativeSkippedReason?: string | undefined;
  temporalAgeBand?: string | undefined;
  contextCompressionBeforeTokens?: number | undefined;
  contextCompressionAfterTokens?: number | undefined;
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
  memoryWriteStatus?: RuntimeMemoryWriteStatus | undefined;
  memoryWriteAttemptedCount?: number | undefined;
  memoryWriteWrittenCount?: number | undefined;
  memoryWriteRejectedCount?: number | undefined;
  memoryWriteDeduplicatedCount?: number | undefined;
  memoryWriteSkippedCount?: number | undefined;
  memoryWriteIdempotencyKey?: string | undefined;
};

export type RuntimeMemoryWriteStatus = "pending" | "complete" | "partial" | "failed" | "skipped";

export type RuntimeLifecycleState = "active" | "sealing" | "disposed";

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
