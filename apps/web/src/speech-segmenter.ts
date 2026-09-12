import {
  isSpeakableSpeechText,
  prepareSpeechSegment,
  sanitizeSpeechText,
  speechTextFromMarkdown
} from "./speech-text.js";

export type SpeechFlushReason = "completed" | "cancelled" | "failed";

/**
 * Realtime queue feedback consulted on every delta. `undefined` (no provider,
 * or a transient read failure) falls back to the latency-safe strong-boundary
 * behavior, which is also the correct policy while the pipeline is healthy.
 */
export type SpeechPipelineSnapshot = {
  playing: boolean;
  synthesizing: boolean;
  playbackEnded: number;
};

export type SpeechReleaseReason =
  | "FIRST_STRONG"
  | "FIRST_MERGED"
  | "STRONG_BOUNDARY"
  | "STARVING_SOFT_BOUNDARY"
  | "EMERGENCY_BOUND"
  | "FINAL_FLUSH";

export type SpeechSegmenterOptions = {
  minChars?: number;
  maxChars?: number;
  /** Reads the current playback/synthesis state for the active turn. */
  pipeline?: () => SpeechPipelineSnapshot | undefined;
  /** Optional release observer for tests and passive live instrumentation. */
  onRelease?: (segment: string, reason: SpeechReleaseReason) => void;
};

type BoundaryKind = "strong" | "starving-soft" | "emergency";

/**
 * Incremental speech segmenter — the single speech segmentation authority.
 *
 * - Does not finalize sanitize on every SSE delta alone; pending accumulates.
 * - Consumed body is sliced away so it is never re-emitted.
 * - completed flushes the remaining tail once.
 * - Each emitted segment is re-run through prepareSpeechSegment and is a
 *   single trimmed speakable line.
 *
 * Release urgency is queue-aware: the first meaningful strong boundary is
 * released immediately, strong boundaries always win, and an already-arrived
 * soft boundary may only be spoken when playback has demonstrably run dry
 * (starving) so a starving synthesizer gets work without degrading prosody
 * while audio is still playing.
 */
export class SpeechSegmenter {
  private pending = "";
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly pipeline: (() => SpeechPipelineSnapshot | undefined) | null;
  private readonly onRelease: ((segment: string, reason: SpeechReleaseReason) => void) | null;
  private released = 0;

  constructor(options: SpeechSegmenterOptions = {}) {
    this.minChars = options.minChars ?? 8;
    this.maxChars = options.maxChars ?? 180;
    this.pipeline = options.pipeline ?? null;
    this.onRelease = options.onRelease ?? null;
  }

  push(markdownDelta: string): string[] {
    const text = sanitizeSpeechText(speechTextFromMarkdown(markdownDelta));
    if (
      isSpeakableSpeechText(text) ||
      text.includes("\n") ||
      // Pure punctuation always accumulates: a segment release can consume
      // pending right before the other half of a "——" pair (or any standalone
      // punctuation) arrives, and dropping it would silently lose source text.
      isSpeechPunctuation(text)
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
    this.released = 0;
  }

  private readPipeline(): SpeechPipelineSnapshot | undefined {
    if (!this.pipeline) return undefined;
    try {
      return this.pipeline();
    } catch {
      return undefined;
    }
  }

  /**
   * Starving means speech was already released, everything released has
   * finished playing, nothing is audible and no future audio is being
   * synthesized. Only then may an already-arrived soft boundary be spoken.
   */
  private isStarving(): boolean {
    if (this.released === 0) return false;
    const snapshot = this.readPipeline();
    if (!snapshot) return false;
    if (snapshot.playing || snapshot.synthesizing) return false;
    return snapshot.playbackEnded >= this.released;
  }

  private drain(force: boolean): string[] {
    const cuts: Array<{ segment: string; reason: SpeechReleaseReason }> = [];
    while (
      this.pending.length > 0 &&
      (this.pending.length >= this.minChars || force || hasNaturalBoundary(this.pending))
    ) {
      const starving = this.isStarving();
      const boundary = findBoundary(this.pending, this.minChars, this.maxChars, force, starving);
      if (boundary.index < 0) break;
      let kind: BoundaryKind | "final" | "first" | "first-merged" = boundary.kind;
      let end = boundary.index;
      if (force && end >= this.pending.length) {
        kind = "final";
      } else if (kind === "strong" && this.released + cuts.length === 0) {
        const merged = mergeTinyCjkFirstSegment(this.pending, end, this.minChars, this.maxChars);
        end = merged.end;
        kind = merged.merged ? "first-merged" : "first";
      }
      const segment = this.pending.slice(0, end).trim();
      if (isSpeakableSpeechText(segment)) {
        cuts.push({ segment, reason: releaseReason(kind) });
      }
      this.pending = this.pending.slice(end).trimStart();
    }
    const emitted: string[] = [];
    for (const cut of cuts) {
      const prepared = prepareSpeechSegment(cut.segment);
      if (!isSpeakableSpeechText(prepared)) continue;
      this.released += 1;
      this.onRelease?.(prepared, cut.reason);
      emitted.push(prepared);
    }
    return emitted;
  }
}

function releaseReason(kind: BoundaryKind | "first" | "first-merged" | "final"): SpeechReleaseReason {
  switch (kind) {
    case "first":
      return "FIRST_STRONG";
    case "first-merged":
      return "FIRST_MERGED";
    case "strong":
      return "STRONG_BOUNDARY";
    case "starving-soft":
      return "STARVING_SOFT_BOUNDARY";
    case "emergency":
      return "EMERGENCY_BOUND";
    case "final":
      return "FINAL_FLUSH";
  }
}

/**
 * The first segment is latency-biased: one natural, meaningful stable unit
 * goes out immediately. Only an absurdly tiny CJK conversational fragment
 * (嗯。 / 对。 / 是的。) may absorb the next sentence, and only when that next
 * strong boundary is already available in the buffer — never by waiting.
 */
function mergeTinyCjkFirstSegment(
  pending: string,
  end: number,
  minChars: number,
  maxChars: number
): { end: number; merged: boolean } {
  let merged = false;
  let current = end;
  while (isTinyCjkFragment(pending.slice(0, current))) {
    const rest = pending.slice(current);
    if (!rest) break;
    const next = findBoundary(rest, minChars, maxChars, false, false);
    if (next.index < 0) break;
    const candidate = current + next.index;
    if (candidate > maxChars) break;
    current = candidate;
    merged = true;
  }
  return { end: current, merged };
}

/** 嗯 / 对 / 是的 — one absurdly tiny CJK interjection sentence. */
function isTinyCjkFragment(value: string): boolean {
  const core = (value.match(/[\p{L}\p{N}]/gu) ?? []).join("");
  return /^[\u4e00-\u9fff\u3040-\u30ff]{1,2}$/.test(core);
}

/**
 * English sentence end: `.` / `!` / `?` / `…`, CJK terminals, newlines, then —
 * only when explicitly allowed (starving) or near the emergency length cap —
 * soft punctuation, then a safe hard cut.
 */
function findBoundary(
  value: string,
  minChars: number,
  maxChars: number,
  force = false,
  allowSoftCut = false
): { index: number; kind: BoundaryKind | "final" } {
  const limit = Math.min(value.length, maxChars);

  // Prefer true sentence / paragraph ends anywhere in the visible window so
  // short openers such as "Hello." are not held behind minChars.
  for (let index = 0; index < limit; index += 1) {
    const char = value[index] ?? "";
    if ("。！？!?…".includes(char)) return { index: index + 1, kind: "strong" };
    if (char === "\n" && index > 0) return { index: index + 1, kind: "strong" };
    if (char === "." && isEnglishSentenceEnd(value, index)) {
      return { index: index + 1, kind: "strong" };
    }
  }

  if (value.length >= maxChars) {
    // Emergency bound: recent soft punctuation , ; : — - then hard cut.
    for (let index = limit - 1; index >= Math.max(0, minChars - 1); index -= 1) {
      if (isSoftBoundaryChar(value, index)) return { index: index + 1, kind: "emergency" };
    }
    // Space fallback already covered; hard cut last (surrogate-pair safe).
    return { index: safeHardCutIndex(value, limit), kind: "emergency" };
  }
  if (allowSoftCut) {
    // Playback has run dry: the most recent good soft boundary becomes an
    // acceptable cut so a starving synthesizer gets work immediately.
    for (let index = limit - 1; index >= Math.max(0, minChars - 1); index -= 1) {
      if (isSoftBoundaryChar(value, index)) return { index: index + 1, kind: "starving-soft" };
    }
  }
  if (force) return { index: safeHardCutIndex(value, limit), kind: "final" };
  return { index: -1, kind: "strong" };
}

/** True when `value[index]` is a soft boundary that is safe to cut after. */
function isSoftBoundaryChar(value: string, index: number): boolean {
  const char = value[index] ?? "";
  if (!"、，,;:；—–- \n".includes(char)) return false;
  // Never cut a numeric group like "1,000" in half.
  const prev = value[index - 1] ?? "";
  const next = value[index + 1] ?? "";
  if (/\d/.test(prev) && /\d/.test(next)) return false;
  return true;
}

/** Back off one code unit so a hard cut never splits a surrogate pair. */
function safeHardCutIndex(value: string, limit: number): number {
  if (limit > 0 && limit < value.length) {
    const prev = value.charCodeAt(limit - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) return limit - 1;
  }
  return limit;
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
  if (/^[。！？!?…,.;:，、；—–]+$/.test(right)) {
    return left + right;
  }
  return `${left} ${right}`;
}

function isSpeechPunctuation(value: string): boolean {
  return /^[。！？!?…；;,.，、—–]+$/.test(value);
}

function hasNaturalBoundary(value: string): boolean {
  if (/[。！？!?…\n]/.test(value)) return true;
  // English period that is a real sentence end (not Dr. / 2.5).
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "." && isEnglishSentenceEnd(value, index)) return true;
  }
  return false;
}
