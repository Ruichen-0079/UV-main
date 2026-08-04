import type { MemoryCandidate, MemoryOriginRole } from "./types.js";
import {
  detectCorrectionRequest,
  detectExplicitRememberRequest,
  extractCorrectionEvidence,
  inferUserMemoryIntent,
  stripExplicitRememberPrefix
} from "./intent.js";

export type ProvenanceEnrichmentInput = {
  userMessage: string;
  assistantMessage?: string | undefined;
};

export function enrichCandidateProvenance(
  candidate: MemoryCandidate,
  input: ProvenanceEnrichmentInput
): MemoryCandidate {
  const userMessage = normalizeMessage(input.userMessage);
  const assistantMessage = normalizeMessage(input.assistantMessage);
  const explicitRememberRequested =
    candidate.explicitRememberRequested ?? detectExplicitRememberRequest(userMessage);
  const correctionRequested =
    candidate.correctionRequested ??
    (candidate.originRole === "assistant" ? false : detectCorrectionRequest(userMessage));
  const userIntent = candidate.userIntent ?? inferUserMemoryIntent(userMessage);
  const originRole = inferOriginRole(candidate, userMessage, assistantMessage);
  const evidenceText =
    candidate.evidenceText ?? extractEvidenceText(userMessage, candidate.content);
  const correctionEvidence = correctionRequested
    ? extractCorrectionEvidence(userMessage)
    : undefined;

  return {
    ...candidate,
    explicitRememberRequested,
    correctionRequested,
    userIntent,
    originRole,
    ...(evidenceText ? { evidenceText } : {}),
    metadata: {
      ...(candidate.metadata ?? {}),
      explicitRememberRequested,
      correctionRequested,
      userIntent,
      originRole,
      ...(evidenceText ? { evidenceText } : {}),
      ...(correctionEvidence ? { correctionEvidence } : {})
    }
  };
}

export function isAssistantOnlyRestatement(
  candidate: MemoryCandidate,
  input: ProvenanceEnrichmentInput
): boolean {
  if (candidate.metadata?.["pendingRejection"] === "duplicate-candidate") {
    return false;
  }
  if (candidate.explicitRememberRequested || candidate.metadata?.["explicitRememberRequested"]) {
    return false;
  }
  if (
    candidate.correctionRequested ||
    candidate.metadata?.["correctionRequested"] === true ||
    isUserCorrection(candidate, input.userMessage)
  ) {
    return false;
  }

  const originRole = candidate.originRole ?? candidate.metadata?.["originRole"];
  if (originRole === "assistant") {
    return true;
  }

  const userMessage = normalizeMessage(input.userMessage);
  const assistantMessage = normalizeMessage(input.assistantMessage);
  if (!assistantMessage) {
    return originRole === "assistant";
  }

  if (mentionsAssistantRecall(candidate)) {
    return !userRestatesFact(userMessage, candidate.content);
  }

  const factCore = canonicalFactCore(candidate.content);
  if (!factCore || factCore.length < 6) {
    return false;
  }

  const userHasFact = messageContainsFactCore(userMessage, factCore);
  const assistantHasFact = messageContainsFactCore(assistantMessage, factCore);
  if (!userHasFact && assistantHasFact) {
    return true;
  }

  if (originRole === "mixed" && !userHasFact && assistantHasFact) {
    return true;
  }

  return false;
}

function inferOriginRole(
  candidate: MemoryCandidate,
  userMessage: string,
  assistantMessage: string
): MemoryOriginRole {
  const declared = candidate.originRole ?? candidate.metadata?.["originRole"];
  if (declared === "assistant") {
    return "assistant";
  }
  if (declared === "user" || declared === "mixed") {
    return declared;
  }

  const factCore = canonicalFactCore(candidate.content);
  const userHasFact = messageContainsFactCore(userMessage, factCore);
  const assistantHasFact = messageContainsFactCore(assistantMessage, factCore);

  if (userHasFact && !assistantHasFact) {
    return "user";
  }
  if (!userHasFact && assistantHasFact) {
    return "assistant";
  }
  if (userHasFact && assistantHasFact) {
    return candidate.explicitRememberRequested ? "user" : "mixed";
  }
  return "user";
}

function isUserCorrection(candidate: MemoryCandidate, userMessage: string): boolean {
  const text = `${userMessage} ${candidate.content} ${candidate.reason}`;
  return /(不对|其实不是|纠正|更正|其实|instead|actually|correction|contradiction|supersed)/iu.test(
    text
  );
}

function mentionsAssistantRecall(candidate: MemoryCandidate): boolean {
  const text = `${candidate.reason} ${candidate.summary ?? ""}`;
  return /(assistant\s+recalled|recalled\s+a\s+prior|复述|回忆|你之前说|你刚才说|prior\s+statement)/iu.test(
    text
  );
}

function userRestatesFact(userMessage: string, content: string): boolean {
  const factCore = canonicalFactCore(content);
  return messageContainsFactCore(userMessage, factCore);
}

function extractEvidenceText(userMessage: string, content: string): string | undefined {
  const stripped = stripExplicitRememberPrefix(userMessage);
  const normalizedContent = normalizeForMatch(content);
  const normalizedStripped = normalizeForMatch(stripped);
  if (normalizedStripped && normalizedContent.includes(normalizedStripped.slice(0, 12))) {
    return stripped;
  }
  return stripped.length >= 4 ? stripped : undefined;
}

function messageContainsFactCore(message: string, factCore: string): boolean {
  if (!factCore || factCore.length < 4) {
    return false;
  }
  const normalizedMessage = normalizeForMatch(message);
  if (normalizedMessage.includes(factCore)) {
    return true;
  }
  const tokens = factCore.match(/[\p{Letter}\p{Number}]{2,}/gu) ?? [];
  if (tokens.length === 0) {
    return false;
  }
  const matched = tokens.filter((token) => normalizedMessage.includes(token)).length;
  return matched / tokens.length >= 0.6;
}

function canonicalFactCore(content: string): string {
  return normalizeForMatch(content)
    .replace(/^(?:用户|我)/u, "")
    .replace(
      /(?:在)?\d{4}-\d{2}-\d{2}(?:年\d{1,2}月\d{1,2}日)?(?:早上|上午|中午|下午|晚上|凌晨)?/gu,
      ""
    )
    .replace(/\d{4}年\d{1,2}月\d{1,2}日/gu, "")
    .trim();
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，,。！!？?.；;：:""''「」【】（）()]/gu, "")
    .replace(/未/gu, "没")
    .replace(/早餐/gu, "早饭")
    .replace(/用餐/gu, "吃饭")
    .replace(/吃了/gu, "吃")
    .replace(/没吃早饭饭/gu, "没吃早饭")
    .replace(/skippedbreakfast/gu, "没吃早饭");
}

function normalizeMessage(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}
