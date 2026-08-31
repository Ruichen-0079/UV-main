import {
  CHARACTER_ABI_2D_VERSION,
  createCharacterAbi2DContext,
  type CharacterAbi2DCognitionResultSection
} from "../../character-abi/src/v2d.js";
import {
  CHARACTER_HARNESS_5H_VERSION,
  createCharacterHarnessCognitionRoundTrip
} from "./cognition-result.js";

export const CHARACTER_HARNESS_5I_VERSION = "character-harness-5i.v1" as const;

export type CharacterHarnessCognitionSectionProjection = Readonly<{
  version: typeof CHARACTER_HARNESS_5I_VERSION;
  section: CharacterAbi2DCognitionResultSection;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  request?: unknown;
  result?: unknown;
};

/**
 * Project an already-normalized, validated cognition round-trip into the
 * structured Character ABI 2D COGNITION_RESULT section.
 *
 * This does not insert, order, rank, budget, summarize, or truncate the section.
 * It exists only to bridge the validated 5H round-trip into the 2D ABI shape.
 */
export function createCharacterHarnessCognitionResultSection(
  input: unknown
): CharacterHarnessCognitionSectionProjection {
  const value = expectObject(input, "Character Harness cognition section input");
  assertAllowedKeys(
    value,
    ["version", "request", "result"],
    "Character Harness cognition section input"
  );
  if (value.version !== CHARACTER_HARNESS_5H_VERSION) {
    throw new Error(
      `Character Harness cognition section requires ${CHARACTER_HARNESS_5H_VERSION}.`
    );
  }

  const roundTrip = createCharacterHarnessCognitionRoundTrip({
    request: value.request,
    result: value.result
  });
  const context = createCharacterAbi2DContext({
    abiVersion: CHARACTER_ABI_2D_VERSION,
    sections: [
      {
        kind: "COGNITION_RESULT",
        result: roundTrip.result
      }
    ]
  });
  const section = context.sections[0];
  if (section === undefined || section.kind !== "COGNITION_RESULT") {
    throw new Error("Character Harness cognition section projection failed closed.");
  }

  return Object.freeze({
    version: CHARACTER_HARNESS_5I_VERSION,
    section
  });
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
