import type {
  MemoryCandidate,
  MemoryExtractionInput,
  MemoryExtractor,
  MemorySubtype,
  MemoryType
} from "./types.js";
import { z } from "zod";

export type MemoryExtractionReasoner = {
  generateReasoning(input: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    effort?: "low" | "medium" | "high" | undefined;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    maxOutputTokens?: number | undefined;
  }): Promise<{ reasoning: string; answer?: string | undefined }>;
};

export class LlmMemoryExtractor implements MemoryExtractor {
  constructor(
    private readonly reasoner: MemoryExtractionReasoner,
    private readonly fallback: MemoryExtractor = new RuleBasedMemoryExtractor()
  ) {}

  async extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
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
              userMessage: input.userMessage,
              assistantMessage: input.assistantMessage ?? "",
              sourceTraceId: input.sourceTraceId ?? null
            })
          }
        ]
      });
      const parsed = parseLlmExtractorJson(output.answer ?? output.reasoning);
      const validated = LlmExtractorOutputSchema.parse(parsed);
      return validated.candidates
        .filter((candidate) => candidate.confidence >= 0.7 && candidate.importance >= 0.65)
        .map((candidate) => ({
          type: candidate.type,
          subtype: candidate.subtype ?? null,
          content: candidate.content.trim(),
          summary: candidate.summary?.trim() || candidate.content.trim(),
          importance: candidate.importance,
          tags: candidate.tags,
          reason: candidate.reason,
          sourceTraceId: candidate.sourceTraceId ?? input.sourceTraceId ?? null
        }));
    } catch {
      return this.fallback.extractCandidates(input);
    }
  }
}

export class RuleBasedMemoryExtractor implements MemoryExtractor {
  async extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
    const text = normalizeInput(input.userMessage);
    if (!text || isTrivialConversation(text) || isOrdinaryQuestion(text)) {
      return [];
    }

    const candidates: MemoryCandidate[] = [];
    const explicitContent = stripExplicitRememberPrefix(text);
    const sourceTraceId = input.sourceTraceId ?? null;

    if (mentionsExplicitRemember(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: inferType(explicitContent, "semantic"),
          subtype: inferSubtype(explicitContent),
          importance: 0.95,
          reason: "explicit-remember"
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
          reason: "provider-choice"
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
          reason: "stable-preference"
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
          reason: "path-or-repository"
        })
      );
    }

    if (mentionsCommandOrStartup(text)) {
      candidates.push(
        candidate({
          text: explicitContent,
          sourceTraceId,
          type: "procedural",
          subtype: "command",
          importance: 0.82,
          reason: "command-or-startup-instruction"
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
          reason: "project-milestone"
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
}): MemoryCandidate {
  const content = normalizeInput(input.text);
  return {
    type: input.type,
    subtype: input.subtype,
    content,
    summary: content.length > 180 ? `${content.slice(0, 177).trim()}...` : content,
    importance: input.importance,
    tags: createTags(content, input.subtype),
    reason: input.reason,
    sourceTraceId: input.sourceTraceId
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
    return "command";
  }
  if (mentionsProjectMilestone(text)) {
    return "milestone";
  }
  if (/项目|project|yuvi|runtime/iu.test(text)) {
    return "project";
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
  return [...tags];
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
    mentionsPathOrRepository(text) ||
    mentionsCommandOrStartup(text) ||
    mentionsProjectMilestone(text)
  );
}

function mentionsExplicitRemember(text: string): boolean {
  return /\bremember\b|\bnote this\b|\bfor future\b|记住|请记住/u.test(text);
}

function mentionsStablePreference(text: string): boolean {
  return /\bfrom now on\b|\bprefer\b|\bpreference\b|以后|默认使用|默认|偏好|以后都/u.test(text);
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
  return /(\bcommand\b|命令|\bpnpm\b|docker compose|\bdocker\b|脚本|\bstartup\b|启动|start-dev|dev\.sh|health\.sh|stop\.sh)/iu.test(
    text
  );
}

function mentionsProjectMilestone(text: string): boolean {
  return /(项目里程碑|milestone|完成|已完成|implemented|finished|done|通过验证|validation passed|all validation passed|上线)/iu.test(
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
        "milestone",
        "provider-choice",
        "path",
        "repo",
        "command",
        "emotion",
        "relationship"
      ])
      .nullable()
      .optional(),
    content: z.string().trim().min(8).max(500),
    summary: z.string().trim().min(1).max(240).nullable().optional(),
    importance: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    tags: z.array(z.string().trim().min(1).max(40)).max(8).default([]),
    reason: z.string().trim().min(3).max(120),
    sourceTraceId: z.string().trim().min(1).max(120).nullable().optional()
  })
  .strict();

const LlmExtractorOutputSchema = z
  .object({
    candidates: z.array(LlmExtractorCandidateSchema).max(5)
  })
  .strict();

function parseLlmExtractorJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  if (fenced) {
    return JSON.parse(fenced.trim());
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }

  throw new Error("LLM memory extractor did not return JSON.");
}

const llmExtractorSystemPrompt = [
  "You are YUVI's memory extraction filter.",
  "Return ONLY strict JSON with this shape:",
  '{"candidates":[{"type":"semantic","subtype":"preference","content":"...","summary":"...","importance":0.8,"confidence":0.9,"tags":["..."],"reason":"...","sourceTraceId":null}]}',
  "Allowed type values: working, episodic, semantic, emotional, procedural, relationship.",
  "Allowed subtype values: preference, fact, project, workflow, milestone, provider-choice, path, repo, command, emotion, relationship, or null.",
  "Extract only durable user/project memory. Reject greetings, ordinary Q&A, uncertain assistant answers, and transient chatter.",
  "Prefer concise memories. Never include API keys, Authorization headers, raw env files, or secrets."
].join("\n");
