export const CHARACTER_OUTPUT_LANGUAGES = ["AUTO", "EN", "ZH", "JA"] as const;
export type CharacterOutputLanguage = (typeof CHARACTER_OUTPUT_LANGUAGES)[number];

export const CHARACTER_EXPRESSION_LANGUAGES = ["EN", "ZH", "JA"] as const;
export type CharacterExpressionLanguage = (typeof CHARACTER_EXPRESSION_LANGUAGES)[number];

/**
 * Normalize the user-facing setting without turning contextual input evidence
 * into a durable preference. Invalid or absent settings fail closed to AUTO.
 */
export function normalizeCharacterOutputLanguage(input: unknown): CharacterOutputLanguage {
  if (typeof input !== "string") {
    return "AUTO";
  }

  const normalized = input.trim().toUpperCase();
  return isCharacterOutputLanguage(normalized) ? normalized : "AUTO";
}

export function isCharacterOutputLanguage(input: unknown): input is CharacterOutputLanguage {
  return (
    typeof input === "string" &&
    (CHARACTER_OUTPUT_LANGUAGES as readonly string[]).includes(input)
  );
}

/**
 * Resolve only the language hint needed by an existing TTS boundary. AUTO is
 * evaluated from this already-admitted final text for this turn; it never
 * updates settings, Memory, P8, or provider routing.
 */
export function resolveCharacterExpressionLanguage(
  preference: CharacterOutputLanguage,
  text: string
): CharacterExpressionLanguage {
  if (preference !== "AUTO") {
    return preference;
  }

  if (/[぀-ヿㇰ-ㇿ]/u.test(text)) {
    return "JA";
  }
  if (/[㐀-鿿]/u.test(text)) {
    return "ZH";
  }
  return "EN";
}

export function characterOutputLanguageInstruction(
  preference: CharacterOutputLanguage
): string {
  if (preference === "AUTO") {
    return "Output-language preference: AUTO. For this turn, follow the current interaction context naturally. Input-language evidence is context only; do not infer a durable preference, mutate settings, or write a language preference to Memory. This preference does not control Cognition's internal reasoning language, STT input language, TTS provider/model/voice, Subtitle rendering, or provider routing.";
  }

  const language =
    preference === "EN" ? "English" : preference === "ZH" ? "Chinese" : "Japanese";
  return `Output-language preference: ${preference}. The final Character expression must be in ${language}. Cognition may reason internally in another language, but its result must be expressed in ${language} by Character. This preference does not control STT input language, TTS provider/model/voice, Subtitle rendering, or provider routing.`;
}
