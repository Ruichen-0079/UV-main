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
    if (cleaned) output.push(cleaned);
  }
  return output.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Emoji and decorative symbols are not speakable and break several local TTS
 * backends (for example GPT-SoVITS rejects them with HTTP 400). Strip them
 * before synthesis while keeping Japanese/Chinese text and punctuation.
 */
const NON_SPEECH_SYMBOLS =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;

export function sanitizeSpeechText(text: string): string {
  return text
    .replace(NON_SPEECH_SYMBOLS, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
