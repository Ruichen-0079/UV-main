import {
  isSpeakableSpeechText,
  prepareSpeechSegment,
  sanitizeSpeechText,
  speechTextFromMarkdown
} from "./speech-text.js";

export type SpeechFlushReason = "completed" | "cancelled" | "failed";

export type SpeechSegmenterOptions = {
  minChars?: number;
  maxChars?: number;
};

/**
 * Incremental speech segmenter.
 *
 * - Does not finalize sanitize on every SSE delta alone; pending accumulates.
 * - Consumed body is sliced away so it is never re-emitted.
 * - completed flushes the remaining tail once.
 * - Each emitted segment is re-run through prepareSpeechSegment and is a
 *   single trimmed speakable line.
 */
export class SpeechSegmenter {
  private pending = "";
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(options: SpeechSegmenterOptions = {}) {
    this.minChars = options.minChars ?? 8;
    this.maxChars = options.maxChars ?? 180;
  }

  push(markdownDelta: string): string[] {
    const text = sanitizeSpeechText(speechTextFromMarkdown(markdownDelta));
    if (
      isSpeakableSpeechText(text) ||
      text.includes("\n") ||
      (isSpeechPunctuation(text) && isSpeakableSpeechText(this.pending))
    ) {
      this.pending = joinSpeechText(this.pending, text);
    }
    return this.drain(false);
  }

  flush(reason: SpeechFlushReason): string[] {
    const value = this.pending.trim();
    this.pending = "";
    if (!isSpeakableSpeechText(value)) return [];
    if (reason !== "completed" && !/[。！？!?…\.]\s*$/.test(value)) return [];
    // completed is the only point where an unfinished tail is guaranteed to
    // be final. Drain it through the same maxChars / safe-boundary logic as
    // incremental deltas so a long response cannot become one oversized TTS
    // request merely because its final punctuation arrived in a later frame.
    this.pending = value;
    return this.drain(true);
  }

  reset(): void {
    this.pending = "";
  }

  private drain(force: boolean): string[] {
    const emitted: string[] = [];
    while (
      this.pending.length > 0 &&
      (this.pending.length >= this.minChars || force || hasNaturalBoundary(this.pending))
    ) {
      const boundary = findBoundary(this.pending, this.minChars, this.maxChars, force);
      if (boundary < 0) break;
      const segment = this.pending.slice(0, boundary).trim();
      if (isSpeakableSpeechText(segment)) emitted.push(segment);
      this.pending = this.pending.slice(boundary).trimStart();
    }
    return finalizeSegments(emitted);
  }
}

function finalizeSegments(segments: string[]): string[] {
  const result: string[] = [];
  for (const segment of segments) {
    const prepared = prepareSpeechSegment(segment);
    if (isSpeakableSpeechText(prepared)) result.push(prepared);
  }
  return result;
}

/**
 * English sentence end: `.` / `!` / `?` / `…`, CJK terminals, newlines, then
 * soft punctuation near the length limit, then spaces, then hard cut.
 */
function findBoundary(value: string, minChars: number, maxChars: number, force = false): number {
  const limit = Math.min(value.length, maxChars);

  // Prefer true sentence / paragraph ends anywhere in the visible window so
  // short openers such as "Hello." are not held behind minChars.
  for (let index = 0; index < limit; index += 1) {
    const char = value[index] ?? "";
    if ("。！？!?…".includes(char)) return index + 1;
    if (char === "\n" && index > 0) return index + 1;
    if (char === "." && isEnglishSentenceEnd(value, index)) {
      return index + 1;
    }
  }

  if (value.length >= maxChars) {
    // Soft punctuation near the limit: , ; : — -
    for (let index = limit - 1; index >= Math.max(0, minChars - 1); index -= 1) {
      const char = value[index] ?? "";
      if ("、，,;:;—–- \n".includes(char)) return index + 1;
    }
    // Space fallback already covered; hard cut last.
    return limit;
  }
  if (force) return value.length;
  return -1;
}

/** True when `.` ends a sentence rather than an abbreviation or decimal. */
function isEnglishSentenceEnd(value: string, index: number): boolean {
  const next = value[index + 1] ?? "";
  if (!(next === "" || /\s/.test(next))) return false;

  // Decimal / version: "2.5" or "v2.0"
  const prev = value[index - 1] ?? "";
  const nextNonSpace = value.slice(index + 1).match(/\S/)?.[0] ?? "";
  if (/\d/.test(prev) && /\d/.test(nextNonSpace)) return false;

  // Common abbreviations: Dr. Mr. Mrs. Ms. Prof. Sr. Jr. etc.
  const before = value.slice(0, index);
  if (/(?:^|[\s("'])(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|vs|etc|e\.g|i\.e)$/i.test(before)) {
    return false;
  }
  return true;
}

function joinSpeechText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (left.endsWith("\n") || right.startsWith("\n")) return `${left}${right}`;
  if (/^[\u3040-\u30ff\u3400-\u9fff]/.test(right) && /[\u3040-\u30ff\u3400-\u9fff]$/.test(left)) {
    return left + right;
  }
  // Preserve English contractions across deltas: "I" + "'m" → "I'm"
  if (/^['']/.test(right) || /['']$/.test(left)) {
    return left + right;
  }
  // Attach pure punctuation without inserting a space.
  if (/^[。！？!?…,.;:]+$/.test(right)) {
    return left + right;
  }
  return `${left} ${right}`;
}

function isSpeechPunctuation(value: string): boolean {
  return /^[。！？!?…；;,.，、]+$/.test(value);
}

function hasNaturalBoundary(value: string): boolean {
  if (/[。！？!?…\n]/.test(value)) return true;
  // English period that is a real sentence end (not Dr. / 2.5).
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "." && isEnglishSentenceEnd(value, index)) return true;
  }
  return false;
}
