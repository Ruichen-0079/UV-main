import { speechTextFromMarkdown } from "./speech-text.js";

export type SpeechFlushReason = "completed" | "cancelled" | "failed";

export type SpeechSegmenterOptions = {
  minChars?: number;
  maxChars?: number;
};

export class SpeechSegmenter {
  private pending = "";
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(options: SpeechSegmenterOptions = {}) {
    this.minChars = options.minChars ?? 8;
    this.maxChars = options.maxChars ?? 180;
  }

  push(markdownDelta: string): string[] {
    const text = speechTextFromMarkdown(markdownDelta);
    if (text) this.pending = joinSpeechText(this.pending, text);
    return this.drain(false);
  }

  flush(reason: SpeechFlushReason): string[] {
    const value = this.pending.trim();
    this.pending = "";
    if (!value) return [];
    if (reason !== "completed" && !/[。！？!?\.]\s*$/.test(value)) return [];
    return [value];
  }

  reset(): void {
    this.pending = "";
  }

  private drain(force: boolean): string[] {
    const emitted: string[] = [];
    while (this.pending.length >= this.minChars || force) {
      const boundary = findBoundary(this.pending, this.minChars, this.maxChars);
      if (boundary < 0) break;
      emitted.push(this.pending.slice(0, boundary).trim());
      this.pending = this.pending.slice(boundary).trimStart();
    }
    return emitted.filter(Boolean);
  }
}

function findBoundary(value: string, minChars: number, maxChars: number): number {
  const limit = Math.min(value.length, maxChars);
  for (let index = minChars - 1; index < limit; index += 1) {
    const char = value[index] ?? "";
    if ("。！？!?；;".includes(char)) return index + 1;
    if (char === "\n") return index + 1;
    if (char === "." && (index + 1 === value.length || /\s/.test(value[index + 1] ?? ""))) {
      return index + 1;
    }
  }
  if (value.length >= maxChars) {
    const whitespace = value.lastIndexOf(" ", limit);
    return whitespace >= minChars ? whitespace : limit;
  }
  return -1;
}

function joinSpeechText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  if (/^[\u3040-\u30ff\u3400-\u9fff]/.test(right) && /[\u3040-\u30ff\u3400-\u9fff]$/.test(left)) {
    return left + right;
  }
  return `${left} ${right}`;
}
