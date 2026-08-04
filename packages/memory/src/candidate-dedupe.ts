import type { MemoryCandidate } from "./types.js";
import { canonicalEventDate, normalizeContentForFingerprint } from "./temporal.js";

export type CandidateDedupeResult = {
  kept: MemoryCandidate[];
  rejected: Array<{ candidate: MemoryCandidate; rejectedReason: string }>;
};

export function buildCandidateFingerprint(candidate: MemoryCandidate): string {
  const scope = candidate.scope ?? "user";
  const subtype = candidate.subtype ?? candidate.type;
  const eventDate = canonicalEventDate(candidate) ?? "none";
  const content = normalizeContentForFingerprint(candidate.content);
  return [
    candidate.subjectUserId ?? candidate.metadata?.["subjectUserId"] ?? "default-user",
    candidate.personaId ?? candidate.metadata?.["personaId"] ?? "default-persona",
    candidate.type,
    subtype,
    content,
    eventDate,
    scope,
    candidate.scopeId ?? ""
  ].join("|");
}

export function deduplicateCandidateBatch(candidates: MemoryCandidate[]): CandidateDedupeResult {
  const groups = new Map<string, MemoryCandidate[]>();
  for (const candidate of candidates) {
    const fingerprint = buildCandidateFingerprint(candidate);
    const group = groups.get(fingerprint) ?? [];
    group.push({
      ...candidate,
      metadata: {
        ...(candidate.metadata ?? {}),
        canonicalFingerprint: fingerprint
      }
    });
    groups.set(fingerprint, group);
  }

  const kept: MemoryCandidate[] = [];
  const rejected: Array<{ candidate: MemoryCandidate; rejectedReason: string }> = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]!);
      continue;
    }

    const sorted = [...group].sort(compareCandidatePriority);
    kept.push(sorted[0]!);
    for (const duplicate of sorted.slice(1)) {
      rejected.push({
        candidate: {
          ...duplicate,
          metadata: {
            ...(duplicate.metadata ?? {}),
            pendingRejection: "duplicate-candidate"
          }
        },
        rejectedReason: "duplicate-candidate"
      });
    }
  }

  return { kept, rejected };
}

function compareCandidatePriority(left: MemoryCandidate, right: MemoryCandidate): number {
  return candidatePriority(right) - candidatePriority(left);
}

function candidatePriority(candidate: MemoryCandidate): number {
  let score = 0;
  if (candidate.explicitRememberRequested || candidate.metadata?.["explicitRememberRequested"]) {
    score += 100;
  }
  const originRole = candidate.originRole ?? candidate.metadata?.["originRole"];
  if (originRole === "user") {
    score += 40;
  } else if (originRole === "mixed") {
    score += 20;
  } else if (originRole === "assistant") {
    score -= 20;
  }
  score += (candidate.confidence ?? 0.7) * 10;
  score += candidate.importance * 10;
  return score;
}
