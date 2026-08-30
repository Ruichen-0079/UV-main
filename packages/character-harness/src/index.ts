import {
  CHARACTER_ABI_2A_VERSION,
  CHARACTER_ABI_SECTION_KINDS,
  createCharacterAbiContext,
  createCharacterProposal,
  type CharacterAbiContext,
  type CharacterAbiSectionKind,
  type CharacterAbiSemanticSection,
  type CharacterProposal
} from "../../character-abi/src/index.js";

export const CHARACTER_HARNESS_5A_VERSION = "character-harness-5a.v1" as const;
export const CHARACTER_HARNESS_5B_VERSION = "character-harness-5b.v1" as const;

export type CharacterHarnessAssemblyBudget = Readonly<{
  /** Prefix-only section budget. Zero is valid and produces an empty context. */
  maxSections: number;
  /**
   * Budget over semantic strings only: summaries plus opaque provenance references.
   * Wire-format syntax is deliberately not part of this adapter-neutral budget.
   */
  maxSemanticCharacters: number;
}>;

export type CharacterHarnessAssembly = Readonly<{
  version: typeof CHARACTER_HARNESS_5A_VERSION;
  context: CharacterAbiContext;
  omittedSectionKinds: readonly CharacterAbiSectionKind[];
  usedSemanticCharacters: number;
}>;

export type CharacterHarnessOutputInterpretation = Readonly<
  | {
      version: typeof CHARACTER_HARNESS_5B_VERSION;
      status: "ACCEPTED";
      proposal: CharacterProposal;
    }
  | {
      version: typeof CHARACTER_HARNESS_5B_VERSION;
      status: "MALFORMED";
      reason: "INVALID_CHARACTER_PROPOSAL";
    }
>;

type UnknownObject = Record<string, unknown> & {
  context?: unknown;
  budget?: unknown;
  maxSections?: unknown;
  maxSemanticCharacters?: unknown;
};

/**
 * Assemble an already-authorized Character ABI into a bounded model-facing
 * semantic context.
 *
 * Selection is intentionally prefix-only. The Harness preserves upstream
 * section order, never re-ranks sections, never backfills around an omitted
 * section, and never truncates or rewrites a section to make it fit.
 */
export function assembleCharacterHarnessContext(input: unknown): CharacterHarnessAssembly {
  const value = expectObject(input, "Character Harness assembly input");
  assertAllowedKeys(value, ["context", "budget"], "Character Harness assembly input");

  const context = createCharacterAbiContext(value.context);
  const budget = normalizeBudget(value.budget);
  const included: CharacterAbiSemanticSection[] = [];
  const omitted: CharacterAbiSectionKind[] = [];
  let usedSemanticCharacters = 0;
  let budgetClosed = false;

  for (const section of context.sections) {
    if (budgetClosed) {
      omitted.push(section.kind);
      continue;
    }

    const sectionCharacters = measureSemanticCharacters(section);
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
    version: CHARACTER_HARNESS_5A_VERSION,
    context: createCharacterAbiContext({
      abiVersion: CHARACTER_ABI_2A_VERSION,
      sections: included
    }),
    omittedSectionKinds: Object.freeze(omitted),
    usedSemanticCharacters
  });
}

/**
 * Interpret adapter-decoded Character semantic output without executing it.
 *
 * The Character ABI remains the authority for proposal shape. Malformed output
 * collapses to a bounded diagnostic and the raw model/provider payload is never
 * echoed into the result. Retry/fallback decisions are deliberately deferred.
 */
export function interpretCharacterHarnessOutput(input: unknown): CharacterHarnessOutputInterpretation {
  try {
    const proposal = createCharacterProposal(input);
    return Object.freeze({
      version: CHARACTER_HARNESS_5B_VERSION,
      status: "ACCEPTED",
      proposal
    });
  } catch {
    return Object.freeze({
      version: CHARACTER_HARNESS_5B_VERSION,
      status: "MALFORMED",
      reason: "INVALID_CHARACTER_PROPOSAL"
    });
  }
}

function normalizeBudget(input: unknown): CharacterHarnessAssemblyBudget {
  const value = expectObject(input, "Character Harness assembly budget");
  assertAllowedKeys(
    value,
    ["maxSections", "maxSemanticCharacters"],
    "Character Harness assembly budget"
  );

  const maxSections = boundedInteger(
    value.maxSections,
    "Character Harness maxSections",
    CHARACTER_ABI_SECTION_KINDS.length
  );
  const maxSemanticCharacters = boundedInteger(
    value.maxSemanticCharacters,
    "Character Harness maxSemanticCharacters",
    100_000
  );

  return Object.freeze({ maxSections, maxSemanticCharacters });
}

function measureSemanticCharacters(section: CharacterAbiSemanticSection): number {
  const summaryCharacters = section.summary?.length ?? 0;
  const provenanceCharacters =
    section.provenanceReferences?.reduce((total, reference) => total + reference.length, 0) ?? 0;
  return summaryCharacters + provenanceCharacters;
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
