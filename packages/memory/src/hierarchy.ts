/**
 * Yuvi-native hierarchical memory layers.
 *
 * These layers are context-assembly meaning, not a second MemoryProvider and
 * not a replacement for MemoryEvent provenance, scope, or record lifecycle.
 *
 * L0 working context remains DirectContext / recent completed turns.
 * L1 is detailed recent episodic continuity.
 * L2 is existing durable Memory evidence (MemoryEvent / MemoryService).
 */

export const MEMORY_HIERARCHY_VERSION = "memory-vnext-hierarchy.v1" as const;

export const MemoryHierarchyLayers = ["L0", "L1", "L2"] as const;
export type MemoryHierarchyLayer = (typeof MemoryHierarchyLayers)[number];

export const DEFAULT_L1_GAP_MS = 30 * 60 * 1000;
export const DEFAULT_L1_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_L1_MAX_EPISODES = 12;
export const DEFAULT_L1_PROMPT_EPISODES = 4;
export const DEFAULT_L1_PROMPT_CHARS = 1800;
export const DEFAULT_L1_EPISODE_CHARS = 1200;
export const DEFAULT_L1_USER_STATEMENT_CHARS = 280;
export const DEFAULT_L1_MESSAGE_LIMIT = 80;
export const DEFAULT_L1_MESSAGE_CHARS = 24_000;

export const DEFAULT_ASSOCIATIVE_MAX_ITEMS = 2;
export const DEFAULT_ASSOCIATIVE_MAX_CHARS = 360;
export const DEFAULT_ASSOCIATIVE_MIN_SCORE = 0.42;
export const DEFAULT_ASSOCIATIVE_HIGH_SCORE = 0.75;
export const DEFAULT_RECURRENCE_MIN_COUNT = 2;
export const DEFAULT_RECURRENCE_MIN_SIMILARITY = 0.28;

export type MemoryHierarchyBudgets = {
  l1GapMs: number;
  l1RetentionMs: number;
  l1MaxEpisodes: number;
  l1PromptEpisodes: number;
  l1PromptChars: number;
  l1EpisodeChars: number;
  associativeMaxItems: number;
  associativeMaxChars: number;
  associativeMinScore: number;
  recurrenceMinCount: number;
  recurrenceMinSimilarity: number;
};

export const DEFAULT_MEMORY_HIERARCHY_BUDGETS: MemoryHierarchyBudgets = {
  l1GapMs: DEFAULT_L1_GAP_MS,
  l1RetentionMs: DEFAULT_L1_RETENTION_MS,
  l1MaxEpisodes: DEFAULT_L1_MAX_EPISODES,
  l1PromptEpisodes: DEFAULT_L1_PROMPT_EPISODES,
  l1PromptChars: DEFAULT_L1_PROMPT_CHARS,
  l1EpisodeChars: DEFAULT_L1_EPISODE_CHARS,
  associativeMaxItems: DEFAULT_ASSOCIATIVE_MAX_ITEMS,
  associativeMaxChars: DEFAULT_ASSOCIATIVE_MAX_CHARS,
  associativeMinScore: DEFAULT_ASSOCIATIVE_MIN_SCORE,
  recurrenceMinCount: DEFAULT_RECURRENCE_MIN_COUNT,
  recurrenceMinSimilarity: DEFAULT_RECURRENCE_MIN_SIMILARITY
};

export function normalizeMemoryHierarchyBudgets(
  input?: Partial<MemoryHierarchyBudgets>
): MemoryHierarchyBudgets {
  return {
    l1GapMs: clampInteger(input?.l1GapMs ?? DEFAULT_L1_GAP_MS, 60_000, 6 * 60 * 60 * 1000),
    l1RetentionMs: clampInteger(
      input?.l1RetentionMs ?? DEFAULT_L1_RETENTION_MS,
      60 * 60 * 1000,
      30 * 24 * 60 * 60 * 1000
    ),
    l1MaxEpisodes: clampInteger(input?.l1MaxEpisodes ?? DEFAULT_L1_MAX_EPISODES, 2, 40),
    l1PromptEpisodes: clampInteger(input?.l1PromptEpisodes ?? DEFAULT_L1_PROMPT_EPISODES, 1, 12),
    l1PromptChars: clampInteger(input?.l1PromptChars ?? DEFAULT_L1_PROMPT_CHARS, 240, 8000),
    l1EpisodeChars: clampInteger(input?.l1EpisodeChars ?? DEFAULT_L1_EPISODE_CHARS, 240, 4000),
    associativeMaxItems: clampInteger(
      input?.associativeMaxItems ?? DEFAULT_ASSOCIATIVE_MAX_ITEMS,
      0,
      6
    ),
    associativeMaxChars: clampInteger(
      input?.associativeMaxChars ?? DEFAULT_ASSOCIATIVE_MAX_CHARS,
      0,
      1200
    ),
    associativeMinScore: clampNumber(
      input?.associativeMinScore ?? DEFAULT_ASSOCIATIVE_MIN_SCORE,
      0.1,
      0.95
    ),
    recurrenceMinCount: clampInteger(
      input?.recurrenceMinCount ?? DEFAULT_RECURRENCE_MIN_COUNT,
      2,
      8
    ),
    recurrenceMinSimilarity: clampNumber(
      input?.recurrenceMinSimilarity ?? DEFAULT_RECURRENCE_MIN_SIMILARITY,
      0.1,
      0.9
    )
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
