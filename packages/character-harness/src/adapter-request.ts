import {
  CHARACTER_ABI_SECTION_KINDS,
  type CharacterAbiSectionKind
} from "../../character-abi/src/index.js";
import {
  createCharacterAbi2DContext,
  type CharacterAbi2DContext,
  type CharacterAbi2DSection
} from "../../character-abi/src/v2d.js";
import { CHARACTER_HARNESS_5J_VERSION } from "./assembly-v2d.js";
import { CHARACTER_HARNESS_5K_VERSION } from "./post-cognition-assembly.js";

export const CHARACTER_HARNESS_5L_VERSION = "character-harness-5l.v1" as const;

export type CharacterHarnessAdapterRequest = Readonly<{
  version: typeof CHARACTER_HARNESS_5L_VERSION;
  kind: "CHARACTER_GENERATION";
  context: CharacterAbi2DContext;
}>;

type UnknownObject = Record<string, unknown> & {
  assembly?: unknown;
  version?: unknown;
  kind?: unknown;
  status?: unknown;
  context?: unknown;
  omittedSectionKinds?: unknown;
  usedSemanticCharacters?: unknown;
};

/**
 * Construct the semantic request handed to a replaceable Character adapter.
 *
 * Only already-bounded 5J assembly or accepted 5K post-cognition assembly may
 * enter this seam. Harness diagnostics are deliberately stripped before the
 * adapter boundary. Concrete model identity, prompt/control-token syntax,
 * temperature, provider token limits, provider routing, and execution remain
 * adapter/Runtime concerns and are not part of this stable semantic request.
 */
export function createCharacterHarnessAdapterRequest(
  input: unknown
): CharacterHarnessAdapterRequest {
  const value = expectObject(input, "Character Harness adapter request input");
  assertAllowedKeys(value, ["assembly"], "Character Harness adapter request input");

  const context = normalizeBoundedAssembly(value.assembly);

  return Object.freeze({
    version: CHARACTER_HARNESS_5L_VERSION,
    kind: "CHARACTER_GENERATION",
    context
  });
}

function normalizeBoundedAssembly(input: unknown): CharacterAbi2DContext {
  const value = expectObject(input, "Character Harness bounded assembly");

  if (value.version === CHARACTER_HARNESS_5J_VERSION) {
    assertAllowedKeys(
      value,
      ["version", "context", "omittedSectionKinds", "usedSemanticCharacters"],
      "Character Harness 5J bounded assembly"
    );
    return normalizeAssemblyFields(value, "5J");
  }

  if (value.version === CHARACTER_HARNESS_5K_VERSION) {
    assertAllowedKeys(
      value,
      ["version", "status", "context", "omittedSectionKinds", "usedSemanticCharacters"],
      "Character Harness accepted 5K assembly"
    );
    if (value.status !== "ACCEPTED") {
      throw new Error("Character Harness adapter request requires an accepted 5K assembly.");
    }
    return normalizeAssemblyFields(value, "5K");
  }

  throw new Error("Character Harness adapter request requires a 5J or accepted 5K assembly.");
}

function normalizeAssemblyFields(
  value: UnknownObject,
  source: "5J" | "5K"
): CharacterAbi2DContext {
  const context = createCharacterAbi2DContext(value.context);
  normalizeOmittedSectionKinds(value.omittedSectionKinds, source);
  const usedSemanticCharacters = boundedInteger(
    value.usedSemanticCharacters,
    `Character Harness ${source} usedSemanticCharacters`,
    100_000
  );
  const measuredSemanticCharacters = measureContextSemanticCharacters(context);
  if (usedSemanticCharacters !== measuredSemanticCharacters) {
    throw new Error(
      `Character Harness ${source} usedSemanticCharacters does not match the bounded context.`
    );
  }
  return context;
}

function normalizeOmittedSectionKinds(input: unknown, source: "5J" | "5K"): void {
  if (!Array.isArray(input)) {
    throw new Error(`Character Harness ${source} omittedSectionKinds must be an array.`);
  }

  const seen = new Set<CharacterAbiSectionKind>();
  for (const kind of input) {
    if (!isSectionKind(kind)) {
      throw new Error(`Character Harness ${source} omittedSectionKinds contains an invalid kind.`);
    }
    if (seen.has(kind)) {
      throw new Error(`Character Harness ${source} omittedSectionKinds must be unique.`);
    }
    seen.add(kind);
  }
}

function measureContextSemanticCharacters(context: CharacterAbi2DContext): number {
  return context.sections.reduce(
    (total, section) => total + measureSectionSemanticCharacters(section),
    0
  );
}

function measureSectionSemanticCharacters(section: CharacterAbi2DSection): number {
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

function isSectionKind(input: unknown): input is CharacterAbiSectionKind {
  return (
    typeof input === "string" &&
    (CHARACTER_ABI_SECTION_KINDS as readonly string[]).includes(input)
  );
}

function boundedInteger(input: unknown, field: string, maximum: number): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    input > maximum
  ) {
    throw new Error(`${field} must be a safe integer between 0 and ${maximum}.`);
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
