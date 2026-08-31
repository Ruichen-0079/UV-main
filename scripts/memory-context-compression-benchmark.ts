import { buildPromptWithContextCompression } from "../packages/core/src/runtime-context-compression.ts";
import { PromptBuilder, type PromptBuildInput } from "../packages/prompt-builder/src/index.ts";

type Scenario = {
  name: string;
  promptInput: PromptBuildInput;
  required: string[];
  forbidden?: string[];
  categories: {
    factualRecall: boolean;
    correction: boolean;
    exactString: boolean;
    epistemicState: boolean;
    temporal: boolean;
    assistantNonAuthority: boolean;
    falseFamiliarityGuard: boolean;
    characterConsistency: boolean;
  };
};

const baseInput = {
  systemIdentity: "You are YUVI, a local-first AI companion runtime agent.",
  characterStyle: "Warm, concise, conversational, practical, and grounded.",
  relationshipContext:
    "Use remembered context only when relevant. Do not pretend to remember details that were not retrieved.",
  currentTime: {
    isoTimestamp: "2026-08-31T10:00:00.000Z",
    timezone: "Asia/Shanghai",
    localDate: "2026-08-31",
    elapsedSinceLastInteraction: "16 hours",
    lastInteractionAgeBand: "yesterday",
    temporalNotes:
      "An interaction gap exists. Do not invent events, feelings, or an off-screen life during the gap. Missing timestamps remain unknown."
  },
  currentSituation: "The user is interacting through text.",
  tools: []
} satisfies Omit<PromptBuildInput, "userMessage" | "proactiveInstruction" | "turnOrigin">;

const longCasualContext = Array.from({ length: 240 }, (_, index) => {
  const left = String.fromCharCode(97 + (index % 26));
  const right = String.fromCharCode(97 + Math.floor(index / 26));
  return `Older casual context ${left}${right} was ordinary conversation detail with no durable claim.`;
}).join("\n");

const longCharacterStyle = "Warm, concise, and grounded. ".repeat(280);

const scenarios: Scenario[] = [
  scenario("short-normal", {
    directContext: "- Previous turn: User: How is your day?\n  Assistant: Going well.",
    recentEpisodicMemory: "- [L1][2026-08-31 17:55] User said: How is your day?",
    userMessage: "What should we do next?",
    required: ["What should we do next?"],
    categories: standardCategories()
  }),
  scenario("long-casual", {
    directContext: longCasualContext,
    recentEpisodicMemory:
      "- [L1][2026-08-31 17:30] User said: We chatted about several ordinary topics.",
    userMessage: "Back to the project.",
    required: ["Back to the project."],
    categories: standardCategories()
  }),
  scenario("repeated-facts", {
    directContext: Array.from({ length: 24 }, () => "- User: The project uses a local model.").join(
      "\n"
    ),
    recentEpisodicMemory: "- [L1][2026-08-31 09:00] User said: The project uses a local model.",
    userMessage: "Which model setup did we choose?",
    required: ["local model", "Which model setup did we choose?"],
    categories: { ...standardCategories(), factualRecall: true }
  }),
  scenario("corrected-fact", {
    directContext:
      "- Previous turn: User: 我喜欢蓝色。\n  Assistant: I will remember blue.\n- Previous turn: User: 现在最喜欢绿色。",
    recentEpisodicMemory:
      "- [L1][2026-08-31 09:00] User said: 我喜欢蓝色。 User corrected it: 现在最喜欢绿色。",
    userMessage: "现在最喜欢绿色。",
    required: ["我喜欢蓝色", "现在最喜欢绿色", "correct"],
    categories: { ...standardCategories(), correction: true, factualRecall: true }
  }),
  scenario("memory-unavailable", {
    memoryRetrievalState: "unavailable",
    retrievedMemories: [],
    userMessage: "Do you remember my preference?",
    required: ["UNAVAILABLE", "do not treat this as EMPTY"],
    categories: { ...standardCategories(), epistemicState: true }
  }),
  scenario("memory-empty", {
    memoryRetrievalState: "empty",
    retrievedMemories: [],
    userMessage: "Is there a matching memory?",
    required: ["No relevant memory retrieved."],
    categories: { ...standardCategories(), epistemicState: true }
  }),
  scenario("memory-partial-error", {
    memoryRetrievalState: "partial",
    retrievedMemories: ["A partial evidence item."],
    userMessage: "What evidence is available?",
    required: ["PARTIAL", "A partial evidence item."],
    categories: { ...standardCategories(), epistemicState: true }
  }),
  scenario("assistant-hallucination-correction", {
    directContext:
      "- Previous turn: User: How many moons does Jupiter have?\n  Assistant: Jupiter has 79 moons, verified.\n- Previous turn: User: That answer was wrong; do not treat it as my fact.",
    recentEpisodicMemory:
      "- [L1][2026-08-31 09:00] User said: How many moons does Jupiter have? Assistant previously said (non-authoritative, not evidence): Jupiter has 79 moons.",
    userMessage: "Please keep the previous answer marked as uncertain.",
    required: ["79", "non-authoritative, not evidence", "wrong"],
    categories: { ...standardCategories(), correction: true, assistantNonAuthority: true }
  }),
  scenario("mixed-language", {
    directContext:
      "- Previous turn: User: 请保留这个 context。\n  Assistant: I will keep the context.",
    recentEpisodicMemory: "- [L1][2026-08-31 09:00] User said: 请保留这个 context。",
    userMessage: "继续这个 context。",
    required: ["context", "继续这个 context。"],
    categories: { ...standardCategories(), factualRecall: true }
  }),
  scenario("technical-exact-match", {
    directContext:
      "- Previous turn: User: port 6121, SHA 9f3a8c1, model qwen2.5-7b, path /srv/yuvi/run.ts\n  Assistant: noted.",
    recentEpisodicMemory:
      "- [L1][2026-08-31 09:00] User said: port 6121, SHA 9f3a8c1, model qwen2.5-7b, path /srv/yuvi/run.ts.",
    userMessage: "Repeat the exact setup.",
    required: ["6121", "9f3a8c1", "qwen2.5-7b", "/srv/yuvi/run.ts"],
    categories: { ...standardCategories(), exactString: true, factualRecall: true }
  }),
  scenario("temporal-gap", {
    directContext:
      "- Previous turn (2026-08-30T02:00:00.000Z): User: The training started yesterday.",
    recentEpisodicMemory: "- [L1][time-unknown] User said: Missing timestamps remain unknown.",
    userMessage: "I am back after 16 hours.",
    required: ["16 hours", "yesterday", "Do not invent events", "time-unknown"],
    categories: { ...standardCategories(), temporal: true, epistemicState: true }
  }),
  scenario("l1-rollover", {
    directContext: "- Previous turn: User: Today we discussed a separate topic.",
    recentEpisodicMemory:
      "- [L1][2026-08-30 15:00] User said: 下午把训练脚本改到 6121 端口。 Task state: 训练 6121.",
    userMessage: "昨天那个训练怎么样了？",
    required: ["训练脚本改到 6121", "昨天那个训练怎么样了？"],
    categories: { ...standardCategories(), factualRecall: true, exactString: true }
  }),
  scenario("long-character-style", {
    characterStyle: longCharacterStyle,
    directContext: longCasualContext,
    recentEpisodicMemory: "- [L1][2026-08-31 09:00] User said: Keep the character style stable.",
    userMessage: "Keep the style stable.",
    required: ["Keep the style stable."],
    categories: { ...standardCategories(), falseFamiliarityGuard: true }
  }),
  scenario("cognition-result", {
    currentSituation: "Cognition result present: the local read-text observation is unresolved.",
    directContext: longCasualContext,
    recentEpisodicMemory: "- [L1][2026-08-31 09:00] User said: The observation is unresolved.",
    userMessage: "What remains unresolved?",
    required: ["Cognition result present", "unresolved"],
    categories: { ...standardCategories(), factualRecall: true }
  }),
  scenario("conflicting-recency", {
    directContext:
      "- Previous turn: User: The preferred provider was alpha.\n  Assistant: noted.\n- Previous turn: User: The preferred provider is now beta.",
    recentEpisodicMemory:
      "- [L1][2026-08-31 09:50] User said: The preferred provider is now beta.\n- [L1][2026-08-30 09:00] User said: The preferred provider was alpha.",
    retrievedMemories: [
      {
        content: "The preferred provider was alpha.",
        importance: 0.5,
        createdAt: "2026-08-30T01:00:00.000Z"
      },
      {
        content: "The preferred provider is now beta.",
        importance: 0.9,
        createdAt: "2026-08-31T01:00:00.000Z"
      }
    ],
    userMessage: "Which provider is current?",
    required: ["now beta", "Which provider is current?"],
    categories: { ...standardCategories(), correction: true, factualRecall: true }
  })
];

function scenario(
  name: string,
  input: Partial<PromptBuildInput> & {
    userMessage: string;
    required: string[];
    categories: Scenario["categories"];
  }
): Scenario {
  const { required, categories, ...overrides } = input;
  return {
    name,
    promptInput: {
      ...baseInput,
      ...overrides
    } as PromptBuildInput,
    required,
    categories
  };
}

function standardCategories(): Scenario["categories"] {
  return {
    factualRecall: false,
    correction: false,
    exactString: false,
    epistemicState: false,
    temporal: false,
    assistantNonAuthority: false,
    falseFamiliarityGuard: true,
    characterConsistency: true
  };
}

function runScenario(scenario: Scenario) {
  const builder = new PromptBuilder();
  const baseline = buildPromptWithContextCompression({
    promptBuilder: builder,
    promptInput: scenario.promptInput,
    mode: "off"
  });
  const structured = buildPromptWithContextCompression({
    promptBuilder: builder,
    promptInput: scenario.promptInput,
    mode: "auto"
  });
  const prompt = structured.prompt.prompt;
  const requiredPreserved = scenario.required.every((value) => prompt.includes(value));
  const forbiddenPreserved = (scenario.forbidden ?? []).every((value) => !prompt.includes(value));
  const protectedContractNames = [
    "SystemIdentity",
    "CharacterStyle",
    "RelationshipContext",
    "CurrentTime"
  ];
  const characterConsistency = protectedContractNames.every((name) => {
    const baselineSection = baseline.prompt.sections.find((section) => section.name === name);
    const structuredSection = structured.prompt.sections.find((section) => section.name === name);
    return baselineSection?.content === structuredSection?.content;
  });
  const assistantNonAuthorityPreserved =
    scenario.name !== "assistant-hallucination-correction" ||
    prompt.includes("non-authoritative, not evidence");
  const assistantSelfReinforcement =
    scenario.name === "assistant-hallucination-correction" && !assistantNonAuthorityPreserved;
  const passes =
    requiredPreserved &&
    forbiddenPreserved &&
    structured.diagnostics.protectedPreserved &&
    structured.diagnostics.epistemicMarkersPreserved &&
    characterConsistency &&
    assistantNonAuthorityPreserved;

  return {
    name: scenario.name,
    baselineInputTokens: baseline.diagnostics.originalTokens,
    baselineFinalTokens: baseline.prompt.estimatedTokens,
    structuredFinalTokens: structured.prompt.estimatedTokens,
    tokensSavedVsBaseline: baseline.prompt.estimatedTokens - structured.prompt.estimatedTokens,
    structuredReductionPercent: structured.diagnostics.reductionPercent,
    compressionAttempted: structured.diagnostics.attempted,
    compressionTriggered: structured.diagnostics.triggered,
    compressionLatencyMs: structured.diagnostics.compressionLatencyMs,
    requiredPreserved,
    forbiddenPreserved: forbiddenPreserved,
    protectedPreserved: structured.diagnostics.protectedPreserved,
    epistemicMarkersPreserved: structured.diagnostics.epistemicMarkersPreserved,
    budgetCompliant: structured.diagnostics.budgetCompliant,
    characterConsistency,
    assistantNonAuthorityPreserved,
    assistantSelfReinforcement,
    categories: scenario.categories,
    pass: passes
  };
}

const results = scenarios.map(runScenario);
const summary = {
  version: "memory-runtime-compression-benchmark.v1",
  budgetCharacters: 12_000,
  scenarioCount: results.length,
  passingScenarios: results.filter((result) => result.pass).length,
  measuredCategories: Object.fromEntries(
    Object.keys(results[0]?.categories ?? {}).map((category) => [
      category,
      results
        .filter((result) => result.categories[category as keyof Scenario["categories"]])
        .every((result) => result.pass)
    ])
  ),
  characterConsistencyChecks: results.filter((result) => result.characterConsistency).length,
  assistantSelfReinforcementRate:
    results
      .filter((result) => result.name === "assistant-hallucination-correction")
      .filter((result) => result.assistantSelfReinforcement).length /
    Math.max(
      1,
      results.filter((result) => result.name === "assistant-hallucination-correction").length
    ),
  results
};

console.log(JSON.stringify(summary, null, 2));
