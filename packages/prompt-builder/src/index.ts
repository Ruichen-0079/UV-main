export type PromptSectionName =
  | "SystemIdentity"
  | "CharacterStyle"
  | "RelationshipContext"
  | "RelevantMemory"
  | "CurrentSituation"
  | "Tools"
  | "UserMessage";

export type PromptSection = {
  name: PromptSectionName;
  content: string;
  priority: number;
  stable: boolean;
};

export type RetrievedMemoryForPrompt = {
  content: string;
  summary?: string | null;
  displayText?: string;
  importance?: number;
  createdAt?: Date | string;
  lastAccessedAt?: Date | string;
  tags?: string[];
};

export type ToolContext = {
  name: string;
  description?: string;
  available?: boolean;
};

export type PromptBuildInput = {
  systemIdentity: string;
  characterStyle?: string;
  relationshipContext?: string;
  retrievedMemories?: Array<string | RetrievedMemoryForPrompt>;
  memoryEnabled?: boolean;
  currentSituation?: string;
  tools?: ToolContext[];
  userMessage: string;
  maxCharacters?: number;
};

export type ProviderNeutralChatMessage = {
  role: "system" | "user";
  content: string;
};

export type PromptBuildOutput = {
  sections: PromptSection[];
  messages: ProviderNeutralChatMessage[];
  prompt: string;
  characterCount: number;
  estimatedTokens: number;
  truncated: boolean;
};

export type PromptInput = {
  companionName: string;
  userMessage: string;
  memories: string[];
};

export type BuiltPrompt = {
  system: string;
  user: string;
};

const defaultMaxCharacters = 12000;

export class PromptBuilder {
  buildPrompt(input: PromptBuildInput): PromptBuildOutput {
    const maxCharacters = input.maxCharacters ?? defaultMaxCharacters;
    const sections = this.createSections(input);
    const budgetedSections = this.enforceBudget(sections, maxCharacters);
    const prompt = budgetedSections.map(formatSection).join("\n\n");
    const systemPrompt = budgetedSections
      .filter((section) => section.name !== "UserMessage")
      .map(formatSection)
      .join("\n\n");

    return {
      sections: budgetedSections,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: formatSection({
            name: "UserMessage",
            content: input.userMessage,
            priority: 100,
            stable: false
          })
        }
      ],
      prompt,
      characterCount: prompt.length,
      estimatedTokens: estimateTokens(prompt),
      truncated: sectionsToText(sections).length > prompt.length
    };
  }

  build(input: PromptInput): BuiltPrompt {
    const output = this.buildPrompt({
      systemIdentity: `You are ${input.companionName}, a local-first AI companion runtime agent.`,
      characterStyle: "Respond warmly, clearly, and concisely.",
      relationshipContext: "Use remembered context only when it is relevant and helpful.",
      retrievedMemories: input.memories,
      currentSituation: "The user is actively interacting with the companion runtime.",
      tools: [],
      userMessage: input.userMessage
    });

    return {
      system: output.prompt,
      user: input.userMessage
    };
  }

  private createSections(input: PromptBuildInput): PromptSection[] {
    return [
      {
        name: "SystemIdentity",
        content: input.systemIdentity,
        priority: 100,
        stable: true
      },
      {
        name: "CharacterStyle",
        content: input.characterStyle ?? "Be helpful, grounded, and emotionally aware.",
        priority: 90,
        stable: true
      },
      {
        name: "RelationshipContext",
        content: input.relationshipContext ?? "No specific relationship context is available.",
        priority: 80,
        stable: false
      },
      {
        name: "RelevantMemory",
        content: this.compressMemoryNarrative(
          input.retrievedMemories ?? [],
          input.memoryEnabled ?? true
        ),
        priority: 70,
        stable: false
      },
      {
        name: "CurrentSituation",
        content: input.currentSituation ?? "No additional situation context is available.",
        priority: 60,
        stable: false
      },
      {
        name: "Tools",
        content: formatTools(input.tools ?? []),
        priority: 50,
        stable: false
      },
      {
        name: "UserMessage",
        content: input.userMessage,
        priority: 100,
        stable: false
      }
    ];
  }

  private compressMemoryNarrative(
    memories: Array<string | RetrievedMemoryForPrompt>,
    memoryEnabled: boolean
  ): string {
    if (!memoryEnabled) {
      return "Memory was disabled for this turn.";
    }

    if (memories.length === 0) {
      return "No relevant memory retrieved.";
    }

    const ranked = dedupePromptMemories(
      memories.map(normalizeMemory).sort(compareMemoryForPrompt)
    ).slice(0, 5);

    return ranked
      .map((memory) => `- ${compressMemoryText(displayTextForMemory(memory))}`)
      .join("\n");
  }

  private enforceBudget(sections: PromptSection[], maxCharacters: number): PromptSection[] {
    const result = sections.map((section) => ({ ...section }));

    while (sectionsToText(result).length > maxCharacters) {
      const candidate = [...result]
        .filter((section) => !section.stable && section.content.length > 120)
        .sort((left, right) => left.priority - right.priority)[0];

      if (!candidate) {
        break;
      }

      candidate.content = truncateText(
        candidate.content,
        Math.max(120, Math.floor(candidate.content.length * 0.75))
      );
    }

    return result;
  }
}

function formatSection(section: PromptSection): string {
  return `<${section.name}>\n${section.content.trim()}\n</${section.name}>`;
}

function sectionsToText(sections: PromptSection[]): string {
  return sections.map(formatSection).join("\n\n");
}

function normalizeMemory(
  memory: string | RetrievedMemoryForPrompt
): Required<Pick<RetrievedMemoryForPrompt, "content">> & RetrievedMemoryForPrompt {
  if (typeof memory === "string") {
    return {
      content: memory,
      summary: null,
      importance: 0.5
    };
  }

  return memory;
}

function compareMemoryForPrompt(
  left: RetrievedMemoryForPrompt,
  right: RetrievedMemoryForPrompt
): number {
  const importanceDelta = (right.importance ?? 0.5) - (left.importance ?? 0.5);
  if (importanceDelta !== 0) {
    return importanceDelta;
  }

  return (
    toTime(right.lastAccessedAt ?? right.createdAt) - toTime(left.lastAccessedAt ?? left.createdAt)
  );
}

function compressMemoryText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const withoutTranscriptMarkers = compact
    .replace(/User intent:\s*/gi, "")
    .replace(/^User said:\s*/i, "User expressed: ")
    .replace(/^Assistant replied:\s*/i, "Assistant response summary: ");

  const withoutAssistantSummary = withoutTranscriptMarkers.replace(
    /Assistant response summary:\s*.*$/gis,
    ""
  );

  return truncateText(stripLeadingListMarkers(withoutAssistantSummary.trim()), 220);
}

function stripLeadingListMarkers(text: string): string {
  let result = text.trim();
  let previous = "";

  while (result && result !== previous) {
    previous = result;
    result = result
      .replace(/^>\s*/, "")
      .replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/u, "")
      .trimStart();
  }

  return result;
}

function displayTextForMemory(memory: RetrievedMemoryForPrompt): string {
  return memory.displayText ?? memory.summary ?? memory.content;
}

function dedupePromptMemories(memories: RetrievedMemoryForPrompt[]): RetrievedMemoryForPrompt[] {
  const result: RetrievedMemoryForPrompt[] = [];
  for (const memory of memories) {
    const text = normalizeForPromptDedupe(displayTextForMemory(memory));
    const duplicate = result.some((kept) => {
      const keptText = normalizeForPromptDedupe(displayTextForMemory(kept));
      return (
        text === keptText ||
        (text.length >= 24 && keptText.includes(text)) ||
        (keptText.length >= 24 && text.includes(keptText))
      );
    });
    if (!duplicate) {
      result.push(memory);
    }
  }
  return result;
}

function normalizeForPromptDedupe(text: string): string {
  return text.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function formatTools(tools: ToolContext[]): string {
  if (tools.length === 0) {
    return "No tools are currently available.";
  }

  return tools
    .map((tool) => {
      const status = tool.available === false ? "unavailable" : "available";
      return `- ${tool.name} (${status})${tool.description ? `: ${tool.description}` : ""}`;
    })
    .join("\n");
}

function truncateText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toTime(value: Date | string | undefined): number {
  if (!value) {
    return 0;
  }

  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
