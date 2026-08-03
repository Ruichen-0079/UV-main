import type { TTSResponse } from "./api/client.js";

export type SpeechQueueItem = {
  text: string;
  language: string;
};

export type SpeechQueueState = "idle" | "synthesizing" | "playing" | "stopped" | "error";

/**
 * Per-item lifecycle used for idempotent accounting: every enqueued segment
 * moves through a subset of these states and always reaches a terminal state
 * (completed / cancelled / failed) so a finished turn never leaves pending
 * fragments behind.
 */
export type SpeechItemState =
  | "queued"
  | "synthesizing"
  | "ready"
  | "playing"
  | "completed"
  | "cancelled"
  | "failed";

export type SpeechSynthesizer = (
  item: SpeechQueueItem,
  signal: AbortSignal
) => Promise<TTSResponse>;

export type SpeechPlayer = (
  output: TTSResponse,
  signal: AbortSignal,
  lifecycle?: SpeechPlayerLifecycle
) => Promise<void>;

export type SpeechQueueCallbacks = {
  onState?: (state: SpeechQueueState) => void;
  onError?: (error: unknown) => void;
  onItemState?: (id: string | undefined, state: SpeechItemState) => void;
  onSynthesisCompleted?: (item: PendingSpeech) => void;
  onPlaybackEvent?: (event: SpeechPlaybackEvent) => void;
};

export type SpeechPlaybackEventInput =
  | { type: "audioElementAttached"; audio: HTMLAudioElement }
  | { type: "playbackStarted"; audio: HTMLAudioElement }
  | { type: "playbackEnded"; audio: HTMLAudioElement }
  | { type: "playbackStopped"; audio: HTMLAudioElement }
  | { type: "playbackError"; audio: HTMLAudioElement; error: unknown }
  | { type: "audioElementDetached"; audio: HTMLAudioElement };

export type SpeechPlaybackEvent = SpeechPlaybackEventInput & { sequence: number };

export type SpeechPlayerLifecycle = {
  sequence: number;
  emit(event: SpeechPlaybackEventInput): void;
};

let nextSpeechAudioDebugId = 1;
const speechAudioDebugIds = new WeakMap<HTMLAudioElement, number>();

/** Development-only identity for correlating queue, playback and analyser logs. */
export function getSpeechAudioDebugId(audio: HTMLAudioElement): number {
  const existing = speechAudioDebugIds.get(audio);
  if (existing !== undefined) return existing;
  const id = nextSpeechAudioDebugId++;
  speechAudioDebugIds.set(audio, id);
  return id;
}

type PendingSpeech = {
  sequence: number;
  id: string | undefined;
  item: SpeechQueueItem;
};

/**
 * Synthesis and playback are separate ordered stages. Synthesis is limited to
 * one in-flight request, but it does not wait for the previous audio to end;
 * playback still waits for the next sequence so audio can never be reordered.
 */
export class SpeechPlaybackQueue {
  private readonly pending: PendingSpeech[] = [];
  private readonly ready: Array<{
    sequence: number;
    id: string | undefined;
    output: TTSResponse;
  }> = [];
  private readonly controller = new AbortController();
  private nextSequence = 0;
  private synthesisRunning = false;
  private playbackRunning = false;
  private accepting = true;
  private synthesizingItem: { sequence: number; id: string | undefined } | null = null;
  private playingItem: { sequence: number; id: string | undefined } | null = null;

  constructor(
    private readonly synthesize: SpeechSynthesizer,
    private readonly play: SpeechPlayer,
    private readonly callbacks: SpeechQueueCallbacks = {}
  ) {}

  enqueue(item: SpeechQueueItem, id?: string): void {
    if (!this.accepting || !item.text.trim()) return;
    const sequence = this.nextSequence++;
    const pending = { sequence, id: id as string | undefined, item };
    this.pending.push(pending);
    this.callbacks.onItemState?.(pending.id, "queued");
    void this.pumpSynthesis();
    void this.pumpPlayback();
  }

  finish(): void {
    this.accepting = false;
    this.maybeIdle();
  }

  cancel(): void {
    this.accepting = false;
    if (!this.controller.signal.aborted) {
      for (const pending of this.pending) {
        this.callbacks.onItemState?.(pending.id, "cancelled");
      }
      for (const ready of this.ready) {
        this.callbacks.onItemState?.(ready.id, "cancelled");
      }
      if (this.synthesizingItem) {
        this.callbacks.onItemState?.(this.synthesizingItem.id, "cancelled");
      }
      if (this.playingItem) {
        this.callbacks.onItemState?.(this.playingItem.id, "cancelled");
      }
    }
    this.pending.length = 0;
    this.ready.length = 0;
    this.synthesizingItem = null;
    this.playingItem = null;
    this.controller.abort();
    this.callbacks.onState?.("stopped");
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private async pumpSynthesis(): Promise<void> {
    if (this.synthesisRunning) return;
    this.synthesisRunning = true;
    try {
      while (this.pending.length > 0 && !this.controller.signal.aborted) {
        const pending = this.pending.shift();
        if (!pending) continue;
        this.synthesizingItem = { sequence: pending.sequence, id: pending.id };
        this.callbacks.onState?.("synthesizing");
        this.callbacks.onItemState?.(pending.id, "synthesizing");
        let output: TTSResponse;
        try {
          output = await this.synthesize(pending.item, this.controller.signal);
        } catch (error) {
          this.synthesizingItem = null;
          if (this.controller.signal.aborted) break;
          this.callbacks.onItemState?.(pending.id, "failed");
          this.callbacks.onState?.("error");
          this.callbacks.onError?.(error);
          continue;
        }
        this.synthesizingItem = null;
        if (this.controller.signal.aborted) break;
        this.ready.push({ sequence: pending.sequence, id: pending.id, output });
        this.callbacks.onItemState?.(pending.id, "ready");
        this.callbacks.onSynthesisCompleted?.(pending);
        void this.pumpPlayback();
      }
    } finally {
      this.synthesisRunning = false;
      this.maybeIdle();
    }
  }

  private async pumpPlayback(): Promise<void> {
    if (this.playbackRunning) return;
    this.playbackRunning = true;
    try {
      // Always play the lowest ready sequence next so concurrent synthesis
      // completion cannot reorder audio (sequence 0 must always lead).
      while (!this.controller.signal.aborted) {
        if (this.ready.length === 0) break;
        this.ready.sort((left, right) => left.sequence - right.sequence);
        const next = this.ready.shift();
        if (!next) break;
        this.playingItem = { sequence: next.sequence, id: next.id };
        this.callbacks.onState?.("playing");
        this.callbacks.onItemState?.(next.id, "playing");
        try {
          await this.play(next.output, this.controller.signal, {
            sequence: next.sequence,
            emit: (event) =>
              this.callbacks.onPlaybackEvent?.({
                ...event,
                sequence: next.sequence
              } as SpeechPlaybackEvent)
          });
        } catch (error) {
          this.playingItem = null;
          if (this.controller.signal.aborted) break;
          // First play failure (including autoplay policy) is a terminal
          // failed state for that segment — never treat it as completed.
          this.callbacks.onItemState?.(next.id, "failed");
          this.callbacks.onState?.("error");
          this.callbacks.onError?.(error);
          continue;
        }
        this.playingItem = null;
        this.callbacks.onItemState?.(next.id, "completed");
      }
    } finally {
      this.playbackRunning = false;
      this.maybeIdle();
    }
  }

  private maybeIdle(): void {
    if (
      !this.controller.signal.aborted &&
      this.pending.length === 0 &&
      this.ready.length === 0 &&
      !this.synthesisRunning &&
      !this.playbackRunning
    ) {
      this.callbacks.onState?.("idle");
    }
  }
}

export function detectSpeechLanguage(text: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return "ja";
  if (/[\u4e00-\u9fff]/.test(text)) return "zh";
  return "en";
}

export function createBrowserSpeechPlayer(): SpeechPlayer {
  let current: HTMLAudioElement | null = null;
  return (output, signal, lifecycle) =>
    new Promise<void>((resolve, reject) => {
      const bytes = Uint8Array.from(atob(output.audioBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: output.mimeType || "audio/wav" }));
      const audio = new Audio(url);
      getSpeechAudioDebugId(audio);
      current = audio;
      let settled = false;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        audio.onended = null;
        audio.onerror = null;
        signal.removeEventListener("abort", abort);
        if (current === audio) current = null;
      };
      const emit = (event: SpeechPlaybackEventInput) => lifecycle?.emit(event);
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        emit({ type: "audioElementDetached", audio });
        error ? reject(error) : resolve();
      };
      const abort = () => {
        audio.pause();
        emit({ type: "playbackStopped", audio });
        finish(new DOMException("Speech playback cancelled.", "AbortError"));
      };
      audio.onended = () => {
        emit({ type: "playbackEnded", audio });
        finish();
      };
      audio.onerror = () => {
        const error = new Error("Speech playback failed.");
        emit({ type: "playbackError", audio, error });
        finish(error);
      };
      emit({ type: "audioElementAttached", audio });
      signal.addEventListener("abort", abort, { once: true });
      void audio
        .play()
        .then(() => {
          // A pending play() promise may settle after cancellation. Once the
          // lifecycle is settled, the old generation must not revive speech
          // presence or the mouth analyser.
          if (!settled) emit({ type: "playbackStarted", audio });
        })
        .catch((error) => {
          if (settled) return;
          emit({ type: "playbackError", audio, error });
          finish(error);
        });
    });
}
