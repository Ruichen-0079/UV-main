import type { MemoryEvent, MemoryRetrievalOutcome, MemoryRetrievalStatus } from "./provider.js";
import {
  DEFAULT_ASSOCIATIVE_HIGH_SCORE,
  DEFAULT_MEMORY_HIERARCHY_BUDGETS,
  type MemoryHierarchyBudgets
} from "./hierarchy.js";
import {
  compactMemoryText,
  hasTechnicalExactOverlap,
  jaccardSimilarity,
  tokenizeMemoryText
} from "./memory-vnext-text.js";
import { episodeSearchCorpus, type RecentEpisode } from "./recent-episode.js";
import { ageBand, type TemporalAgeBand } from "./temporal-projection.js";

export const ASSOCIATIVE_RECALL_VERSION = "memory-vnext-associative.v1" as const;

export type AssociativeCandidateSource = "L1" | "L2";

export type AssociativeRecallItem = {
  id: string;
  layer: AssociativeCandidateSource;
  content: string;
  score: number;
  reason: string;
  ageBand: TemporalAgeBand;
  provenanceId: string;
  occurredAt: string | null;
  recordedAt: string | null;
};

export type AssociativeRecallInput = {
  queryText: string;
  now: Date;
  timezone?: string | undefined;
  currentTurnText?: string | undefined;
  directContextText?: string | undefined;
  episodes?: readonly RecentEpisode[] | undefined;
  longTerm?: MemoryRetrievalOutcome | readonly MemoryEvent[] | undefined;
  previouslyShownIds?: readonly string[] | undefined;
  lastTurnIntruded?: boolean | undefined;
  budgets?: Partial<MemoryHierarchyBudgets> | undefined;
};

export type AssociativeRecallResult = {
  version: typeof ASSOCIATIVE_RECALL_VERSION;
  status: MemoryRetrievalStatus;
  items: AssociativeRecallItem[];
  skippedReason?: string;
};

const INFRASTRUCTURE_LEAK =
  /\b(?:mem0|postgres|postgresql|pgvector|qdrant|sidecar|DATABASE_URL|MemoryProvider|MemoryBackend)\b/gi;

export function activateAssociativeMemories(
  input: AssociativeRecallInput
): AssociativeRecallResult {
  const budgets = { ...DEFAULT_MEMORY_HIERARCHY_BUDGETS, ...input.budgets };
  if (budgets.associativeMaxItems === 0 || budgets.associativeMaxChars === 0) {
    return {
      version: ASSOCIATIVE_RECALL_VERSION,
      status: "empty",
      items: [],
      skippedReason: "disabled"
    };
  }

  const longTerm = normalizeLongTerm(input.longTerm);

  const query = input.queryText.trim();
  if (!query) {
    return {
      version: ASSOCIATIVE_RECALL_VERSION,
      status: "empty",
      items: [],
      skippedReason: "empty-query"
    };
  }

  const echoSources = [input.currentTurnText, input.directContextText].filter(Boolean).join("\n");
  const queryTokens = tokenizeMemoryText(query);
  const shown = new Set(input.previouslyShownIds ?? []);
  const longTermEvents =
    longTerm.status === "unavailable" || longTerm.status === "error" ? [] : longTerm.events;
  const scored = [
    ...(input.episodes ?? []).map((episode) =>
      scoreEpisode(episode, query, queryTokens, input.now, input.timezone)
    ),
    ...longTermEvents.map((event) =>
      scoreEvent(event, query, queryTokens, input.now, input.timezone)
    )
  ]
    .filter((item): item is AssociativeRecallItem => item !== null)
    .filter((item) => item.score >= budgets.associativeMinScore)
    .filter((item) => !isEcho(item.content, echoSources))
    .filter((item) => !shown.has(item.id))
    .sort((left, right) => right.score - left.score);

  if (input.lastTurnIntruded) {
    const high = scored.filter((item) => item.score >= DEFAULT_ASSOCIATIVE_HIGH_SCORE);
    if (high.length === 0) {
      return {
        version: ASSOCIATIVE_RECALL_VERSION,
        status: "empty",
        items: [],
        skippedReason: "cooldown"
      };
    }
    return boundResult(
      high,
      budgets.associativeMaxItems,
      budgets.associativeMaxChars,
      longTerm.status
    );
  }

  if (scored.length === 0) {
    return {
      version: ASSOCIATIVE_RECALL_VERSION,
      status: "empty",
      items: [],
      skippedReason: "below-threshold"
    };
  }

  return boundResult(
    scored,
    budgets.associativeMaxItems,
    budgets.associativeMaxChars,
    longTerm.status
  );
}

function boundResult(
  items: AssociativeRecallItem[],
  maxItems: number,
  maxChars: number,
  longTermStatus: MemoryRetrievalStatus
): AssociativeRecallResult {
  const selected: AssociativeRecallItem[] = [];
  let chars = 0;
  for (const item of items) {
    if (selected.length >= maxItems) break;
    const sanitized = sanitizeCharacterFacing(item.content);
    if (!sanitized) continue;
    const nextChars = chars + sanitized.length;
    if (nextChars > maxChars && selected.length > 0) break;
    selected.push({ ...item, content: compactMemoryText(sanitized, 220) });
    chars = nextChars;
  }
  return {
    version: ASSOCIATIVE_RECALL_VERSION,
    status: selected.length > 0 ? (longTermStatus === "partial" ? "partial" : "ok") : "empty",
    items: selected,
    ...(selected.length === 0 ? { skippedReason: "budget" } : {})
  };
}

function scoreEpisode(
  episode: RecentEpisode,
  query: string,
  queryTokens: string[],
  now: Date,
  timezone?: string
): AssociativeRecallItem | null {
  const corpus = episodeSearchCorpus(episode);
  if (!corpus.trim()) return null;
  const lexical = jaccardSimilarity(queryTokens, tokenizeMemoryText(corpus));
  const technical = hasTechnicalExactOverlap(query, corpus);
  const occurred = parseDate(episode.occurredAt ?? episode.endedAt);
  const elapsed = occurred ? Math.max(0, now.getTime() - occurred.getTime()) : null;
  const band = ageBand(elapsed, occurred, now, timezone ?? "UTC");
  const decay = decayForAge(band);
  const score = Math.min(
    1,
    technical ? (0.72 + lexical * 0.2) * Math.max(decay, 0.7) : lexical * decay
  );
  if (score <= 0) return null;
  return {
    id: episode.id,
    layer: "L1",
    content: episode.whatHappened,
    score,
    reason: technical
      ? "technical-overlap"
      : lexical >= 0.4
        ? "lexical-overlap"
        : "weak-association",
    ageBand: band,
    provenanceId: episode.id,
    occurredAt: episode.occurredAt,
    recordedAt: episode.recordedAt
  };
}

function scoreEvent(
  event: MemoryEvent,
  query: string,
  queryTokens: string[],
  now: Date,
  timezone?: string
): AssociativeRecallItem | null {
  const content = event.content.trim();
  if (!content) return null;
  const lexical = jaccardSimilarity(queryTokens, tokenizeMemoryText(content));
  const technical = hasTechnicalExactOverlap(query, content);
  const occurred = parseDate(event.occurredAt ?? event.observedAt ?? event.recordedAt);
  const elapsed = occurred ? Math.max(0, now.getTime() - occurred.getTime()) : null;
  const band = ageBand(elapsed, occurred, now, timezone ?? "UTC");
  const decay = decayForAge(band);
  const score = Math.min(
    1,
    technical ? (0.78 + lexical * 0.15) * Math.max(decay, 0.7) : lexical * decay
  );
  if (score <= 0) return null;
  return {
    id: event.id,
    layer: "L2",
    content,
    score,
    reason: technical
      ? "technical-overlap"
      : lexical >= 0.4
        ? "lexical-overlap"
        : "weak-association",
    ageBand: band,
    provenanceId: event.id,
    occurredAt: event.occurredAt ?? null,
    recordedAt: event.recordedAt ?? null
  };
}

function decayForAge(band: TemporalAgeBand): number {
  switch (band) {
    case "just-now":
    case "minutes-ago":
    case "hours-ago":
    case "earlier-today":
      return 1;
    case "yesterday":
      return 0.85;
    case "this-week":
      return 0.6;
    case "older":
      return 0.28;
    case "unknown":
      return 0.5;
  }
}

function normalizeLongTerm(input: AssociativeRecallInput["longTerm"]): {
  status: MemoryRetrievalStatus;
  events: MemoryEvent[];
} {
  if (!input) return { status: "empty", events: [] };
  if (Array.isArray(input))
    return { status: input.length > 0 ? "ok" : "empty", events: [...input] };
  if ("status" in input) return { status: input.status, events: [...input.events] };
  return { status: "empty", events: [] };
}

function isEcho(value: string, reference: string): boolean {
  if (!reference.trim()) return false;
  const candidate = normalize(value);
  if (!candidate) return false;
  return reference.split(/\r?\n/u).some((line) => {
    const normalized = normalize(line);
    if (!normalized || candidate.length < 8) return false;
    return (
      candidate === normalized || normalized.includes(candidate) || candidate.includes(normalized)
    );
  });
}

function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLocaleLowerCase();
}

function sanitizeCharacterFacing(content: string): string {
  return content.replace(INFRASTRUCTURE_LEAK, "[internal]").trim();
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
