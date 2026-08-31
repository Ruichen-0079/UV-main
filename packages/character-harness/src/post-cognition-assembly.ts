import {
  CHARACTER_ABI_SECTION_KINDS,
  type CharacterAbiSectionKind
} from "@companion/character-abi";
import {
  CHARACTER_ABI_2D_VERSION,
  createCharacterAbi2DContext,
  type CharacterAbi2DCognitionResultSection,
  type CharacterAbi2DContext
} from "@companion/character-abi/v2d";
import type { CharacterHarnessAssemblyBudget } from "./index.js";
import { assembleCharacterHarness2DContext } from "./assembly-v2d.js";
import {
  CHARACTER_HARNESS_5I_VERSION,
  type CharacterHarnessCognitionSectionProjection
} from "./cognition-section.js";

export const CHARACTER_HARNESS_5K_VERSION = "character-harness-5k.v1" as const;

export type CharacterHarnessPostCognitionAssembly = Readonly<
  | {
      version: typeof CHARACTER_HARNESS_5K_VERSION;
      status: "ACCEPTED";
      context: CharacterAbi2DContext;
      omittedSectionKinds: readonly CharacterAbiSectionKind[];
      usedSemanticCharacters: number;
    }
  | {
      version: typeof CHARACTER_HARNESS_5K_VERSION;
      status: "COGNITION_RESULT_OVER_BUDGET";
      reason: "MANDATORY_COGNITION_RESULT_EXCEEDS_BUDGET";
      requiredSections: 1;
      availableSections: number;
      requiredSemanticCharacters: number;
      availableSemanticCharacters: number;
    }
>;

type UnknownObject = Record<string, unknown> & {
  context?: unknown;
  cognitionProjection?: unknown;
  section?: unknown;
  version?: unknown;
  budget?: unknown;
  maxSections?: unknown;
  maxSemanticCharacters?: unknown;
};

/**
 * Assemble the post-cognition Character context while treating the already
 * validated 5I Cognition Result projection as mandatory continuation payload.
 *
 * One section slot and the exact semantic-string character cost of the
 * COGNITION_RESULT are reserved first. Ordinary sections then consume only the
 * remaining budget using the existing 5J prefix-only policy. The Cognition
 * Result is appended last without truncation, rewriting, ranking, or
 * reinterpretation. Runtime/model invocation remains outside this seam.
 */
export function assembleCharacterHarnessPostCognitionContext(
  input: unknown
): CharacterHarnessPostCognitionAssembly {
  const value = expectObject(input, "Character Harness post-cognition assembly input");
  assertAllowedKeys(
    value,
    ["context", "cognitionProjection", "budget"],
    "Character Harness post-cognition assembly input"
  );

  const context = createCharacterAbi2DContext(value.context);
  if (context.sections.some((section) => section.kind === "COGNITION_RESULT")) {
    throw new Error(
      "Character Harness post-cognition base context must not already contain COGNITION_RESULT."
    );
  }

  const cognitionProjection = normalizeCognitionProjection(value.cognitionProjection);
  const cognitionSection = cognitionProjection.section;
  const budget = normalizeBudget(value.budget);
  const cognitionCharacters = measureCognitionSemanticCharacters(cognitionSection);

  if (budget.maxSections < 1 || cognitionCharacters > budget.maxSemanticCharacters) {
    return Object.freeze({
      version: CHARACTER_HARNESS_5K_VERSION,
      status: "COGNITION_RESULT_OVER_BUDGET",
      reason: "MANDATORY_COGNITION_RESULT_EXCEEDS_BUDGET",
      requiredSections: 1,
      availableSections: budget.maxSections,
      requiredSemanticCharacters: cognitionCharacters,
      availableSemanticCharacters: budget.maxSemanticCharacters
    });
  }

  const regularAssembly = assembleCharacterHarness2DContext({
    context,
    budget: {
      maxSections: budget.maxSections - 1,
      maxSemanticCharacters: budget.maxSemanticCharacters - cognitionCharacters
    }
  });

  const finalContext = createCharacterAbi2DContext({
    abiVersion: CHARACTER_ABI_2D_VERSION,
    sections: [...regularAssembly.context.sections, cognitionSection]
  });

  return Object.freeze({
    version: CHARACTER_HARNESS_5K_VERSION,
    status: "ACCEPTED",
    context: finalContext,
    omittedSectionKinds: regularAssembly.omittedSectionKinds,
    usedSemanticCharacters: regularAssembly.usedSemanticCharacters + cognitionCharacters
  });
}

function normalizeCognitionProjection(
  input: unknown
): CharacterHarnessCognitionSectionProjection {
  const value = expectObject(input, "Character Harness post-cognition projection");
  assertAllowedKeys(
    value,
    ["version", "section"],
    "Character Harness post-cognition projection"
  );
  if (value.version !== CHARACTER_HARNESS_5I_VERSION) {
    throw new Error(
      `Character Harness post-cognition assembly requires ${CHARACTER_HARNESS_5I_VERSION}.`
    );
  }

  const context = createCharacterAbi2DContext({
    abiVersion: CHARACTER_ABI_2D_VERSION,
    sections: [value.section]
  });
  const section = context.sections[0];
  if (section?.kind !== "COGNITION_RESULT") {
    throw new Error(
      "Character Harness post-cognition assembly requires a structured COGNITION_RESULT section."
    );
  }

  return Object.freeze({
    version: CHARACTER_HARNESS_5I_VERSION,
    section
  });
}

function measureCognitionSemanticCharacters(
  section: CharacterAbi2DCognitionResultSection
): number {
  const result = section.result;
  const answerCharacters = result.answer?.length ?? 0;
  const keyFactCharacters = sumStrings(result.keyFacts);
  const evidenceCharacters =
    result.evidence?.reduce(
      (total, evidence) => total + evidence.reference.length + evidence.statement.length,
      0
    ) ?? 0;
  const uncertaintyCharacters = sumStrings(result.uncertainty);
  const caveatCharacters = sumStrings(result.caveats);

  return (
    answerCharacters +
    keyFactCharacters +
    evidenceCharacters +
    uncertaintyCharacters +
    caveatCharacters
  );
}

function sumStrings(values: readonly string[] | undefined): number {
  return values?.reduce((total, value) => total + value.length, 0) ?? 0;
}

function normalizeBudget(input: unknown): CharacterHarnessAssemblyBudget {
  const value = expectObject(input, "Character Harness post-cognition assembly budget");
  assertAllowedKeys(
    value,
    ["maxSections", "maxSemanticCharacters"],
    "Character Harness post-cognition assembly budget"
  );

  const maxSections = boundedInteger(
    value.maxSections,
    "Character Harness post-cognition maxSections",
    CHARACTER_ABI_SECTION_KINDS.length
  );
  const maxSemanticCharacters = boundedInteger(
    value.maxSemanticCharacters,
    "Character Harness post-cognition maxSemanticCharacters",
    100_000
  );

  return Object.freeze({ maxSections, maxSemanticCharacters });
}

function boundedInteger(input: unknown, field: string, maximum: number): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 0 || input > maximum) {
    throw new Error(`${field} must be an integer between 0 and ${maximum}.`);
  }
  return input;
}

function expectObject(input: unknown, field: string): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  return input as UnknownObject;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown field: ${unknown.sort().join(", ")}.`);
  }
}
