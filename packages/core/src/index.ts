import type { EventBus } from "@companion/event-bus";
import type { Memory, MemoryRetrievalResult, RetrievedMemoryDebug } from "@companion/memory";
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
  rememberInteraction(input: {
    userMessage: string;
    assistantMessage: string;
    source?: string;
    tags?: string[];
  }): Promise<Memory>;
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
};

export type RuntimePromptPreview = {
  traceId: string;
  timestamp: string;
  userMessage: string;
  useMemory: boolean;
  memoryRepository: string;
  retrievedMemoryCountRaw: number;
  retrievedMemoryCount: number;
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

  constructor(private readonly options: RuntimeOrchestratorOptions) {}

  getLatestPromptPreview(): RuntimePromptPreview | null {
    return this.latestPromptPreview;
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
    const useMemory = options.useMemory ?? true;
    const reply = await this.generateReply(userEvent, { voiceOutput, useMemory });
    await this.maybeStoreMemory(userEvent, reply);
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
      useMemory: true
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
    options: { voiceOutput?: boolean | undefined; useMemory?: boolean | undefined } = {}
  ): Promise<AgentReplyEvent> {
    const voiceOutput = Boolean(options.voiceOutput);
    const useMemory = options.useMemory ?? true;
    const memoryContext = useMemory ? await this.retrieveMemories(event) : emptyMemoryContext();
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
      memoryEnabled: useMemory,
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
      useMemory,
      memoryRepository: this.options.memoryRepository ?? "in-memory",
      retrievedMemoryCountRaw: memoryContext.retrievedMemoryCountRaw,
      retrievedMemoryCount: memoryContext.retrievedMemoryCount,
      retrievedMemories: memoryContext.retrievedMemories,
      sections: prompt.sections,
      finalMessages: prompt.messages,
      finalPrompt: prompt.prompt,
      characterCount: prompt.characterCount,
      estimatedTokens: prompt.estimatedTokens,
      truncated: prompt.truncated
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
      tokenUsage: providerMetadata.tokenUsage
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
    reply: AgentReplyEvent
  ): Promise<void> {
    try {
      const importance = this.options.memory.scoreImportance(
        `${sourceEvent.payload.content}\n${reply.payload.content}`
      );
      if (importance < 0.1) {
        return;
      }

      await this.options.memory.rememberInteraction({
        userMessage: sourceEvent.payload.content,
        assistantMessage: reply.payload.content,
        source: "runtime",
        tags: [sourceEvent.payload.sessionId]
      });
    } catch (error) {
      await this.publishRuntimeError("Memory write failed after reply generation.", error, {
        traceId: reply.traceId,
        parentId: reply.id
      });
      this.options.logger?.warn?.(
        "optional memory write failed",
        this.errorLogContext(error, reply.traceId)
      );
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
          rawCount: memoryContext.retrievedMemoryCountRaw
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
}

type MemoryContext = {
  retrievedMemoryCountRaw: number;
  retrievedMemoryCount: number;
  retrievedMemories: RetrievedMemoryDebug[];
  promptMemories: RetrievedMemoryDebug[];
};

function emptyMemoryContext(): MemoryContext {
  return {
    retrievedMemoryCountRaw: 0,
    retrievedMemoryCount: 0,
    retrievedMemories: [],
    promptMemories: []
  };
}

function memoryToDebug(memory: Memory): RetrievedMemoryDebug {
  return {
    id: memory.id,
    type: memory.type,
    source: memory.source,
    importance: memory.importance,
    createdAt: memory.createdAt,
    displayText: memory.summary ?? memory.content,
    matchedBy: "original-query"
  };
}

function isRuntimeUserMessageEvent(
  input: UserMessageEvent | HandleUserMessageInput
): input is UserMessageEvent {
  return "type" in input && input.type === "user.message";
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown runtime error.";
}
