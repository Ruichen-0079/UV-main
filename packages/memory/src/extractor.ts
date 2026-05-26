import type {
  MemoryCandidate,
  MemoryExtractionInput,
  MemoryExtractor,
  MemoryExtractorStatus,
  MemoryLayer,
  MemoryScope,
  MemorySubtype,
  MemoryType
} from "./types.js";
import { hasRelativeTemporalExpression, isOrdinaryDailyEvent } from "./temporal.js";
import { z } from "zod";

export type MemoryExtractionReasoner = {
  readonly name?: string;
  generateReasoning(input: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    effort?: "low" | "medium" | "high" | undefined;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    maxOutputTokens?: number | undefined;
  }): Promise<{ reasoning: string; answer?: string | undefined }>;
};

export type LlmMemoryExtractorOptions = {
  enabled?: boolean;
  providerConfigured?: boolean;
  providerName?: string;
};

export class LlmMemoryExtractor implements MemoryExtractor {
  private lastStatus: MemoryExtractorStatus;

  constructor(
    private readonly reasoner: MemoryExtractionReasoner,
    private readonly fallback: MemoryExtractor = new RuleBasedMemoryExtractor(),
    private readonly options: LlmMemoryExtractorOptions = {}
  ) {
    this.lastStatus = this.createBaseStatus();
  }

  getStatus(): MemoryExtractorStatus {
    return this.lastStatus;
  }

  async extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
    this.lastStatus = this.createBaseStatus();
    if (!this.options.enabled || !this.options.providerConfigured) {
      this.lastStatus = {
        ...this.createBaseStatus(),
        active: "fallback-rule-based",
        fallbackUsed: true,
        skippedReason: !this.options.enabled
          ? "LLM memory extraction is disabled until explicitly enabled."
          : "Reasoning provider is not configured; falling back to rule-based extraction."
      };
      return this.fallback.extractCandidates(input);
    }

    let rawOutput = "";
    try {
      const output = await this.reasoner.generateReasoning({
        effort: "low",
        temperature: 0,
        maxOutputTokens: 800,
        messages: [
          {
            role: "system",
            content: llmExtractorSystemPrompt
          },
          {
            role: "user",
            content: JSON.stringify({
              sessionId: input.sessionId ?? null,
              userMessage: input.userMessage,
              assistantMessage: input.assistantMessage ?? "",
              sourceTraceId: input.sourceTraceId ?? null,
              timestamp: input.timestamp ?? new Date().toISOString(),
              providerMetadata: input.providerMetadata ?? null,
              memoryOptions: input.memoryOptions ?? null
            })
          }
        ]
      });
      rawOutput = output.answer ?? output.reasoning;
      const parsed = parseLlmExtractorJson(rawOutput);
      const normalized = normalizeLlmExtractorOutput(parsed);
      const accepted: MemoryCandidate[] = [];
      const rejectedReasons: string[] = [];
      const validationIssues: string[] = [];
      for (const candidateInput of normalized.candidates) {
        const candidateResult = LlmExtractorCandidateSchema.safeParse(
          normalizeLlmCandidateInput(candidateInput)
        );
        if (!candidateResult.success) {
          validationIssues.push(summarizeZodIssue(candidateResult.error));
          rejectedReasons.push(`invalid-candidate:${summarizeZodIssue(candidateResult.error)}`);
          continue;
        }
        const candidate = candidateResult.data;
        if (candidate.confidence < 0.7) {
          rejectedReasons.push(`low-confidence:${candidate.reason}`);
          continue;
        }
        accepted.push({
          type: candidate.type,
          subtype: candidate.subtype ?? null,
          scope: candidate.scope ?? inferScope(candidate.content),
          scopeId: candidate.scopeId ?? inferScopeId(candidate.content, candidate.scope),
          memoryLayer: candidate.memoryLayer ?? inferMemoryLayer(candidate.type, candidate.subtype),
          content: candidate.content.trim(),
          summary: candidate.summary?.trim() || candidate.content.trim(),
          importance: candidate.importance,
          confidence: candidate.confidence,
          metadata: candidate.metadata ?? {},
          tags: candidate.tags,
          reason: candidate.reason,
          sourceTraceId: candidate.sourceTraceId ?? input.sourceTraceId ?? null,
          observedAt: candidate.observedAt ?? input.timestamp ?? new Date().toISOString(),
          eventTime: candidate.eventTime ?? null,
          validFrom: candidate.validFrom ?? candidate.observedAt ?? input.timestamp ?? null,
          validUntil: candidate.validUntil ?? null,
          expiresAt: candidate.expiresAt ?? null,
          ...(candidate.possibleSupersedes
            ? { possibleSupersedes: candidate.possibleSupersedes }
            : {}),
          ...(candidate.possibleContradictions
            ? { possibleContradictions: candidate.possibleContradictions }
            : {})
        });
      }
      this.lastStatus = {
        ...this.createBaseStatus(),
        active: "llm",
        fallbackUsed: false,
        candidateCount: accepted.length,
        rejectedCount: rejectedReasons.length,
        rejectedReasons,
        validationIssues
      };
      return accepted;
    } catch (error) {
      const message = safeExtractorError(error);
      if (isJsonValidationError(error)) {
        const fallbackCandidates = await this.fallback.extractCandidates(input);
        const failedRawOutput =
          error instanceof LlmExtractorParseError ? error.rawOutput : rawOutput;
        const validationIssues =
          error instanceof LlmExtractorParseError ? error.validationIssues : [message];
        this.lastStatus = {
          ...this.createBaseStatus(),
          active: "fallback-rule-based",
          fallbackUsed: true,
          candidateCount: fallbackCandidates.length,
          rejectedCount: 1,
          rejectedReasons: ["invalid-llm-output"],
          error: message,
          validationIssues,
          ...(failedRawOutput ? { rawPreview: createRawPreview(failedRawOutput) } : {}),
          skippedReason: "LLM extractor output was invalid; falling back to rule-based extraction."
        };
        return fallbackCandidates;
      }

      const fallbackCandidates = await this.fallback.extractCandidates(input);
      this.lastStatus = {
        ...this.createBaseStatus(),
        active: "fallback-rule-based",
        fallbackUsed: true,
        candidateCount: fallbackCandidates.length,
        error: message,
        skippedReason: "Reasoning provider failed; falling back to rule-based extraction."
      };
      return fallbackCandidates;
    }
  }

  private createBaseStatus(): MemoryExtractorStatus {
    const enabled = Boolean(this.options.enabled && this.options.providerConfigured);
    return {
      mode: "llm",
      active: enabled ? "llm" : "fallback-rule-based",
      enabled,
      provider: this.options.providerName ?? this.reasoner.name ?? "reasoning",
      fallbackUsed: !enabled,
      ...(enabled
        ? {}
        : {
            skippedReason: !this.options.enabled
              ? "LLM memory extraction is disabled until explicitly enabled."
              : "Reasoning provider is not configured; falling back to rule-based extraction."
          })
    };
  }
}

export class RuleBasedMemoryExtractor implements MemoryExtractor {
  getStatus(): MemoryExtractorStatus {
    return {
      mode: "rule-based",
      active: "rule-based",
      enabled: true
    };
  }

  async extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
    const text = normalizeInput(input.userMessage);
    if (!text || isTrivialConversation(text) || isOrdinaryQuestion(text)) {
      return [];
    }
    if (
      isFailedOrUncertainAssistantAnswer(input.assistantMessage) &&
      !mentionsExplicitRemember(text)
    ) {
      return [];
    }

    const candidates: MemoryCandidate[] = [];
    const explicitContent = stripExplicitRememberPrefix(text);
    const sourceTraceId = input.sourceTraceId ?? null;
    const observedAt = input.timestamp ?? new Date().toISOString();

    if (mentionsExplicitRemember(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: inferType(explicitContent, "semantic"),
          subtype: inferSubtype(explicitContent),
          importance: isOrdinaryDailyEvent(explicitContent) ? 0.55 : 0.95,
          reason: "explicit-remember",
          observedAt
        })
      );
    }

    if (!mentionsExplicitRemember(text) && isOrdinaryDailyEvent(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "episodic",
          subtype: "event",
          importance: 0.45,
          reason: "ordinary-one-off-daily-event",
          observedAt
        })
      );
    }

    if (mentionsProviderChoice(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: "provider-choice",
          importance: 0.88,
          reason: "provider-choice",
          observedAt
        })
      );
    }

    if (mentionsIdentityStatement(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: "identity",
          importance: 0.9,
          reason: "explicit-user-identity",
          observedAt
        })
      );
    }

    if (mentionsCommunicationPreference(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: "preference",
          importance: 0.82,
          reason: "communication-preference",
          observedAt
        })
      );
    }

    if (mentionsDurableEmotionalPattern(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "emotional",
          subtype: "emotional-pattern",
          importance: 0.72,
          reason: "durable-emotional-pattern",
          observedAt
        })
      );
    }

    if (mentionsStablePreference(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: mentionsProviderChoice(text) ? "provider-choice" : "preference",
          importance: mentionsProviderChoice(text) ? 0.88 : 0.78,
          reason: "stable-preference",
          observedAt
        })
      );
    }

    if (mentionsPathOrRepository(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "semantic",
          subtype: inferPathSubtype(explicitContent),
          importance: 0.86,
          reason: "path-or-repository",
          observedAt
        })
      );
    }

    if (mentionsCommandOrStartup(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "procedural",
          subtype: mentionsConfigDecision(text) ? "config" : "command",
          importance: 0.82,
          reason: "command-or-startup-instruction",
          observedAt
        })
      );
    }

    if (mentionsTroubleshootingConclusion(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "procedural",
          subtype: "troubleshooting",
          importance: 0.8,
          reason: "troubleshooting-conclusion",
          observedAt
        })
      );
    }

    if (mentionsProjectMilestone(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "episodic",
          subtype: "milestone",
          importance: 0.76,
          reason: "project-milestone",
          observedAt
        })
      );
    }

    return dedupeCandidates(candidates);
  }
}

function candidate(input: {
  text: string;
  sourceTraceId: string | null;
  type: MemoryType;
  subtype: MemorySubtype | null;
  importance: number;
  reason: string;
  observedAt?: string;
}): MemoryCandidate {
  const content = normalizeInput(input.text);
  return {
    type: input.type,
    subtype: input.subtype,
    scope: inferScope(content),
    scopeId: inferScopeId(content),
    memoryLayer: inferMemoryLayer(input.type, input.subtype),
    content,
    summary: content.length > 180 ? `${content.slice(0, 177).trim()}...` : content,
    importance: input.importance,
    tags: createTags(content, input.subtype),
    reason: input.reason,
    confidence: 1,
    metadata: {
      generatedBy: "rule-based-memory-extractor",
      ...(input.reason === "explicit-remember" ? { explicitRemember: true } : {})
    },
    sourceTraceId: input.sourceTraceId,
    observedAt: input.observedAt ?? new Date().toISOString()
  };
}

function normalizeInput(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripExplicitRememberPrefix(text: string): string {
  return text.replace(/^(?:记住|请记住|remember|note this|for future)\s*[:：,-]?\s*/iu, "").trim();
}

function inferType(text: string, fallback: MemoryType): MemoryType {
  if (mentionsCommandOrStartup(text)) {
    return "procedural";
  }
  if (mentionsProjectMilestone(text)) {
    return "episodic";
  }
  if (hasRelativeTemporalExpression(text) && isOrdinaryDailyEvent(text)) {
    return "episodic";
  }
  return fallback;
}

function inferSubtype(text: string): MemorySubtype | null {
  if (mentionsProviderChoice(text)) {
    return "provider-choice";
  }
  if (mentionsPathOrRepository(text)) {
    return inferPathSubtype(text);
  }
  if (mentionsCommandOrStartup(text)) {
    return mentionsConfigDecision(text) ? "config" : "command";
  }
  if (mentionsTroubleshootingConclusion(text)) {
    return "troubleshooting";
  }
  if (mentionsProjectMilestone(text)) {
    return "milestone";
  }
  if (hasRelativeTemporalExpression(text) && isOrdinaryDailyEvent(text)) {
    return "event";
  }
  if (/项目|project|yuvi|runtime/iu.test(text)) {
    return "project-fact";
  }
  if (mentionsIdentityStatement(text)) {
    return "identity";
  }
  if (mentionsDurableEmotionalPattern(text)) {
    return "emotional-pattern";
  }
  if (mentionsStablePreference(text)) {
    return "preference";
  }
  return "fact";
}

function inferPathSubtype(text: string): MemorySubtype {
  return /repo|repository|仓库|github/iu.test(text) ? "repo" : "path";
}

function createTags(text: string, subtype: MemorySubtype | null): string[] {
  const tags = new Set<string>();
  if (subtype) {
    tags.add(subtype);
  }
  if (/yuvi/iu.test(text)) tags.add("yuvi");
  if (/runtime/iu.test(text)) tags.add("runtime");
  if (/deepseek/iu.test(text)) tags.add("deepseek");
  if (/xai|x\.ai/iu.test(text)) tags.add("xai");
  if (/dashscope|阿里云|通义/iu.test(text)) tags.add("dashscope");
  if (/postgres|pgvector/iu.test(text)) tags.add("postgres");
  if (/config|配置|env|\.env/iu.test(text)) tags.add("config");
  if (/troubleshoot|排错|原因|root cause/iu.test(text)) tags.add("troubleshooting");
  return [...tags];
}

function inferScope(text: string): MemoryScope {
  if (/yuvi|runtime|repo|repository|项目|仓库|workspace|工作区/iu.test(text)) {
    return "project";
  }
  if (/session|本次会话|temporary|临时/iu.test(text)) {
    return "session";
  }
  return "user";
}

function inferScopeId(text: string, scope: MemoryScope = inferScope(text)): string | null {
  if (scope === "project") {
    return "yuvi-runtime";
  }
  return null;
}

function inferMemoryLayer(
  type: MemoryType,
  subtype: MemorySubtype | null | undefined
): MemoryLayer {
  if (type === "working") {
    return "working";
  }
  if (
    type === "semantic" ||
    subtype === "preference" ||
    subtype === "project" ||
    subtype === "provider-choice"
  ) {
    return "core";
  }
  if (type === "episodic" || subtype === "milestone" || subtype === "troubleshooting") {
    return "recall";
  }
  return "recall";
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const byContent = new Map<string, MemoryCandidate>();
  for (const item of candidates) {
    const key = item.content.toLowerCase();
    const existing = byContent.get(key);
    if (!existing || item.importance > existing.importance) {
      byContent.set(key, item);
    }
  }
  return [...byContent.values()];
}

function isTrivialConversation(text: string): boolean {
  return /^(hi|hello|hey|你好|您好|哈喽|嗨)[!.。！\s]*$/iu.test(text);
}

function isOrdinaryQuestion(text: string): boolean {
  if (mentionsDurableSignal(text)) {
    return false;
  }
  return /[?？]\s*$/u.test(text) && text.length < 160;
}

function mentionsDurableSignal(text: string): boolean {
  return (
    mentionsExplicitRemember(text) ||
    mentionsProviderChoice(text) ||
    mentionsStablePreference(text) ||
    mentionsIdentityStatement(text) ||
    mentionsCommunicationPreference(text) ||
    mentionsDurableEmotionalPattern(text) ||
    mentionsPathOrRepository(text) ||
    mentionsCommandOrStartup(text) ||
    mentionsConfigDecision(text) ||
    mentionsTroubleshootingConclusion(text) ||
    mentionsProjectMilestone(text)
  );
}

function mentionsExplicitRemember(text: string): boolean {
  return /\bremember\b|\bnote this\b|\bfor future\b|记住|请记住/u.test(text);
}

function mentionsStablePreference(text: string): boolean {
  return /\bfrom now on\b|\bprefer\b|\bpreference\b|以后|默认使用|默认|偏好|以后都|喜欢|不喜欢|不吃/u.test(
    text
  );
}

function mentionsIdentityStatement(text: string): boolean {
  return /(?:我叫|我的名字是|叫我|可以叫我|my name is|call me|i am called)\s*[\p{Letter}\p{Number}_-]{1,40}/iu.test(
    text
  );
}

function mentionsCommunicationPreference(text: string): boolean {
  return /(请直接|一步步|分步骤|少废话|详细解释|用中文|用英文|prefer.*(?:concise|steps|direct)|communication preference)/iu.test(
    text
  );
}

function mentionsDurableEmotionalPattern(text: string): boolean {
  return /(我.*(?:长期|总是|经常).*(?:焦虑|紧张|烦|崩溃)|容易.*(?:焦虑|紧张|崩溃)|prefer.*when.*(?:anxious|frustrated))/iu.test(
    text
  );
}

function mentionsProviderChoice(text: string): boolean {
  return /(deepseek|xai|x\.ai|dashscope|通义|阿里云|provider|供应商|模型).*(chat|reasoning|tts|stt|vision|默认|使用|prefer|选择)|(?:chat|reasoning|tts|stt|vision).*(deepseek|xai|x\.ai|dashscope|通义|阿里云)/iu.test(
    text
  );
}

function mentionsPathOrRepository(text: string): boolean {
  return /(项目路径|repo path|repository|repo|仓库|路径|目录|workspace|工作区|\/home\/|c:\\|\\\\wsl|github)/iu.test(
    text
  );
}

function mentionsCommandOrStartup(text: string): boolean {
  return /(\bcommand\b|命令|\bpnpm\b|docker compose|\bdocker\b|脚本|\bstartup\b|启动|start-dev|dev\.sh|health\.sh|stop\.sh|curl\s+http|npm\s+run)/iu.test(
    text
  );
}

function mentionsConfigDecision(text: string): boolean {
  return /(\bport\b|端口|配置|config|\.env|env var|environment variable|database_url|memory_repository|server_port|server_host|默认端口|默认使用)/iu.test(
    text
  );
}

function mentionsTroubleshootingConclusion(text: string): boolean {
  return /(root cause|原因是|结论是|排错结论|解决办法|fix is|修复方式|failed because|失败原因)/iu.test(
    text
  );
}

function mentionsProjectMilestone(text: string): boolean {
  return /(项目里程碑|milestone|完成|已完成|implemented|finished|done|通过验证|validation passed|all validation passed|上线)/iu.test(
    text
  );
}

function isFailedOrUncertainAssistantAnswer(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  return /(i don'?t know|cannot determine|can't determine|not enough context|lack context|lacks context|unable to answer|无法确定|不知道|缺少上下文|没有足够上下文|不能判断|无法判断)/iu.test(
    text
  );
}

const LlmExtractorCandidateSchema = z
  .object({
    type: z.enum(["working", "episodic", "semantic", "emotional", "procedural", "relationship"]),
    subtype: z
      .enum([
        "preference",
        "fact",
        "project",
        "workflow",
        "event",
        "milestone",
        "provider-choice",
        "path",
        "repo",
        "command",
        "troubleshooting",
        "config",
        "identity",
        "project-fact",
        "config-decision",
        "emotional-state",
        "emotional-pattern",
        "health-note",
        "schedule",
        "test",
        "emotion",
        "relationship"
      ])
      .nullable()
      .optional(),
    scope: z.enum(["user", "project", "agent", "plugin", "session"]).optional(),
    scopeId: z.string().trim().min(1).max(120).nullable().optional(),
    memoryLayer: z.enum(["core", "recall", "archival", "working"]).optional(),
    content: z.string().trim().min(8).max(500),
    summary: z.string().trim().min(1).max(240).nullable().optional(),
    importance: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1).default(0.7),
    tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
    reason: z.string().trim().min(3).max(120),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .default({})
      .refine((metadata) => !hasUnsafeMetadataKey(metadata), {
        message: "metadata contains secret-like keys"
      })
      .transform(redactUnsafeMetadata),
    sourceTraceId: z.string().trim().min(1).max(120).nullable().optional(),
    observedAt: z.string().trim().min(1).max(80).nullable().optional(),
    eventTime: z.string().trim().min(1).max(80).nullable().optional(),
    validFrom: z.string().trim().min(1).max(80).nullable().optional(),
    validUntil: z.string().trim().min(1).max(80).nullable().optional(),
    expiresAt: z.string().trim().min(1).max(80).nullable().optional(),
    possibleSupersedes: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
    possibleContradictions: z.array(z.string().trim().min(1).max(120)).max(8).optional()
  })
  .strict();

const LlmExtractorOutputSchema = z
  .object({
    candidates: z.array(z.unknown()).max(5)
  })
  .strict();

class LlmExtractorParseError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string,
    readonly validationIssues: string[] = []
  ) {
    super(message);
    this.name = "LlmExtractorParseError";
  }
}

function parseLlmExtractorJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = stripJsonFence(trimmed);
  try {
    if (unfenced.startsWith("{") || unfenced.startsWith("[")) {
      return JSON.parse(unfenced);
    }

    const slice = extractSingleJsonValue(unfenced);
    return JSON.parse(slice);
  } catch (error) {
    throw new LlmExtractorParseError(safeExtractorError(error), text, [safeExtractorError(error)]);
  }
}

function normalizeLlmExtractorOutput(value: unknown): { candidates: unknown[] } {
  if (Array.isArray(value)) {
    return LlmExtractorOutputSchema.parse({ candidates: value });
  }

  if (!value || typeof value !== "object") {
    throw new LlmExtractorParseError("LLM memory extractor did not return a JSON object.", "", [
      "root:not-object"
    ]);
  }

  const record = value as Record<string, unknown>;
  const candidates = record["candidates"] ?? record["memories"];
  return LlmExtractorOutputSchema.parse({ candidates });
}

function normalizeLlmCandidateInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = { ...(value as Record<string, unknown>) };
  const normalizedType = normalizeLlmType(record["type"], record["subtype"]);
  if (normalizedType) {
    record["type"] = normalizedType.type;
    record["subtype"] = record["subtype"] ?? normalizedType.subtype;
  }
  if (!("subtype" in record)) {
    record["subtype"] = null;
  }
  if (!("tags" in record)) {
    record["tags"] = [];
  }
  if (!("confidence" in record)) {
    record["confidence"] = 0.7;
  }
  record["importance"] = normalizeScore(record["importance"]);
  record["confidence"] = normalizeScore(record["confidence"]);
  return record;
}

function normalizeLlmType(
  type: unknown,
  subtype: unknown
): { type: MemoryType; subtype: MemorySubtype | null } | null {
  const rawType = typeof type === "string" ? type.trim().toLowerCase() : "";
  const rawSubtype = typeof subtype === "string" ? subtype.trim().toLowerCase() : "";
  if (isMemoryType(rawType)) {
    return { type: rawType, subtype: isMemorySubtype(rawSubtype) ? rawSubtype : null };
  }
  if (rawType === "fact") {
    return { type: "semantic", subtype: "fact" };
  }
  if (rawType === "preference") {
    return { type: "semantic", subtype: "preference" };
  }
  if (rawType === "procedure") {
    return { type: "procedural", subtype: "workflow" };
  }
  if (rawType === "troubleshooting") {
    return { type: "procedural", subtype: "troubleshooting" };
  }
  if (rawType === "milestone") {
    return { type: "episodic", subtype: "milestone" };
  }
  if (rawType === "event") {
    return { type: "episodic", subtype: "event" };
  }
  return null;
}

function normalizeScore(value: unknown): unknown {
  const numberValue = typeof value === "string" ? Number(value) : value;
  if (typeof numberValue !== "number" || Number.isNaN(numberValue)) {
    return value;
  }
  if (numberValue >= 0 && numberValue <= 1) {
    return numberValue;
  }
  if (numberValue > 1 && numberValue <= 1.05) {
    return 1;
  }
  if (numberValue < 0 && numberValue >= -0.05) {
    return 0;
  }
  return numberValue;
}

function isMemoryType(value: string): value is MemoryType {
  return (
    value === "working" ||
    value === "episodic" ||
    value === "semantic" ||
    value === "emotional" ||
    value === "procedural" ||
    value === "relationship"
  );
}

function isMemorySubtype(value: string): value is MemorySubtype {
  return (
    value === "preference" ||
    value === "fact" ||
    value === "project" ||
    value === "workflow" ||
    value === "event" ||
    value === "milestone" ||
    value === "provider-choice" ||
    value === "path" ||
    value === "repo" ||
    value === "command" ||
    value === "troubleshooting" ||
    value === "config" ||
    value === "identity" ||
    value === "project-fact" ||
    value === "config-decision" ||
    value === "emotional-state" ||
    value === "emotional-pattern" ||
    value === "health-note" ||
    value === "schedule" ||
    value === "test" ||
    value === "emotion" ||
    value === "relationship"
  );
}

function stripJsonFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1];
  return fenced ? fenced.trim() : text;
}

function extractSingleJsonValue(text: string): string {
  const starts = [
    { char: "{", index: text.indexOf("{") },
    { char: "[", index: text.indexOf("[") }
  ].filter((item) => item.index >= 0);
  starts.sort((a, b) => a.index - b.index);
  const start = starts[0];
  if (!start) {
    throw new SyntaxError("LLM memory extractor did not return JSON.");
  }

  const end = findJsonValueEnd(text, start.index, start.char === "{" ? "}" : "]");
  const rest = text.slice(end + 1);
  if (/[{[]/.test(rest)) {
    throw new SyntaxError("LLM memory extractor returned multiple JSON values.");
  }
  return text.slice(start.index, end + 1);
}

function findJsonValueEnd(text: string, start: number, closing: string): number {
  const opening = text[start];
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  throw new SyntaxError("LLM memory extractor returned incomplete JSON.");
}

function isJsonValidationError(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    error instanceof z.ZodError ||
    error instanceof LlmExtractorParseError
  );
}

function safeExtractorError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "LLM memory extractor returned invalid candidate JSON.";
  }
  if (error instanceof SyntaxError) {
    return "LLM memory extractor returned malformed JSON.";
  }
  if (error instanceof Error) {
    return error.message.replace(/Bearer\s+[^\s]+|sk-[A-Za-z0-9_-]+/giu, "[redacted]");
  }
  return "LLM memory extraction failed.";
}

function summarizeZodIssue(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) {
    return "invalid-candidate";
  }
  return `${first.path.join(".") || "candidate"}:${first.message}`;
}

function createRawPreview(text: string): string {
  return redactUnsafeText(text).replace(/\s+/g, " ").trim().slice(0, 500);
}

function redactUnsafeText(text: string): string {
  return text
    .replace(
      /(api[-_]?key|authorization|bearer|token|password|secret)\s*[:=]\s*["']?[^"',\s}]+/gi,
      "$1=[redacted]"
    )
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]");
}

function hasUnsafeMetadataKey(metadata: Record<string, unknown>): boolean {
  return Object.keys(metadata).some((key) =>
    /api[_-]?key|authorization|bearer|token|password|secret/iu.test(key)
  );
}

function redactUnsafeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (/api[_-]?key|authorization|token|password|secret/iu.test(key)) {
      safe[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    }
  }
  return safe;
}

const llmExtractorSystemPrompt = [
  "You are YUVI's memory extraction filter.",
  "Return JSON only.",
  "Do not use markdown.",
  "Do not use code fences.",
  "Do not include explanations.",
  "Do not include natural language before or after JSON.",
  'The root object must be exactly: {"candidates":[]}.',
  "Example:",
  '{"candidates":[{"type":"semantic","subtype":"provider-choice","content":"用户偏好 Chat 和 Reasoning 使用 DeepSeek。","summary":"用户偏好 DeepSeek 作为 Chat/Reasoning provider。","importance":0.9,"confidence":0.9,"tags":["provider","deepseek","yuvi"],"reason":"The user stated a stable provider preference."}]}',
  "Allowed type values: working, episodic, semantic, emotional, procedural, relationship.",
  "Allowed subtype values: preference, fact, project, workflow, event, milestone, provider-choice, path, repo, command, troubleshooting, config, emotion, relationship, or null.",
  "Optional v2 fields: scope (user/project/agent/plugin/session), scopeId, memoryLayer (core/recall/archival/working), observedAt, eventTime, validFrom, validUntil, expiresAt, possibleSupersedes, possibleContradictions.",
  "Never preserve relative time expressions such as 今早, 今天, 昨天, 刚才, today, yesterday, this morning, or last night as-is in stored memory content.",
  "Resolve relative times against the provided timestamp/observedAt. Return absolute content plus eventTime, validFrom, validUntil, expiresAt, and safe temporal metadata when applicable.",
  "Classify one-off daily events as episodic/event/recall with low or medium importance. Do not upgrade one-off events to semantic/core just because the user said remember.",
  "Use semantic/core only for stable facts, preferences, health/allergy notes, schedules, project facts, workflows, provider/config choices, and troubleshooting conclusions.",
  "Extract only stable, useful, long-term memories or explicit remember requests.",
  "Do not store trivial chat, generic Q&A, transient chatter, failed answers, or assistant uncertainty.",
  "Prefer explicit user statements: project facts, preferences, paths, repos, commands, provider choices, milestones, troubleshooting conclusions.",
  "Use provider metadata only as safe context, never as memory content.",
  "Prefer concise memories. Never include API keys, Authorization headers, raw env files, or secrets."
].join("\n");
