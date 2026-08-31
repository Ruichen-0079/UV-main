export const CONTEXT_COMPRESSION_VERSION = "memory-vnext-compression.v2" as const;
export const CONTEXT_COMPRESSION_RUNTIME_STATUS = "RUNTIME_ACTIVE_BEHIND_FLAG" as const;

/**
 * A compressor must receive an explicit partition. This keeps it from being
 * accidentally applied to the complete Character contract or provider ABI.
 */
export const ContextCompressionPartitions = [
  "PROTECTED",
  "COMPRESSIBLE_RECENT",
  "COMPRESSIBLE_EPISODIC",
  "COMPRESSIBLE_LONG_TERM"
] as const;
export type ContextCompressionPartition = (typeof ContextCompressionPartitions)[number];

export const ProtectedPromptSectionNames = [
  "SystemIdentity",
  "CharacterStyle",
  "ProactiveInstruction",
  "RelationshipContext",
  "CurrentTime",
  "CurrentAffect",
  "CurrentSituation",
  "Tools",
  "UserMessage"
] as const;

export type CompressibleSectionName =
  | "DirectContext"
  | "RecentEpisodicMemory"
  | "RelevantMemory"
  | "CurrentSituation"
  | "RelationshipContext"
  | "CurrentAffect"
  | "Tools";

export type HierarchicalContextSection = {
  name: string;
  content: string;
  partition: ContextCompressionPartition;
  stable?: boolean | undefined;
  compressible?: boolean | undefined;
  /** Keep the newest complete lines verbatim, used for the L0 near-turn window. */
  protectedTailLines?: number | undefined;
};

export type ContextCompressionInput = {
  sections: HierarchicalContextSection[];
  /** Character budget for the explicitly supplied partitions, not the whole ABI. */
  maxCharacters: number;
};

export type ContextCompressionPartitionCounts = Record<ContextCompressionPartition, number>;

export type ContextCompressionMetrics = {
  version: typeof CONTEXT_COMPRESSION_VERSION;
  beforeCharacters: number;
  afterCharacters: number;
  beforeTokens: number;
  afterTokens: number;
  compressedSectionNames: string[];
  partitionCounts: ContextCompressionPartitionCounts;
  protectedPreserved: boolean;
  epistemicMarkersPreserved: boolean;
  dropped: boolean;
};

export type ContextCompressionResult = {
  sections: HierarchicalContextSection[];
  metrics: ContextCompressionMetrics;
};

const SEMANTIC_MARKER =
  /(?:\b(?:UNKNOWN|UNAVAILABLE|EMPTY|ERROR|PARTIAL|NEED_COGNITION|Cognition|P[0-9]+|supersed(?:ed|es)?|correction|corrected|not authoritative|non-authoritative|time-unknown|occurredAt|recordedAt|provenance|evidence|hard boundary|boundary|control marker|Memory was disabled|No relevant memory retrieved|no matching memory|memory deletion failed|Do not pretend to remember|do not|never|must)\b|status\s*[:=]|state\s*[:=]|\[L[012]\])/giu;
const DEFAULT_PROTECTED = new Set<string>(ProtectedPromptSectionNames);
const MAX_COMPACTED_DETAIL_RUN = 3;

export function compressHierarchicalContext(
  input: ContextCompressionInput
): ContextCompressionResult {
  const beforeCharacters = totalCharacters(input.sections);
  const working = input.sections.map((section) => ({ ...section }));
  const compressedSectionNames: string[] = [];
  const blocked = new Set<string>();

  while (totalCharacters(working) > Math.max(0, input.maxCharacters)) {
    const candidate = [...working]
      .filter((section) => isCompressible(section, blocked))
      .sort(
        (left, right) =>
          compressiblePriority(left) - compressiblePriority(right) ||
          right.content.length - left.content.length
      )[0];
    if (!candidate) break;

    const next = compressSection(candidate);
    if (next === candidate.content) {
      blocked.add(candidate.name);
      continue;
    }
    candidate.content = next;
    if (!compressedSectionNames.includes(candidate.name)) {
      compressedSectionNames.push(candidate.name);
    }
  }

  const afterCharacters = totalCharacters(working);
  const epistemicMarkersPreserved = input.sections.every((original) => {
    const current = working.find((section) => section.name === original.name)?.content ?? "";
    return preservesEpistemicMarkers(original.content, current);
  });
  const protectedPreserved = input.sections.every((original) => {
    if (!isProtected(original, DEFAULT_PROTECTED)) return true;
    return original.content === working.find((section) => section.name === original.name)?.content;
  });

  return {
    sections: working,
    metrics: {
      version: CONTEXT_COMPRESSION_VERSION,
      beforeCharacters,
      afterCharacters,
      beforeTokens: estimateTokens(beforeCharacters),
      afterTokens: estimateTokens(afterCharacters),
      compressedSectionNames,
      partitionCounts: countPartitions(input.sections),
      protectedPreserved,
      epistemicMarkersPreserved,
      dropped: afterCharacters < beforeCharacters
    }
  };
}

export function estimateTokensFromCharacters(characters: number): number {
  return estimateTokens(characters);
}

function isCompressible(section: HierarchicalContextSection, blocked: Set<string>): boolean {
  if (blocked.has(section.name)) return false;
  if (section.partition === "PROTECTED") return false;
  if (DEFAULT_PROTECTED.has(section.name)) return false;
  if (section.stable === true || section.compressible === false) return false;
  if (section.content.length <= 160) return false;
  return true;
}

function isProtected(section: HierarchicalContextSection, protectedNames: Set<string>): boolean {
  return (
    section.partition === "PROTECTED" || protectedNames.has(section.name) || section.stable === true
  );
}

function compressiblePriority(section: HierarchicalContextSection): number {
  if (section.partition === "COMPRESSIBLE_RECENT") return 10;
  if (section.partition === "COMPRESSIBLE_EPISODIC") return 20;
  return 30;
}

/**
 * Compression is line-structured and conservative:
 * - the near-turn tail is never touched;
 * - semantic, epistemic, temporal, provenance, correction, and technical
 *   lines are never replaced;
 * - only duplicate lines and non-semantic older detail runs are compacted.
 */
function compressSection(section: HierarchicalContextSection): string {
  const lines = section.content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return section.content;

  const protectedTailLines = Math.min(
    lines.length,
    Math.max(0, Math.trunc(section.protectedTailLines ?? 0))
  );
  const protectedIndexes = new Set(
    Array.from({ length: protectedTailLines }, (_, offset) => lines.length - 1 - offset)
  );
  const seen = new Set<string>();
  const deduped: Array<{ line: string; protected: boolean }> = [];

  for (const [index, line] of lines.entries()) {
    const normalized = normalizeLine(line);
    const isTail = protectedIndexes.has(index);
    if (!isTail && normalized && seen.has(normalized)) continue;
    if (normalized) seen.add(normalized);
    deduped.push({ line, protected: isTail });
  }

  const compacted: string[] = [];
  let detailRun = 0;
  for (const item of deduped) {
    const semantic = item.protected || isSemanticLine(item.line, section.partition);
    if (semantic) {
      detailRun = 0;
      compacted.push(item.line);
      continue;
    }

    detailRun += 1;
    if (detailRun <= MAX_COMPACTED_DETAIL_RUN) {
      compacted.push(item.line);
    }
    if (detailRun === MAX_COMPACTED_DETAIL_RUN) {
      compacted.push(`(${section.partition.toLocaleLowerCase()} older detail compressed.)`);
    }
  }

  const next = compacted.join("\n");
  return next.length < section.content.length ? next : section.content;
}

function isSemanticLine(line: string, partition: ContextCompressionPartition): boolean {
  if (SEMANTIC_MARKER.test(line)) {
    SEMANTIC_MARKER.lastIndex = 0;
    return true;
  }
  SEMANTIC_MARKER.lastIndex = 0;

  if (
    /(?:correction|corrected|纠正|更正|改成|supersed|替代|已取代|not authoritative|non-authoritative)/iu.test(
      line
    )
  ) {
    return true;
  }
  if (
    /(?:sha|commit|port|端口|model|模型|provider|路径|path|file|文件|https?:\/\/|postgres:\/\/|[A-Za-z]:\\|\/[^\s]+|\b\d{2,5}\b|\b[a-f0-9]{7,40}\b)/iu.test(
      line
    )
  ) {
    return true;
  }
  if (
    /(?:occurredAt|recordedAt|validUntil|expires|time-unknown|yesterday|today|hours?-ago|minutes?-ago|昨天|今天|时间未知|From \S+ to \S+)/iu.test(
      line
    )
  ) {
    return true;
  }
  if (partition === "COMPRESSIBLE_EPISODIC") {
    return /(?:User said|用户说|Still unresolved|Unresolved|Task state)/iu.test(line);
  }
  if (partition === "COMPRESSIBLE_LONG_TERM") {
    return /(?:\[[^\]]+\]|evidence|provenance|scope|source|record)/iu.test(line);
  }
  return false;
}

function preservesEpistemicMarkers(original: string, current: string): boolean {
  const markers = original.match(SEMANTIC_MARKER) ?? [];
  SEMANTIC_MARKER.lastIndex = 0;
  const normalizedCurrent = current.toLocaleLowerCase();
  return markers.every((marker) => normalizedCurrent.includes(marker.toLocaleLowerCase()));
}

function countPartitions(
  sections: readonly HierarchicalContextSection[]
): ContextCompressionPartitionCounts {
  const counts: ContextCompressionPartitionCounts = {
    PROTECTED: 0,
    COMPRESSIBLE_RECENT: 0,
    COMPRESSIBLE_EPISODIC: 0,
    COMPRESSIBLE_LONG_TERM: 0
  };
  for (const section of sections) counts[section.partition] += 1;
  return counts;
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function totalCharacters(sections: readonly HierarchicalContextSection[]): number {
  return sections.reduce((sum, section) => sum + section.content.length, 0);
}

function estimateTokens(characters: number): number {
  return Math.ceil(Math.max(0, characters) / 4);
}
