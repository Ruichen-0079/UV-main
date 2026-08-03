import type { TTSResponse } from "./api/client.js";

export type SpeechQueueItem = {
  text: string;
  language: string;
};

export type SpeechQueueState = "idle" | "synthesizing" | "playing" | "stopped" | "error";

export type SpeechSynthesizer = (
  item: SpeechQueueItem,
  signal: AbortSignal
) => Promise<TTSResponse>;

export type SpeechPlayer = (output: TTSResponse, signal: AbortSignal) => Promise<void>;

export type SpeechQueueCallbacks = {
  onState?: (state: SpeechQueueState) => void;
  onError?: (error: unknown) => void;
};

type PendingSpeech = {
  sequence: number;
  item: SpeechQueueItem;
};

/**
 * Synthesis and playback are separate ordered stages. Synthesis is limited to
 * one in-flight request, but it does not wait for the previous audio to end;
 * playback still waits for the next sequence so audio can never be reordered.
 */
export class SpeechPlaybackQueue {
  private readonly pending: PendingSpeech[] = [];
  private readonly ready = new Map<number, TTSResponse>();
  private readonly controller = new AbortController();
  private nextSequence = 0;
  private nextPlaybackSequence = 0;
  private synthesisRunning = false;
  private playbackRunning = false;
  private accepting = true;

  constructor(
    private readonly synthesize: SpeechSynthesizer,
    private readonly play: SpeechPlayer,
    private readonly callbacks: SpeechQueueCallbacks = {}
  ) {}

  enqueue(item: SpeechQueueItem): void {
    if (!this.accepting || !item.text.trim()) return;
    this.pending.push({ sequence: this.nextSequence++, item });
    void this.pumpSynthesis();
    void this.pumpPlayback();
  }

  finish(): void {
    this.accepting = false;
    this.maybeIdle();
  }

  cancel(): void {
    this.accepting = false;
    this.pending.length = 0;
    this.ready.clear();
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
        this.callbacks.onState?.("synthesizing");
        const output = await this.synthesize(pending.item, this.controller.signal);
        if (this.controller.signal.aborted) break;
        this.ready.set(pending.sequence, output);
        void this.pumpPlayback();
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.pending.length = 0;
        this.ready.clear();
        this.accepting = false;
        this.callbacks.onState?.("error");
        this.callbacks.onError?.(error);
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
      while (!this.controller.signal.aborted) {
        const output = this.ready.get(this.nextPlaybackSequence);
        if (!output) break;
        this.ready.delete(this.nextPlaybackSequence);
        this.nextPlaybackSequence += 1;
        this.callbacks.onState?.("playing");
        await this.play(output, this.controller.signal);
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.pending.length = 0;
        this.ready.clear();
        this.accepting = false;
        this.callbacks.onState?.("error");
        this.callbacks.onError?.(error);
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
      this.ready.size === 0 &&
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
  return (output, signal) =>
    new Promise<void>((resolve, reject) => {
      const bytes = Uint8Array.from(atob(output.audioBase64), (char) => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: output.mimeType || "audio/wav" }));
      const audio = new Audio(url);
      current = audio;
      let settled = false;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        audio.onended = null;
        audio.onerror = null;
        signal.removeEventListener("abort", abort);
        if (current === audio) current = null;
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        error ? reject(error) : resolve();
      };
      const abort = () => {
        audio.pause();
        finish(new DOMException("Speech playback cancelled.", "AbortError"));
      };
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("Speech playback failed."));
      signal.addEventListener("abort", abort, { once: true });
      void audio.play().catch(finish);
    });
}
