import {
  CHARACTER_ABI_SECTION_KINDS,
  type CharacterAbiSectionKind
} from "../../character-abi/src/index.js";
import {
  CHARACTER_ABI_2D_VERSION,
  createCharacterAbi2DContext,
  type CharacterAbi2DContext,
  type CharacterAbi2DSection
} from "../../character-abi/src/v2d.js";
import type { CharacterHarnessAssemblyBudget } from "./index.js";

export const CHARACTER_HARNESS_5J_VERSION = "character-harness-5j.v1" as const;

export type CharacterHarness2DAssembly = Readonly<{
  version: typeof CHARACTER_HARNESS_5J_VERSION;
  context: CharacterAbi2DContext;
  omittedSectionKinds: readonly CharacterAbiSectionKind[];
  usedSemanticCharacters: number;
}>;

type UnknownObject = Record<string, unknown> & {
  context?: unknown;
  budget?: unknown;
  maxSections?: unknown;
  maxSemanticCharacters?: unknown;
};

/**
 * Assemble a Character ABI 2D context under the same prefix-only policy as 5A.
 * Structured cognition is measured by its semantic string content only; this
 * function never summarizes, truncates, re-ranks, or backfills sections.
 */
export function assembleCharacterHarness2DContext(input: unknown): CharacterHarness2DAssembly {
  const value = expectObject(input, "Character Harness 2D assembly input");
  assertAllowedKeys(value, ["context", "budget"], "Character Harness 2D assembly input");

  const context = createCharacterAbi2DContext(value.context);
  const budget = normalizeBudget(value.budget);
  const included: CharacterAbi2DSection[] = [];
  const omitted: CharacterAbiSectionKind[] = [];
  let usedSemanticCharacters = 0;
  let budgetClosed = false;

  for (const section of context.sections) {
    if (budgetClosed) {
      omitted.push(section.kind);
      continue;
    }

    const sectionCharacters = measure2DSemanticCharacters(section);
    const exceedsSectionBudget = included.length + 1 > budget.maxSections;
    const exceedsCharacterBudget =
      usedSemanticCharacters + sectionCharacters > budget.maxSemanticCharacters;

    if (exceedsSectionBudget || exceedsCharacterBudget) {
      budgetClosed = true;
      omitted.push(section.kind);
      continue;
    }

    included.push(section);
    usedSemanticCharacters += sectionCharacters;
  }

  return Object.freeze({
    version: CHARACTER_HARNESS_5J_VERSION,
    context: createCharacterAbi2DContext({
      abiVersion: CHARACTER_ABI_2D_VERSION,
      sections: included
    }),
    omittedSectionKinds: Object.freeze(omitted),
    usedSemanticCharacters
  });
}

function measure2DSemanticCharacters(section: CharacterAbi2DSection): number {
  if (section.kind !== "COGNITION_RESULT") {
    const summaryCharacters = section.summary?.length ?? 0;
    const provenanceCharacters =
      section.provenanceReferences?.reduce((total, reference) => total + reference.length, 0) ?? 0;
    return summaryCharacters + provenanceCharacters;
  }

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
  const value = expectObject(input, "Character Harness 2D assembly budget");
  assertAllowedKeys(
    value,
    ["maxSections", "maxSemanticCharacters"],
    "Character Harness 2D assembly budget"
  );

  const maxSections = boundedInteger(
    value.maxSections,
    "Character Harness 2D maxSections",
    CHARACTER_ABI_SECTION_KINDS.length
  );
  const maxSemanticCharacters = boundedInteger(
    value.maxSemanticCharacters,
    "Character Harness 2D maxSemanticCharacters",
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
