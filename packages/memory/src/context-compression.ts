export const CONTEXT_COMPRESSION_VERSION = "memory-vnext-compression.v1" as const;
export const CONTEXT_COMPRESSION_RUNTIME_STATUS =
  "IMPLEMENTED_PRIMITIVE_NOT_RUNTIME_ACTIVE" as const;

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
    const candidate = [...working]
      .filter((section) => isCompressible(section, protectedNames))
      .sort((left, right) => compressiblePriority(left) - compressiblePriority(right))[0];
    if (!candidate) break;

    const next = compressSection(candidate);
    if (next === candidate.content) break;
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
  if (section.name === "DirectContext") return 10;
  if (section.name === "RecentEpisodicMemory") return 20;
  if (section.name === "RelevantMemory") return 30;
  if (section.name === "CurrentSituation") return 40;
  return 50;
}

function compressSection(section: HierarchicalContextSection): string {
  const lines = section.content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length > 3) {
    const kept = [...lines.slice(0, 1), ...lines.slice(-2)];
    const omitted = lines.length - kept.length;
    return [...kept, `(${omitted} older ${section.name} lines compressed.)`].join("\n");
  }
  const target = Math.max(160, Math.floor(section.content.length * 0.72));
  if (section.content.length <= target) return section.content;
  return `${section.content.slice(0, target - 3).trimEnd()}...`;
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
