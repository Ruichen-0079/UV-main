/** Convert the rendered Markdown message into conservative speech text. */
export function speechTextFromMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
      continue;
    }
    let cleaned = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "")
      .replace(/<[^>]+>/g, "")
      .replace(/(```?|\*\*|__|~~)/g, "")
      .replace(/\|/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
    // Keep line boundaries as soft TTS boundaries. The segmenter later
    // decides whether a single newline or an empty line should end a chunk.
    output.push(cleaned);
  }
  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ");
}

/**
 * Emoji and decorative symbols are not speakable and break local GPT-SoVITS
 * (Alice wrapper returns HTTP 503 for wave dash / emoji). Strip or normalize
 * them before synthesis while keeping Japanese/Chinese text and speech
 * punctuation that the backend accepts.
 */
const NON_SPEECH_SYMBOLS =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;

/**
 * Characters that pass letter/punct checks but make Alice/GPT-SoVITS return 503.
 * Confirmed at the 9881 wrapper: wave dash alone is enough to fail synthesis.
 */
const TTS_UNSAFE_ORNAMENTS = /[〜～♪♫★☆♥♡※†‡•]/g;

/** Normalize curly quotes that some TTS frontends reject while keeping meaning. */
const CURLY_QUOTES: Array<[RegExp, string]> = [
  [/[“”]/g, '"'],
  [/[‘’]/g, "'"]
];

export function sanitizeSpeechText(text: string): string {
  // Keep lone punctuation deltas intact while pending accumulates;
  // only strip edge whitespace here. prepareSpeechSegment trims edge ornaments.
  let next = text
    .replace(/\r\n?/g, "\n")
    .replace(NON_SPEECH_SYMBOLS, "")
    .replace(TTS_UNSAFE_ORNAMENTS, " ");
  for (const [pattern, replacement] of CURLY_QUOTES) {
    next = next.replace(pattern, replacement);
  }
  return next
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Final per-segment cleanup immediately before enqueue / synthesis. */
export function prepareSpeechSegment(text: string): string {
  return sanitizeSpeechText(text)
    // Final request body must be a single line for GPT-SoVITS / Alice wrappers.
    .replace(/\n+/g, " ")
    .replace(/[ \t]+/g, " ")
    // Strip only leading/trailing whitespace and orphaned ornaments — keep
    // sentence-ending punctuation such as "." "!" "?" "。" intact.
    .replace(/^[\s、•]+|[\s、•]+$/g, "")
    .trim();
}

/** True when the segment still has speakable letters or digits after cleanup. */
export function isSpeakableSpeechText(value: string): boolean {
  return /\p{L}|\p{N}/u.test(value);
}
