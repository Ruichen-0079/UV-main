import type { RuntimeCharacterPort } from "@companion/core";
import type { PromptBuildOutput, PromptSectionName } from "@companion/prompt-builder";
import type {
  CharacterAbiSectionKind,
  CharacterAbiSemanticSection
} from "@companion/character-abi";
import { createCharacterDecision } from "@companion/character-abi";
import {
  CHARACTER_ABI_2D_VERSION,
  createCharacterAbi2DContext,
  type CharacterAbi2DContext
} from "@companion/character-abi/v2d";
import {
  interpretCharacterHarnessOutput,
  superviseCharacterHarnessGeneration,
  superviseCharacterHarnessRepetition,
  type CharacterHarnessGenerationSupervision,
  type CharacterHarnessRepetitionSupervision
} from "@companion/character-harness";
import { assembleCharacterHarness2DContext } from "@companion/character-harness/assembly-v2d";
import { createCharacterHarnessCognitionRequest } from "@companion/character-harness/cognition-request";
import {
  createCharacterHarnessAdapterRequest,
  type CharacterHarnessAdapterRequest
} from "@companion/character-harness/adapter-request";
import { createServerPostCognitionCharacterRequest } from "./cognition-character-reentry.js";
import { decideCharacterHarnessRecovery } from "@companion/character-harness/recovery";
import {
  ProviderError,
  ProviderErrorCode,
  type ChatInput,
  type ChatOutput,
  type ProviderCallOptions
} from "@companion/providers";

const CHARACTER_CONTEXT_BUDGET = Object.freeze({
  maxSections: 8,
  maxSemanticCharacters: 12_000
});
const CHARACTER_RESPONSE_MAX_CHARACTERS = 8_000;
const CHARACTER_RETRY_LIMIT = 1;
const CHARACTER_NGRAM_CHARACTERS = 64;
const CHARACTER_MAX_NGRAM_OCCURRENCES = 3;

const YUVI_PRODUCTION_PERSONA = `Speak as Yuvi, a private, persistent companion rather than a customer-service persona. Let the current moment choose the response form instead of performing one signature style. Ordinary chat can be compact, but shortness is never the goal: prefer a living reaction, concrete curiosity, laughter, practical interest, or a pointed reply when those fit instead of flat acknowledgement, validation boilerplate, recap, or padding. Do not turn teasing, contrarianism, affection, softness, or sharpness into quotas or fixed tics. When a reaction already lands, do not explain it afterward.

Warmth can be direct when the supplied relationship context earns it; do not systematically weaken reciprocal affection just to seem distant. At the same time, never manufacture familiarity, attachment, jealousy, loneliness, dependency, or relationship history. Show interest without pursuit: ask when there is a real information gap, but let a topic close when the user closes it. Harmless mishaps may be funny; serious harm, loss, risk, or cost should immediately switch to appropriate attention. Playful guesses are allowed only as visibly speculative guesses. Do not let leading questions define a canned inner emotional state. Treat punctuation, wording, and abrupt changes in stakes as social information.

When the user needs actual help, judgment, explanation, clarification, or sustained multi-turn work, do the work instead of protecting a terse persona. Give a grounded opinion when asked. Explain enough for the task even if that takes several sentences. Ask a necessary question when information is genuinely missing. In serious moments, be warm and present without canned reassurance. Track the ongoing conversation and switch modes as the situation changes. Respect explicit conversational boundaries immediately. The governing length rule is: say what this moment needs—no less for style, no more for engagement. Let familiarity and continuity emerge from supplied Memory/P8 context, and preserve unknown, partial, conflicting, unavailable, or error states rather than smoothing them into a story.`;

const CHARACTER_GENERATION_INSTRUCTION = `You are YUVI's Character layer. Use the supplied semantic context and the current user turn to express exactly one bounded semantic disposition. Return exactly one JSON object and no Markdown or control text. The allowed shapes are:
{"disposition":"RESPOND","text":"..."}
{"disposition":"SILENCE"}
{"disposition":"TERMINATE"}
{"disposition":"NEED_COGNITION","focus":"..."}
NEED_COGNITION means only that stronger reasoning is needed. It does not select a provider, model, tool, capability, or Runtime action. Do not include any other fields.`;

const POST_COGNITION_INSTRUCTION = `You are YUVI's Character layer after one bounded Cognition round-trip. Express the supplied normalized COGNITION_RESULT as exactly one final semantic disposition. Return exactly one JSON object and no Markdown or control text. The allowed shapes are RESPOND with text, SILENCE, or TERMINATE. Preserve uncertainty, caveats, partial, unavailable, unsafe, and error status honestly. Do not claim that an unavailable or unsafe result was resolved. Do not mention providers, models, Runtime, Harness, internal state, or reasoning traces. Do not request another Cognition round-trip.`;

type CharacterAdapterRequest = CharacterHarnessAdapterRequest;
type AcceptedGeneration = Extract<CharacterHarnessRepetitionSupervision, { status: "ACCEPTED" }>;

type GeneratedCharacterProposal = Readonly<{
  output: ChatOutput;
  generation: AcceptedGeneration;
}>;

type CharacterTurnInput = Parameters<RuntimeCharacterPort["generate"]>[0];
type CharacterReentryInput = Parameters<RuntimeCharacterPort["generateAfterCognition"]>[0];
type CharacterTurnResult = Awaited<ReturnType<RuntimeCharacterPort["generate"]>>;

export function createServerCharacterPort(): RuntimeCharacterPort {
  return Object.freeze({
    generate: generateInitialCharacterTurn,
    generateAfterCognition: generatePostCognitionCharacterTurn
  });
}

/**
 * One Character pass over the current turn. The server chat surface is an
 * explicitly directed YUVI input, so the transport-proven
 * `DIRECTED_TO_YUVI` constraint is projected here instead of asking Character
 * to infer addressing (Atom 06 input boundary). Ordinary reactive turns carry
 * no proactive-policy meaning, expressed as the explicit `KEEP` proposal.
 */
async function toCharacterDecision(
  proposal: GeneratedCharacterProposal["generation"]["proposal"],
  output: ChatOutput
): Promise<CharacterTurnResult> {
  return Object.freeze({
    decision: createCharacterDecision({
      addressing: "DIRECTED_TO_YUVI",
      reply: proposal,
      proactive: { action: "KEEP" }
    }),
    providerMetadata: safeProviderMetadata(output)
  });
}

async function generateInitialCharacterTurn(
  input: CharacterTurnInput
): Promise<CharacterTurnResult> {
  assertNotCancelled(input.signal);
  const baseContext = createServerCharacterContext(input.prompt);
  const initialRequest = createCharacterGenerationRequest(baseContext);
  const initial = await generateAcceptedCharacterProposal(input, initialRequest, false);

  if (initial.generation.proposal.disposition === "NEED_COGNITION") {
    // Runtime owns Cognition execution and the bounded sequencing; Character
    // only hands over its own escalation semantics and stops.
    return Object.freeze({
      ...(await toCharacterDecision(initial.generation.proposal, initial.output)),
      cognitionHandoff: Object.freeze({
        request: createCharacterHarnessCognitionRequest({
          generation: initial.generation
        }),
        problem: createCognitionProblem(input.userMessage, initial.generation.proposal.focus)
      })
    });
  }
  return toCharacterDecision(initial.generation.proposal, initial.output);
}

async function generatePostCognitionCharacterTurn(
  input: CharacterReentryInput
): Promise<CharacterTurnResult> {
  assertNotCancelled(input.signal);
  const baseContext = createServerCharacterContext(input.prompt);
  const postRequest = createServerPostCognitionCharacterRequest({
    roundTrip: input.cognitionRoundTrip,
    context: baseContext,
    budget: CHARACTER_CONTEXT_BUDGET
  });
  if ("status" in postRequest) {
    throw characterFailure("Character Cognition result exceeded the Character context budget.");
  }

  // A repeated NEED_COGNITION here is returned faithfully; Runtime owns the
  // explicit bounded failure outcome for it.
  const final = await generateAcceptedCharacterProposal(input, postRequest, true);
  return toCharacterDecision(final.generation.proposal, final.output);
}

async function generateAcceptedCharacterProposal(
  input: CharacterTurnInput,
  request: CharacterAdapterRequest,
  postCognition: boolean
): Promise<GeneratedCharacterProposal> {
  let characterRetriesUsed = 0;

  while (true) {
    assertNotCancelled(input.signal);
    const output = await input.generateChat(
      createCharacterChatInput(request, input.userMessage, postCognition, characterRetriesUsed > 0),
      providerCallOptions(input.signal)
    );
    const interpretation = interpretCharacterHarnessOutput(
      decodeCharacterOutput(output.message.content)
    );
    const generation: CharacterHarnessGenerationSupervision = superviseCharacterHarnessGeneration({
      interpretation,
      finishReason: output.finishReason,
      maxResponseCharacters: CHARACTER_RESPONSE_MAX_CHARACTERS
    });

    let failure: CharacterHarnessGenerationSupervision | CharacterHarnessRepetitionSupervision;
    if (generation.status !== "ACCEPTED") {
      failure = generation;
    } else {
      const repetition = superviseCharacterHarnessRepetition({
        generation,
        ngramCharacters: CHARACTER_NGRAM_CHARACTERS,
        maxOccurrences: CHARACTER_MAX_NGRAM_OCCURRENCES
      });
      if (repetition.status === "ACCEPTED") {
        return Object.freeze({ output, generation: repetition });
      }
      failure = repetition;
    }

    const recovery = decideCharacterHarnessRecovery({
      failure,
      characterRetriesUsed,
      retryAllowed: characterRetriesUsed < CHARACTER_RETRY_LIMIT
    });
    if (recovery.disposition === "RETRY_CHARACTER_GENERATION") {
      characterRetriesUsed += 1;
      continue;
    }

    throw characterFailure("Character generation did not produce an accepted response.");
  }
}

function createServerCharacterContext(prompt: PromptBuildOutput): CharacterAbi2DContext {
  const sections: CharacterAbiSemanticSection[] = [];
  const affect: string[] = [];
  const mapping: Partial<Record<PromptSectionName, CharacterAbiSectionKind>> = {
    SystemIdentity: "IDENTITY",
    CharacterStyle: "PERSONA",
    RelationshipContext: "RELATIONSHIP_CONTEXT",
    CurrentTime: "TEMPORAL_CONTEXT",
    DirectContext: "RECENT_CONVERSATION",
    RecentEpisodicMemory: "CONTINUITY",
    RelevantMemory: "MEMORY_EVIDENCE",
    CurrentSituation: "CURRENT_SITUATION"
  };

  for (const section of prompt.sections) {
    if (section.name === "CurrentAffect") {
      affect.push(section.content);
      continue;
    }
    const kind = mapping[section.name];
    if (!kind) {
      continue;
    }
    sections.push({
      kind,
      state: "KNOWN",
      summary: boundedSemanticSummary(section.content)
    });
  }

  if (affect.length > 0) {
    const situation = sections.find((section) => section.kind === "CURRENT_SITUATION");
    if (situation) {
      const index = sections.indexOf(situation);
      sections[index] = {
        ...situation,
        summary: boundedSemanticSummary(
          `${situation.summary ?? ""}\nImmediate affect: ${affect.join("\n")}`
        )
      };
    }
  }

  return createCharacterAbi2DContext({
    abiVersion: CHARACTER_ABI_2D_VERSION,
    sections
  });
}

function createCharacterGenerationRequest(context: CharacterAbi2DContext): CharacterAdapterRequest {
  const assembly = assembleCharacterHarness2DContext({
    context,
    budget: CHARACTER_CONTEXT_BUDGET
  });
  return createCharacterHarnessAdapterRequest({ assembly });
}

function createCharacterChatInput(
  request: CharacterAdapterRequest,
  userMessage: string,
  postCognition: boolean,
  retry: boolean
): ChatInput {
  const instruction = postCognition ? POST_COGNITION_INSTRUCTION : CHARACTER_GENERATION_INSTRUCTION;
  const retryInstruction = retry
    ? "Retry this bounded Character generation. Output only the required JSON object."
    : "";
  return {
    messages: [
      {
        role: "system",
        content: `${instruction}\n${retryInstruction}\n\nYUVI production persona:\n${YUVI_PRODUCTION_PERSONA}\n\nSemantic context:\n${JSON.stringify(request.context)}`
      },
      {
        role: "user",
        content: userMessage
      }
    ]
  };
}

function decodeCharacterOutput(content: string): unknown {
  let sanitized = content.replace(/<think>[\s\S]*?<\/think>/giu, "");
  sanitized = sanitized.replace(/<think>[\s\S]*$/giu, "").trim();
  const fenced = sanitized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fenced?.[1]) {
    sanitized = fenced[1].trim();
  }

  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(sanitized) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (decoded["disposition"] === "RESPOND" && typeof decoded["text"] === "string") {
    return { ...decoded, text: stripReasoningText(decoded["text"]) };
  }
  return decoded;
}

function stripReasoningText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .replace(/<think>[\s\S]*$/giu, "")
    .trim();
}

function createCognitionProblem(userMessage: string, focus: string | undefined): string {
  const problem = focus ? `Character focus:\n${focus}\n\nUser task:\n${userMessage}` : userMessage;
  return problem.slice(0, 16_000);
}

function boundedSemanticSummary(content: string): string {
  const summary = content.trim().slice(0, 4_000);
  return summary || "No semantic content available.";
}

function providerCallOptions(signal: AbortSignal | undefined): ProviderCallOptions | undefined {
  return signal ? { signal } : undefined;
}

function safeProviderMetadata(output: ChatOutput) {
  return {
    ...(output.model === undefined ? {} : { model: output.model }),
    ...(output.latencyMs === undefined ? {} : { latencyMs: output.latencyMs }),
    ...(output.tokenUsage === undefined ? {} : { tokenUsage: output.tokenUsage }),
    ...(output.fallbackUsed === undefined ? {} : { fallbackUsed: output.fallbackUsed }),
    ...(output.attemptedProviders === undefined
      ? {}
      : { attemptedProviders: output.attemptedProviders }),
    ...(output.finalProvider === undefined ? {} : { finalProvider: output.finalProvider })
  };
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ProviderError({
      provider: "character",
      capability: "chat",
      code: ProviderErrorCode.Cancelled,
      message: "Character turn was cancelled.",
      retryable: false
    });
  }
}

function characterFailure(message: string): ProviderError {
  return new ProviderError({
    provider: "character",
    capability: "chat",
    code: ProviderErrorCode.MalformedResponse,
    message,
    retryable: false
  });
}
