import {
  CHARACTER_ABI_2A_VERSION,
  createCharacterAbiContext,
  createNormalizedCognitionResult,
  isCharacterOutputLanguage,
  type CharacterAbiSectionKind,
  type CharacterAbiSemanticSection,
  type CharacterOutputLanguage,
  type NormalizedCognitionResult
} from "./index.js";

export const CHARACTER_ABI_2D_VERSION = "character-abi-2d.v1" as const;

export type CharacterAbi2DRegularSectionKind = Exclude<
  CharacterAbiSectionKind,
  "COGNITION_RESULT"
>;

export type CharacterAbi2DRegularSection = Readonly<
  Omit<CharacterAbiSemanticSection, "kind"> & {
    kind: CharacterAbi2DRegularSectionKind;
  }
>;

export type CharacterAbi2DCognitionResultSection = Readonly<{
  kind: "COGNITION_RESULT";
  result: NormalizedCognitionResult;
}>;

export type CharacterAbi2DSection =
  | CharacterAbi2DRegularSection
  | CharacterAbi2DCognitionResultSection;

export type CharacterAbi2DContext = Readonly<{
  abiVersion: typeof CHARACTER_ABI_2D_VERSION;
  outputLanguage?: CharacterOutputLanguage;
  sections: readonly CharacterAbi2DSection[];
}>;

type UnknownObject = Record<string, unknown> & {
  abiVersion?: unknown;
  outputLanguage?: unknown;
  sections?: unknown;
  kind?: unknown;
  state?: unknown;
  summary?: unknown;
  provenanceReferences?: unknown;
  result?: unknown;
};

/**
 * Successor Character ABI context that keeps ordinary semantic sections on the
 * 2A envelope while representing COGNITION_RESULT as its normalized structured
 * meaning. The legacy 2A parser remains available during migration, but 2A and
 * 2D envelopes are never accepted interchangeably.
 */
export function createCharacterAbi2DContext(input: unknown): CharacterAbi2DContext {
  const value = expectObject(input, "Character ABI 2D context");
  assertAllowedKeys(
    value,
    ["abiVersion", "outputLanguage", "sections"],
    "Character ABI 2D context"
  );
  if (value.abiVersion !== CHARACTER_ABI_2D_VERSION) {
    throw new Error(`Character ABI 2D version must be ${CHARACTER_ABI_2D_VERSION}.`);
  }
  if (!Array.isArray(value.sections)) {
    throw new Error("Character ABI 2D sections must be an array.");
  }
  if (value.outputLanguage !== undefined && !isCharacterOutputLanguage(value.outputLanguage)) {
    throw new Error("Character ABI 2D outputLanguage is invalid.");
  }

  const seenKinds = new Set<CharacterAbiSectionKind>();
  const sections = value.sections.map((section, index) => {
    const normalized = normalize2DSection(section, index);
    if (seenKinds.has(normalized.kind)) {
      throw new Error(`Character ABI 2D section kind must be unique: ${normalized.kind}.`);
    }
    seenKinds.add(normalized.kind);
    return normalized;
  });

  return Object.freeze({
    abiVersion: CHARACTER_ABI_2D_VERSION,
    ...(value.outputLanguage === undefined ? {} : { outputLanguage: value.outputLanguage }),
    sections: Object.freeze(sections)
  });
}

function normalize2DSection(input: unknown, index: number): CharacterAbi2DSection {
  const value = expectObject(input, `Character ABI 2D section ${index}`);

  if (value.kind === "COGNITION_RESULT") {
    assertAllowedKeys(
      value,
      ["kind", "result"],
      `Character ABI 2D COGNITION_RESULT section ${index}`
    );
    return Object.freeze({
      kind: "COGNITION_RESULT",
      result: createNormalizedCognitionResult(value.result)
    });
  }

  assertAllowedKeys(
    value,
    ["kind", "state", "summary", "provenanceReferences"],
    `Character ABI 2D regular section ${index}`
  );

  const legacy = createCharacterAbiContext({
    abiVersion: CHARACTER_ABI_2A_VERSION,
    sections: [value]
  }).sections[0];

  if (legacy === undefined || legacy.kind === "COGNITION_RESULT") {
    throw new Error(`Character ABI 2D regular section ${index} kind is invalid.`);
  }

  return legacy as CharacterAbi2DRegularSection;
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
