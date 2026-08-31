import {
  compressHierarchicalContext,
  type ContextCompressionPartitionCounts,
  type HierarchicalContextSection
} from "@companion/memory";
import {
  DEFAULT_PROMPT_MAX_CHARACTERS,
  type PromptBuildInput,
  type PromptBuildOutput,
  type PromptSection,
  type PreformattedPromptContext
} from "@companion/prompt-builder";

export type RuntimeContextCompressionMode = "off" | "auto";

export const DEFAULT_NEAR_TURN_PROTECTION_LINES = 6;

export type RuntimeContextCompressionDiagnostics = {
  mode: RuntimeContextCompressionMode;
  attempted: boolean;
  triggered: boolean;
  budgetCharacters: number;
  originalCharacters: number;
  finalCharacters: number;
  originalTokens: number;
  finalTokens: number;
  savedTokens: number;
  reductionPercent: number;
  compressionLatencyMs: number;
  compressedSectionNames: string[];
  partitionCounts: ContextCompressionPartitionCounts;
  protectedPreserved: boolean;
  epistemicMarkersPreserved: boolean;
  budgetCompliant: boolean;
  fallbackReason?: string | undefined;
};

export type RuntimeContextCompressionResult = {
  prompt: PromptBuildOutput;
  diagnostics: RuntimeContextCompressionDiagnostics;
};

export type RuntimePromptBuilder = Pick<
  { buildPrompt(input: PromptBuildInput): PromptBuildOutput },
  "buildPrompt"
>;

const EMPTY_PARTITION_COUNTS: ContextCompressionPartitionCounts = {
  PROTECTED: 0,
  COMPRESSIBLE_RECENT: 0,
  COMPRESSIBLE_EPISODIC: 0,
  COMPRESSIBLE_LONG_TERM: 0
};
const PROTECTED_SECTION_NAMES = new Set([
  "SystemIdentity",
  "CharacterStyle",
  "RelationshipContext",
  "CurrentTime",
  "ProactiveInstruction",
  "UserMessage",
  "CurrentSituation",
  "CurrentAffect",
  "Tools"
]);
const COMPRESSED_SECTION_NAMES = [
  "DirectContext",
  "RecentEpisodicMemory",
  "RelevantMemory"
] as const;

/**
 * Build a Character prompt using the existing PromptBuilder budget authority.
 * Only the three explicitly designated context sections enter the compressor;
 * the complete Character prompt/ABI is never passed to it.
 */
export function buildPromptWithContextCompression(input: {
  promptBuilder: RuntimePromptBuilder;
  promptInput: PromptBuildInput;
  mode: RuntimeContextCompressionMode;
  nearTurnProtectionLines?: number | undefined;
}): RuntimeContextCompressionResult {
  const budgetCharacters = input.promptInput.maxCharacters ?? DEFAULT_PROMPT_MAX_CHARACTERS;
  const baseline = input.promptBuilder.buildPrompt(withoutPreformattedContext(input.promptInput));

  if (input.mode !== "auto" || baseline.characterCount <= budgetCharacters) {
    const prompt =
      input.mode === "auto" ? baseline : input.promptBuilder.buildPrompt(input.promptInput);
    return {
      prompt,
      diagnostics: createDiagnostics({
        mode: input.mode,
        attempted: false,
        triggered: false,
        budgetCharacters,
        baseline,
        prompt,
        compressionLatencyMs: 0,
        protectedPreserved: true,
        epistemicMarkersPreserved: true,
        budgetCompliant: prompt.characterCount <= budgetCharacters
      })
    };
  }

  let compressionStartedAt = performance.now();
  try {
    const baselineContext = getCompressibleSections(baseline.sections);
    const recentIsPresent = isPresentContext(baselineContext.RecentEpisodicMemory.content);
    const compressionSections = baselineContextToCompressionSections(
      baselineContext,
      recentIsPresent,
      input.nearTurnProtectionLines ?? DEFAULT_NEAR_TURN_PROTECTION_LINES
    );
    const selectedCharacters = compressionSections.reduce(
      (sum, section) => sum + section.content.length,
      0
    );
    const fixedCharacters = baseline.characterCount - selectedCharacters;
    compressionStartedAt = performance.now();
    const compression = compressHierarchicalContext({
      sections: compressionSections,
      maxCharacters: Math.max(0, budgetCharacters - fixedCharacters)
    });
    const preformattedContext = toPreformattedContext(
      input.promptInput.preformattedContext,
      compression.sections
    );
    const compressedPrompt = input.promptBuilder.buildPrompt({
      ...input.promptInput,
      preformattedContext
    });
    const protectedPreserved = preservesProtectedSections(
      baseline.sections,
      compressedPrompt.sections
    );
    const epistemicMarkersPreserved =
      compression.metrics.epistemicMarkersPreserved &&
      preservesProtectedSections(baseline.sections, compressedPrompt.sections);
    const budgetCompliant = compressedPrompt.characterCount <= budgetCharacters;

    if (
      !compression.metrics.protectedPreserved ||
      !epistemicMarkersPreserved ||
      !protectedPreserved ||
      !budgetCompliant
    ) {
      const prompt = input.promptBuilder.buildPrompt(input.promptInput);
      return {
        prompt,
        diagnostics: createDiagnostics({
          mode: input.mode,
          attempted: true,
          triggered: false,
          budgetCharacters,
          baseline,
          prompt,
          compressionLatencyMs: Math.round(performance.now() - compressionStartedAt),
          compressedSectionNames: compression.metrics.compressedSectionNames,
          partitionCounts: compression.metrics.partitionCounts,
          protectedPreserved: protectedPreserved && compression.metrics.protectedPreserved,
          epistemicMarkersPreserved,
          budgetCompliant: prompt.characterCount <= budgetCharacters,
          fallbackReason: !budgetCompliant ? "target_not_met" : "semantic_guard"
        })
      };
    }

    return {
      prompt: compressedPrompt,
      diagnostics: createDiagnostics({
        mode: input.mode,
        attempted: true,
        triggered: compression.metrics.dropped,
        budgetCharacters,
        baseline,
        prompt: compressedPrompt,
        compressionLatencyMs: Math.round(performance.now() - compressionStartedAt),
        compressedSectionNames: compression.metrics.compressedSectionNames,
        partitionCounts: compression.metrics.partitionCounts,
        protectedPreserved,
        epistemicMarkersPreserved,
        budgetCompliant
      })
    };
  } catch {
    const prompt = input.promptBuilder.buildPrompt(input.promptInput);
    return {
      prompt,
      diagnostics: createDiagnostics({
        mode: input.mode,
        attempted: true,
        triggered: false,
        budgetCharacters,
        baseline,
        prompt,
        compressionLatencyMs: Math.round(performance.now() - compressionStartedAt),
        protectedPreserved: false,
        epistemicMarkersPreserved: false,
        budgetCompliant: prompt.characterCount <= budgetCharacters,
        fallbackReason: "compression-error"
      })
    };
  }
}

function getCompressibleSections(
  sections: readonly PromptSection[]
): Record<(typeof COMPRESSED_SECTION_NAMES)[number], PromptSection> {
  const result = {} as Record<(typeof COMPRESSED_SECTION_NAMES)[number], PromptSection>;
  for (const name of COMPRESSED_SECTION_NAMES) {
    const section = sections.find((candidate) => candidate.name === name);
    if (!section) throw new Error(`PromptBuilder omitted required context section: ${name}`);
    result[name] = section;
  }
  return result;
}

function withoutPreformattedContext(input: PromptBuildInput): PromptBuildInput {
  const result = { ...input, maxCharacters: Number.MAX_SAFE_INTEGER };
  delete (result as { preformattedContext?: PreformattedPromptContext }).preformattedContext;
  return result;
}

function baselineContextToCompressionSections(
  sections: Record<(typeof COMPRESSED_SECTION_NAMES)[number], PromptSection>,
  recentIsPresent: boolean,
  nearTurnProtectionLines: number
): HierarchicalContextSection[] {
  return [
    {
      name: "DirectContext",
      content: sections.DirectContext.content,
      partition: recentIsPresent ? ("COMPRESSIBLE_RECENT" as const) : ("PROTECTED" as const),
      protectedTailLines: nearTurnProtectionLines
    },
    {
      name: "RecentEpisodicMemory",
      content: sections.RecentEpisodicMemory.content,
      partition: "COMPRESSIBLE_EPISODIC" as const
    },
    {
      name: "RelevantMemory",
      content: sections.RelevantMemory.content,
      partition: "COMPRESSIBLE_LONG_TERM" as const
    }
  ];
}

function toPreformattedContext(
  existing: PreformattedPromptContext | undefined,
  sections: ReturnType<typeof baselineContextToCompressionSections>
): PreformattedPromptContext {
  return {
    ...(existing ?? {}),
    DirectContext: sections[0]!.content,
    RecentEpisodicMemory: sections[1]!.content,
    RelevantMemory: sections[2]!.content
  };
}

function isPresentContext(content: string): boolean {
  return (
    Boolean(content.trim()) && !/^No recent episodic memory available\.$/u.test(content.trim())
  );
}

function preservesProtectedSections(
  baseline: readonly PromptSection[],
  candidate: readonly PromptSection[]
): boolean {
  if (
    baseline.map((section) => section.name).join("\u0000") !==
    candidate.map((section) => section.name).join("\u0000")
  ) {
    return false;
  }
  return [...PROTECTED_SECTION_NAMES].every((name) => {
    const original = baseline.find((section) => section.name === name);
    if (!original) return true;
    return candidate.find((section) => section.name === name)?.content === original.content;
  });
}

function createDiagnostics(input: {
  mode: RuntimeContextCompressionMode;
  attempted: boolean;
  triggered: boolean;
  budgetCharacters: number;
  baseline: PromptBuildOutput;
  prompt: PromptBuildOutput;
  compressionLatencyMs: number;
  compressedSectionNames?: string[] | undefined;
  partitionCounts?: ContextCompressionPartitionCounts | undefined;
  protectedPreserved: boolean;
  epistemicMarkersPreserved: boolean;
  budgetCompliant: boolean;
  fallbackReason?: string | undefined;
}): RuntimeContextCompressionDiagnostics {
  const savedTokens = Math.max(0, input.baseline.estimatedTokens - input.prompt.estimatedTokens);
  return {
    mode: input.mode,
    attempted: input.attempted,
    triggered: input.triggered,
    budgetCharacters: input.budgetCharacters,
    originalCharacters: input.baseline.characterCount,
    finalCharacters: input.prompt.characterCount,
    originalTokens: input.baseline.estimatedTokens,
    finalTokens: input.prompt.estimatedTokens,
    savedTokens,
    reductionPercent:
      input.baseline.characterCount === 0
        ? 0
        : Number(
            (
              ((input.baseline.characterCount - input.prompt.characterCount) /
                input.baseline.characterCount) *
              100
            ).toFixed(2)
          ),
    compressionLatencyMs: input.compressionLatencyMs,
    compressedSectionNames: input.compressedSectionNames ?? [],
    partitionCounts: input.partitionCounts
      ? { ...input.partitionCounts }
      : { ...EMPTY_PARTITION_COUNTS },
    protectedPreserved: input.protectedPreserved,
    epistemicMarkersPreserved: input.epistemicMarkersPreserved,
    budgetCompliant: input.budgetCompliant,
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {})
  };
}
