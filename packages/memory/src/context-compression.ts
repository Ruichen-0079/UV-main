export const CONTEXT_COMPRESSION_VERSION = "memory-vnext-compression.v1" as const;
export const CONTEXT_COMPRESSION_RUNTIME_STATUS = "RUNTIME_ACTIVE" as const;

export const ProtectedPromptSectionNames = [
  "SystemIdentity",
  "CharacterStyle",
  "ProactiveInstruction",
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
  stable?: boolean | undefined;
  compressible?: boolean | undefined;
};

export type ContextCompressionInput = {
  sections: HierarchicalContextSection[];
  maxCharacters: number;
  protectedNames?: readonly string[] | undefined;
};

export type ContextCompressionMetrics = {
  version: typeof CONTEXT_COMPRESSION_VERSION;
  beforeCharacters: number;
  afterCharacters: number;
  beforeTokens: number;
  afterTokens: number;
  compressedSectionNames: string[];
  protectedPreserved: boolean;
  epistemicMarkersPreserved: boolean;
  dropped: boolean;
};

export type ContextCompressionResult = {
  sections: HierarchicalContextSection[];
  metrics: ContextCompressionMetrics;
};

const EPISTEMIC_MARKER =
  /\b(?:UNKNOWN|UNAVAILABLE|EMPTY|ERROR|NEED_COGNITION|Memory was disabled|no matching memory|memory deletion failed|Do not pretend to remember)\b/i;

const DEFAULT_PROTECTED = new Set<string>(ProtectedPromptSectionNames);

export function compressHierarchicalContext(
  input: ContextCompressionInput
): ContextCompressionResult {
  const protectedNames = new Set(input.protectedNames ?? [...DEFAULT_PROTECTED]);
  const beforeCharacters = totalCharacters(input.sections);
  const working = input.sections.map((section) => ({ ...section }));
  const compressedSectionNames: string[] = [];

  while (totalCharacters(working) > input.maxCharacters) {
    const choices = [...working]
      .filter((section) => isCompressible(section, protectedNames))
      .sort((left, right) => compressiblePriority(left) - compressiblePriority(right))
      .map((candidate) => ({ candidate, next: compressSection(candidate) }));
    const choice = choices.find(({ candidate, next }) => next.length < candidate.content.length);
    if (!choice) break;
    const { candidate, next } = choice;
    candidate.content = next;
    if (!compressedSectionNames.includes(candidate.name))
      compressedSectionNames.push(candidate.name);
  }

  const afterCharacters = totalCharacters(working);
  const epistemicMarkersPreserved = input.sections.every((original, index) => {
    if (!EPISTEMIC_MARKER.test(original.content)) return true;
    const current = working[index]?.content ?? "";
    return preservesEpistemicMarkers(original.content, current);
  });
  const protectedPreserved = input.sections.every((original, index) => {
    if (!protectedNames.has(original.name) && original.stable !== true) return true;
    return working[index]?.content === original.content;
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
      protectedPreserved,
      epistemicMarkersPreserved,
      dropped: afterCharacters < beforeCharacters
    }
  };
}

export function estimateTokensFromCharacters(characters: number): number {
  return estimateTokens(characters);
}

function isCompressible(section: HierarchicalContextSection, protectedNames: Set<string>): boolean {
  if (protectedNames.has(section.name) || section.stable === true) return false;
  if (section.compressible === false) return false;
  if (section.content.length <= 160) return false;
  return true;
}

function compressiblePriority(section: HierarchicalContextSection): number {
  if (section.name === "AssociativeRecall" || section.name === "TEMPORAL_CONTEXT") return 0;
  if (section.name === "DirectContext" || section.name === "RECENT_CONVERSATION") return 40;
  if (section.name === "RecentEpisodicMemory") return 20;
  if (section.name === "RelevantMemory" || section.name === "MEMORY_EVIDENCE") return 10;
  if (section.name === "CurrentSituation") return 40;
  return 50;
}

function compressSection(section: HierarchicalContextSection): string {
  const lines = section.content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const target = Math.max(160, Math.floor(section.content.length * 0.72));
  let next: string;
  if (lines.length > 3) {
    next = [
      ...lines.slice(0, 1),
      `(${lines.length - 3} older ${section.name} lines compressed.)`,
      ...lines.slice(-2)
    ].join("\n");
  } else {
    if (section.content.length <= target) return section.content;
    const recent = section.name === "DirectContext" || section.name === "RECENT_CONVERSATION";
    next = recent
      ? `...${section.content.slice(-(target - 3)).trimStart()}`
      : `${section.content.slice(0, target - 3).trimEnd()}...`;
  }
  const markers = [
    ...new Set(section.content.match(new RegExp(EPISTEMIC_MARKER.source, "gi")) ?? [])
  ];
  const missing = markers.filter((marker) => !next.toLowerCase().includes(marker.toLowerCase()));
  return missing.length ? `${next}\n[${missing.join("; ")}]` : next;
}

function preservesEpistemicMarkers(original: string, current: string): boolean {
  const markers = original.match(new RegExp(EPISTEMIC_MARKER.source, "gi")) ?? [];
  return markers.every((marker) =>
    current.toLocaleLowerCase().includes(marker.toLocaleLowerCase())
  );
}

function totalCharacters(sections: readonly HierarchicalContextSection[]): number {
  return sections.reduce((sum, section) => sum + section.content.length, 0);
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

/** Conservative Unicode character accounting (one character per token), not chars/4.
 * Normal work uses at most three quarters of the window and caps at 24K; the rest stays free.
 * Transport/instructions and output each have explicit reserves.
 */
export function modelContextBudget(contextWindow?: number) {
  const windowTokens =
    contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow >= 1024
      ? contextWindow
      : 16_384;
  const workingTokens = Math.min(24_576, Math.floor(windowTokens * 0.75));
  const outputTokens = Math.min(2048, Math.floor(windowTokens / 8));
  const safetyTokens = Math.min(2048, Math.floor(windowTokens / 8));
  return {
    windowTokens,
    workingTokens,
    outputTokens,
    safetyTokens,
    maxInputCharacters: Math.max(0, workingTokens - outputTokens - safetyTokens)
  };
}
