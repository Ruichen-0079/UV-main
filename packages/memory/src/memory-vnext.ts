import type { ConversationMessage } from "./conversation-repository.js";
import { activateAssociativeMemories, type AssociativeRecallResult } from "./associative-recall.js";
import {
  compressHierarchicalContext,
  type ContextCompressionMetrics
} from "./context-compression.js";
import {
  DEFAULT_L1_MESSAGE_CHARS,
  DEFAULT_L1_MESSAGE_LIMIT,
  DEFAULT_L1_PROMPT_CHARS,
  DEFAULT_L1_PROMPT_EPISODES,
  DEFAULT_MEMORY_HIERARCHY_BUDGETS,
  MEMORY_HIERARCHY_VERSION,
  normalizeMemoryHierarchyBudgets,
  type MemoryHierarchyBudgets
} from "./hierarchy.js";
import type { MemoryEvent, MemoryRetrievalOutcome, MemoryRetrievalStatus } from "./provider.js";
import {
  assembleRecentEpisodes,
  formatRecentEpisodeForPrompt,
  rankRecentEpisodesForQuery,
  type RecentEpisode
} from "./recent-episode.js";
import type { RecentEpisodeStore } from "./recent-episode-store.js";
import { projectThinTemporalContext, type ThinTemporalProjection } from "./temporal-projection.js";

export const MEMORY_VNEXT_VERSION = "memory-vnext.v1" as const;

export type MemoryVNextLongTerm =
  | MemoryRetrievalOutcome
  | {
      status: MemoryRetrievalStatus;
      events?: readonly MemoryEvent[] | undefined;
    };

export type MemoryVNextAssembleInput = {
  now: Date;
  timezone?: string | undefined;
  queryText: string;
  currentTurnText?: string | undefined;
  sessionId?: string | undefined;
  personaId?: string | null | undefined;
  subjectUserId?: string | null | undefined;
  memoryScope?: string | null | undefined;
  directContextText: string;
  messages: readonly ConversationMessage[];
  longTerm?: MemoryVNextLongTerm | undefined;
  previouslyShownAssociativeIds?: readonly string[] | undefined;
  lastTurnIntruded?: boolean | undefined;
  episodeStore?: RecentEpisodeStore | undefined;
  persistEpisodes?: boolean | undefined;
  maxPromptCharacters?: number | undefined;
  budgets?: Partial<MemoryHierarchyBudgets> | undefined;
};

export type MemoryVNextCharacterProjection = {
  recentConversation: {
    state: "KNOWN" | "EMPTY";
    summary?: string;
    provenanceReferences?: string[];
  };
  memoryEvidence: {
    state: "KNOWN" | "PARTIAL" | "EMPTY" | "UNAVAILABLE" | "ERROR";
    summary?: string;
    provenanceReferences?: string[];
  };
  temporalContext: {
    state: "KNOWN" | "PARTIAL" | "UNKNOWN";
    summary?: string;
    provenanceReferences?: string[];
  };
};

export type MemoryVNextAssembly = {
  version: typeof MEMORY_VNEXT_VERSION;
  hierarchyVersion: typeof MEMORY_HIERARCHY_VERSION;
  episodes: RecentEpisode[];
  promptEpisodes: RecentEpisode[];
  recentEpisodicText: string;
  associative: AssociativeRecallResult;
  temporal: ThinTemporalProjection;
  compression?: ContextCompressionMetrics | undefined;
  characterProjection: MemoryVNextCharacterProjection;
};

export async function assembleMemoryVNextContext(
  input: MemoryVNextAssembleInput
): Promise<MemoryVNextAssembly> {
  const budgets = normalizeMemoryHierarchyBudgets(input.budgets);
  const reconstructed = assembleRecentEpisodes({
    messages: excludeCurrentUserTurn(input.messages, input.currentTurnText),
    now: input.now,
    timezone: input.timezone,
    sessionId: input.sessionId,
    personaId: input.personaId,
    subjectUserId: input.subjectUserId,
    memoryScope: input.memoryScope,
    budgets
  });

  if (input.persistEpisodes && input.episodeStore) {
    for (const episode of reconstructed) {
      await input.episodeStore.upsert(episode);
    }
    await input.episodeStore.rollover({
      now: input.now,
      sessionId: input.sessionId,
      personaId: input.personaId,
      subjectUserId: input.subjectUserId,
      maxActive: budgets.l1MaxEpisodes
    });
  }

  const stored = input.episodeStore
    ? await input.episodeStore.listActive({
        now: input.now,
        sessionId: input.sessionId,
        personaId: input.personaId,
        subjectUserId: input.subjectUserId,
        limit: budgets.l1MaxEpisodes
      })
    : reconstructed;

  const episodes = mergeEpisodes(stored, reconstructed).slice(0, budgets.l1MaxEpisodes);
  const ranked = rankRecentEpisodesForQuery(input.queryText, episodes, input.now, input.timezone);
  const beyondDirectContext = episodes.filter(
    (episode) => !isCoveredByDirectContext(episode, input.directContextText)
  );
  const rankedBeyond = ranked.filter((episode) =>
    beyondDirectContext.some((candidate) => candidate.id === episode.id)
  );
  const promptEpisodes = (rankedBeyond.length > 0 ? rankedBeyond : beyondDirectContext)
    .slice(0, budgets.l1PromptEpisodes)
    .slice()
    .sort((left, right) => left.endedAt.localeCompare(right.endedAt));

  let recentEpisodicText =
    promptEpisodes.length === 0
      ? "No recent episodic memory available."
      : promptEpisodes
          .map((episode) => formatRecentEpisodeForPrompt(episode, input.timezone))
          .join("\n");
  if (recentEpisodicText.length > budgets.l1PromptChars) {
    recentEpisodicText = `${recentEpisodicText.slice(0, budgets.l1PromptChars - 3).trimEnd()}...`;
  }

  const longTerm = normalizeLongTerm(input.longTerm);
  const associative = activateAssociativeMemories({
    queryText: input.queryText,
    now: input.now,
    timezone: input.timezone,
    currentTurnText: input.currentTurnText,
    directContextText: input.directContextText,
    episodes,
    longTerm,
    previouslyShownIds: input.previouslyShownAssociativeIds,
    lastTurnIntruded: input.lastTurnIntruded,
    budgets
  });

  const priorMessages = excludeCurrentUserTurn(input.messages, input.currentTurnText);
  const lastPrior = priorMessages[priorMessages.length - 1];
  const lastInteractionAt = lastPrior?.completedAt ?? lastPrior?.createdAt;
  const temporal = projectThinTemporalContext({
    now: input.now,
    timezone: input.timezone,
    lastInteractionAt,
    episodes: promptEpisodes
  });

  const compression =
    input.maxPromptCharacters !== undefined
      ? compressHierarchicalContext({
          sections: [
            {
              name: "DirectContext",
              content: input.directContextText || "No recent direct context available."
            },
            { name: "RecentEpisodicMemory", content: recentEpisodicText },
            {
              name: "RelevantMemory",
              content: associative.items
                .map((item) => `- [associated][${item.ageBand}] ${item.content}`)
                .join("\n")
            }
          ],
          maxCharacters: input.maxPromptCharacters
        }).metrics
      : undefined;

  return {
    version: MEMORY_VNEXT_VERSION,
    hierarchyVersion: MEMORY_HIERARCHY_VERSION,
    episodes,
    promptEpisodes,
    recentEpisodicText,
    associative,
    temporal,
    ...(compression ? { compression } : {}),
    characterProjection: projectCharacterFacing({
      directContextText: input.directContextText,
      recentEpisodicText,
      promptEpisodes,
      associative,
      temporal,
      longTerm
    })
  };
}

export function memoryVNextMessageWindow(): { limit: number; maxCharacters: number } {
  return { limit: DEFAULT_L1_MESSAGE_LIMIT, maxCharacters: DEFAULT_L1_MESSAGE_CHARS };
}

export function defaultMemoryVNextBudgets(): MemoryHierarchyBudgets {
  return { ...DEFAULT_MEMORY_HIERARCHY_BUDGETS };
}

function mergeEpisodes(stored: RecentEpisode[], reconstructed: RecentEpisode[]): RecentEpisode[] {
  const byId = new Map<string, RecentEpisode>();
  for (const episode of stored) {
    byId.set(episode.id, episode);
  }
  for (const episode of reconstructed) {
    const existing = byId.get(episode.id);
    if (!existing || episode.sourceTurnIds.length >= existing.sourceTurnIds.length) {
      byId.set(episode.id, episode);
    }
  }
  return [...byId.values()].sort((left, right) => right.endedAt.localeCompare(left.endedAt));
}

function normalizeLongTerm(input: MemoryVNextLongTerm | undefined): MemoryRetrievalOutcome {
  if (!input) {
    return { status: "empty", events: [], source: "none", limited: false };
  }
  if (
    "events" in input &&
    Array.isArray((input as MemoryRetrievalOutcome).events) &&
    "source" in input
  ) {
    return input as MemoryRetrievalOutcome;
  }
  return {
    status: input.status,
    events: input.events ? [...input.events] : [],
    source: "memory-vnext",
    limited: false
  };
}

function projectCharacterFacing(input: {
  directContextText: string;
  recentEpisodicText: string;
  promptEpisodes: RecentEpisode[];
  associative: AssociativeRecallResult;
  temporal: ThinTemporalProjection;
  longTerm: MemoryRetrievalOutcome;
}): MemoryVNextCharacterProjection {
  const recentConversation = input.directContextText.trim()
    ? {
        state: "KNOWN" as const,
        summary: trimSummary(input.directContextText, 4000),
        provenanceReferences: ["direct-context"]
      }
    : { state: "EMPTY" as const };

  const memoryState = mapLongTermState(
    input.longTerm.status,
    input.promptEpisodes.length,
    input.associative.status
  );
  const memoryParts = [
    input.promptEpisodes.length > 0 ? input.recentEpisodicText : null,
    ...input.associative.items.map((item) => `[associated ${item.ageBand}] ${item.content}`)
  ].filter(Boolean);
  const memoryEvidence =
    memoryState === "UNAVAILABLE" || memoryState === "ERROR" || memoryState === "EMPTY"
      ? { state: memoryState }
      : {
          state: memoryState,
          summary: trimSummary(memoryParts.join("\n"), 4000),
          provenanceReferences: [
            ...input.promptEpisodes.map((episode) => episode.id),
            ...input.associative.items.map((item) => item.provenanceId)
          ].slice(0, 32)
        };

  const temporalState =
    input.temporal.temporalConfidence === "unknown" && input.temporal.episodes.length === 0
      ? ("UNKNOWN" as const)
      : input.temporal.episodes.length > 0
        ? ("KNOWN" as const)
        : ("PARTIAL" as const);
  const temporalContext =
    temporalState === "UNKNOWN"
      ? { state: temporalState }
      : {
          state: temporalState,
          summary: trimSummary(input.temporal.promptText, 4000),
          provenanceReferences: input.temporal.episodes
            .map((episode) => episode.episodeId)
            .slice(0, 32)
        };

  return {
    recentConversation,
    memoryEvidence,
    temporalContext
  };
}

function mapLongTermState(
  longTermStatus: MemoryRetrievalStatus,
  episodeCount: number,
  associativeStatus: MemoryRetrievalStatus
): MemoryVNextCharacterProjection["memoryEvidence"]["state"] {
  if (longTermStatus === "unavailable" && episodeCount === 0) return "UNAVAILABLE";
  if (longTermStatus === "error" && episodeCount === 0) return "ERROR";
  if (
    episodeCount === 0 &&
    associativeStatus === "empty" &&
    (longTermStatus === "empty" || longTermStatus === "ok")
  ) {
    return episodeCount === 0 && associativeStatus === "empty" && longTermStatus !== "ok"
      ? "EMPTY"
      : "EMPTY";
  }
  if (episodeCount > 0 && (longTermStatus === "unavailable" || longTermStatus === "error"))
    return "PARTIAL";
  if (episodeCount > 0 || associativeStatus === "ok") return "KNOWN";
  return "EMPTY";
}

function trimSummary(text: string, max: number): string {
  const compact = text.trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 3).trimEnd()}...`;
}

function isCoveredByDirectContext(episode: RecentEpisode, directContextText: string): boolean {
  const context = directContextText.trim();
  if (!context || episode.userStatements.length === 0) return false;
  return episode.userStatements.every((statement) => context.includes(statement));
}

function excludeCurrentUserTurn(
  messages: readonly ConversationMessage[],
  currentTurnText: string | undefined
): ConversationMessage[] {
  const current = currentTurnText?.trim();
  if (!current) return [...messages];
  let excluded = false;
  const kept: ConversationMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!excluded && message.role === "user" && message.content.trim() === current) {
      excluded = true;
      continue;
    }
    kept.unshift(message);
  }
  return kept;
}

export const MEMORY_VNEXT_L1_PROMPT_EPISODES = DEFAULT_L1_PROMPT_EPISODES;
export const MEMORY_VNEXT_L1_PROMPT_CHARS = DEFAULT_L1_PROMPT_CHARS;
