import { detectSpeechLanguage } from "./speech-queue.js";
import { SpeechSegmenter } from "./speech-segmenter.js";
import {
  createInitialVoiceModeState,
  reduceVoiceMode,
  type VoiceModeEvent,
  type VoiceModeState
} from "./voice-mode-machine.js";

export type VoiceCaptureHandle = unknown;

export type VoiceRecordedAudio = {
  audioBase64: string;
  mimeType: string;
  durationMs: number;
};

export type VoiceTranscript = {
  text: string;
};

export type VoiceSentence = {
  utteranceId: string;
  sequence: number;
  text: string;
  language: string;
};

/**
 * Collaborators supplied by the hosting surface. The controller owns
 * capture/STT orchestration, utterance generations, sentence ordering, and
 * the voice state machine — but never touches the Runtime directly. The
 * transcript is handed to `sendRuntimeText`, which the host wires to the
 * normal Runtime message path (streamMessage with `voiceOutput: false` +
 * companion sentence-level TTS). There is deliberately no voice-specific
 * execution, memory, or synthesis authority here.
 */
export type VoiceModeControllerDeps = {
  startCapture(): Promise<VoiceCaptureHandle>;
  stopCapture(handle: VoiceCaptureHandle): Promise<VoiceRecordedAudio>;
  releaseCapture(handle: VoiceCaptureHandle): void;
  transcribe(audio: VoiceRecordedAudio, options: { signal: AbortSignal }): Promise<VoiceTranscript>;
  /** Hands the transcript to the normal Runtime path. Settlement arrives via notify*. */
  sendRuntimeText(utteranceId: string, text: string): void;
  speakSentence(sentence: VoiceSentence): void;
  finishSpeech(utteranceId: string): void;
  cancelSpeech(utteranceId: string): void;
  interruptRuntimeTurn(): void;
};

export type VoiceModeControllerOptions = {
  /** Bounded utterance boundary; recording auto-stops after this long. */
  maxRecordingMs?: number;
  createUtteranceId?: () => string;
};

const DEFAULT_MAX_RECORDING_MS = 60_000;

let fallbackUtteranceSequence = 0;

function defaultUtteranceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `voice-${uuid}`;
  fallbackUtteranceSequence += 1;
  return `voice-${fallbackUtteranceSequence}`;
}

export function friendlyVoiceError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      return "麦克风权限被拒绝，请在桌面应用设置中允许麦克风访问。";
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return "没有可用的麦克风设备，请检查设备连接后重试。";
    }
    if (error.message) return error.message;
  }
  return "语音录音或转写失败，请检查麦克风权限和本地语音服务。";
}

/**
 * Framework-agnostic Voice Mode orchestrator. All async boundaries are
 * fenced by utteranceId so stale callbacks can never disturb a newer turn:
 * - a superseded STT result never enters Runtime,
 * - an aborted STT never triggers a message,
 * - stale assistant deltas never emit sentences,
 * - stale playback signals never move the machine.
 */
export class VoiceModeController {
  private state: VoiceModeState = createInitialVoiceModeState();
  private readonly listeners = new Set<(state: VoiceModeState) => void>();
  private readonly maxRecordingMs: number;
  private readonly createUtteranceId: () => string;
  private disposed = false;
  private captureHandle: VoiceCaptureHandle | null = null;
  private capturePending = false;
  private pendingStop = false;
  private sttController: AbortController | null = null;
  private recordingTimer: ReturnType<typeof setTimeout> | null = null;
  private segmenter: SpeechSegmenter | null = null;
  private sentenceSequence = 0;
  private spokeAnySentence = false;
  private ttsRequested = true;

  constructor(
    private readonly deps: VoiceModeControllerDeps,
    options: VoiceModeControllerOptions = {}
  ) {
    this.maxRecordingMs = options.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS;
    this.createUtteranceId = options.createUtteranceId ?? defaultUtteranceId;
  }

  getState(): VoiceModeState {
    return this.state;
  }

  subscribe(listener: (state: VoiceModeState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private dispatch(event: VoiceModeEvent): void {
    const next = reduceVoiceMode(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of Array.from(this.listeners)) listener(this.state);
  }

  private isCurrent(utteranceId: string): boolean {
    return this.state.utteranceId === utteranceId;
  }

  /**
   * Starts a new utterance. Ignored while recording/transcribing (repeated
   * start is safe); barges in from thinking/speaking by interrupting the
   * old turn first so the interrupted state stays observable.
   */
  start(options: { ttsRequested?: boolean } = {}): void {
    if (this.disposed) return;
    const status = this.state.status;
    if (status === "recording" || status === "transcribing") return;
    if (status === "thinking" || status === "speaking") {
      this.interruptCurrent();
    }
    this.ttsRequested = options.ttsRequested ?? true;
    this.beginCapture(this.createUtteranceId());
  }

  /**
   * Context-sensitive stop: recording -> settle the utterance and
   * transcribe; transcribing -> abort STT; thinking/speaking -> interrupt
   * the turn. Always safe to call repeatedly.
   */
  stop(): void {
    if (this.disposed) return;
    const { status } = this.state;
    if (status === "recording") {
      this.stopRecording();
      return;
    }
    if (status === "transcribing") {
      // Abort the STT request and park synchronously so the surface answers
      // immediately; the late settlement is fenced by utterance + status and
      // can never trigger a message.
      const { utteranceId } = this.state;
      this.sttController?.abort();
      if (utteranceId !== null) {
        this.dispatch({ type: "transcribe-aborted", utteranceId });
      }
      return;
    }
    if (status === "thinking" || status === "speaking") {
      this.interruptCurrent();
    }
  }

  /** Settles an in-flight recording; no-op unless currently recording. */
  stopRecording(): void {
    if (this.disposed) return;
    const { status, utteranceId } = this.state;
    if (status !== "recording" || utteranceId === null) return;
    this.dispatch({ type: "stop-requested", utteranceId });
    if (this.capturePending || this.captureHandle === null) {
      // Stop arrived before MediaRecorder fully started: settle as soon as
      // the handle arrives instead of leaking the microphone.
      this.pendingStop = true;
      return;
    }
    const handle = this.captureHandle;
    this.captureHandle = null;
    this.clearRecordingTimer();
    void this.settleCapture(utteranceId, handle);
  }

  dismiss(): void {
    if (this.disposed) return;
    this.dispatch({ type: "dismiss" });
  }

  /** Assistant streaming deltas for one utterance; stale chunks are dropped. */
  notifyTextDelta(utteranceId: string, text: string): void {
    if (this.disposed || !this.isCurrent(utteranceId)) return;
    const { status } = this.state;
    if (status !== "thinking" && status !== "speaking") return;
    if (!this.ttsRequested) return;
    const segmenter = this.segmenter;
    if (!segmenter) return;
    for (const sentence of segmenter.push(text)) {
      this.emitSentence(utteranceId, sentence);
    }
  }

  notifyRuntimeCompleted(utteranceId: string): void {
    if (this.disposed || !this.isCurrent(utteranceId)) return;
    const { status } = this.state;
    if (status !== "thinking" && status !== "speaking") return;
    if (!this.ttsRequested || !this.spokeAnySentence) {
      // Nothing will play: never wait for playback signals.
      this.segmenter?.reset();
      this.segmenter = null;
      this.dispatch({ type: "runtime-completed-silent", utteranceId });
      return;
    }
    for (const sentence of this.segmenter?.flush("completed") ?? []) {
      this.emitSentence(utteranceId, sentence);
    }
    this.segmenter = null;
    try {
      this.deps.finishSpeech(utteranceId);
    } catch {
      // Posting the end marker is best effort; playback signals still settle.
    }
    this.dispatch({ type: "runtime-completed", utteranceId });
  }

  notifyRuntimeFailed(utteranceId: string, error: string): void {
    if (this.disposed || !this.isCurrent(utteranceId)) return;
    const { status } = this.state;
    if (status !== "thinking" && status !== "speaking") return;
    if (this.ttsRequested && this.spokeAnySentence) {
      // Mirror the normal path: already-terminated leftovers still flush so
      // queued audio matches the preserved text; unterminated tails drop.
      for (const sentence of this.segmenter?.flush("failed") ?? []) {
        this.emitSentence(utteranceId, sentence);
      }
      try {
        this.deps.finishSpeech(utteranceId);
      } catch {
        // Best effort; the error state below is authoritative.
      }
    }
    this.segmenter?.reset();
    this.segmenter = null;
    this.dispatch({ type: "runtime-failed", utteranceId, error });
  }

  notifyRuntimeAborted(utteranceId: string): void {
    if (this.disposed || !this.isCurrent(utteranceId)) return;
    const { status } = this.state;
    if (status !== "thinking" && status !== "speaking") return;
    this.segmenter?.reset();
    this.segmenter = null;
    this.dispatch({ type: "runtime-aborted", utteranceId });
  }

  notifyPlaybackEnded(utteranceId: string): void {
    if (this.disposed || !this.isCurrent(utteranceId)) return;
    this.dispatch({ type: "playback-ended", utteranceId });
  }

  notifyPlaybackFailed(utteranceId: string, error: string): void {
    if (this.disposed || !this.isCurrent(utteranceId)) return;
    this.dispatch({ type: "playback-failed", utteranceId, error });
  }

  /** Releases every held resource; late callbacks become no-ops. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRecordingTimer();
    this.sttController?.abort();
    this.sttController = null;
    if (this.captureHandle !== null) {
      try {
        this.deps.releaseCapture(this.captureHandle);
      } catch {
        // Cleanup must never throw.
      }
      this.captureHandle = null;
    }
    this.capturePending = false;
    this.pendingStop = false;
    this.segmenter?.reset();
    this.segmenter = null;
    this.listeners.clear();
  }

  private beginCapture(utteranceId: string): void {
    this.dispatch({ type: "start", utteranceId });
    this.capturePending = true;
    this.pendingStop = false;
    void this.deps.startCapture().then(
      (handle) => {
        if (this.disposed || !this.isCurrent(utteranceId)) {
          // Superseded (or torn down) while permission was pending: never
          // leak the microphone.
          try {
            this.deps.releaseCapture(handle);
          } catch {
            // Best effort.
          }
          return;
        }
        this.capturePending = false;
        if (this.pendingStop) {
          this.pendingStop = false;
          void this.settleCapture(utteranceId, handle);
          return;
        }
        this.captureHandle = handle;
        this.dispatch({ type: "capture-started", utteranceId });
        this.armRecordingTimer(utteranceId);
      },
      (error: unknown) => {
        if (this.disposed || !this.isCurrent(utteranceId)) return;
        this.capturePending = false;
        this.captureHandle = null;
        this.dispatch({ type: "capture-failed", utteranceId, error: friendlyVoiceError(error) });
      }
    );
  }

  private async settleCapture(utteranceId: string, handle: VoiceCaptureHandle): Promise<void> {
    let audio: VoiceRecordedAudio;
    try {
      audio = await this.deps.stopCapture(handle);
    } catch (error: unknown) {
      if (this.disposed || !this.isCurrent(utteranceId)) return;
      this.dispatch({ type: "capture-failed", utteranceId, error: friendlyVoiceError(error) });
      return;
    }
    if (this.disposed || !this.isCurrent(utteranceId)) return;
    if (!audio || typeof audio.audioBase64 !== "string" || audio.audioBase64.length === 0) {
      this.dispatch({ type: "capture-failed", utteranceId, error: "没有捕获到音频，请重试。" });
      return;
    }
    this.dispatch({ type: "capture-settled", utteranceId });
    void this.transcribe(utteranceId, audio);
  }

  private async transcribe(utteranceId: string, audio: VoiceRecordedAudio): Promise<void> {
    this.sttController?.abort();
    const stt = new AbortController();
    this.sttController = stt;
    try {
      const result = await this.deps.transcribe(audio, { signal: stt.signal });
      if (this.disposed || !this.isCurrent(utteranceId)) return;
      if (this.state.status !== "transcribing") return;
      const text = result.text?.trim() ?? "";
      if (!text) {
        this.dispatch({ type: "transcribe-failed", utteranceId, error: "转写结果为空，请重试。" });
        return;
      }
      this.dispatch({ type: "transcribed", utteranceId });
      this.beginRuntime(utteranceId, text);
    } catch (error: unknown) {
      if (this.disposed || !this.isCurrent(utteranceId)) return;
      if (stt.signal.aborted || this.state.status !== "transcribing") {
        // Aborted STT never triggers a message; park the live utterance as
        // interrupted so the user can immediately retry.
        this.dispatch({ type: "transcribe-aborted", utteranceId });
        return;
      }
      this.dispatch({ type: "transcribe-failed", utteranceId, error: friendlyVoiceError(error) });
    } finally {
      if (this.sttController === stt) this.sttController = null;
    }
  }

  private beginRuntime(utteranceId: string, text: string): void {
    this.segmenter = new SpeechSegmenter();
    this.sentenceSequence = 0;
    this.spokeAnySentence = false;
    try {
      this.deps.sendRuntimeText(utteranceId, text);
    } catch (error: unknown) {
      if (this.disposed || !this.isCurrent(utteranceId)) return;
      this.segmenter = null;
      this.dispatch({ type: "runtime-failed", utteranceId, error: friendlyVoiceError(error) });
    }
  }

  private emitSentence(utteranceId: string, sentence: string): void {
    const sequence = this.sentenceSequence++;
    this.spokeAnySentence = true;
    try {
      this.deps.speakSentence({
        utteranceId,
        sequence,
        text: sentence,
        language: detectSpeechLanguage(sentence)
      });
    } catch {
      // A bus post failure must not break sentence order; the failure
      // surfaces through playback/runtime signals instead.
    }
    this.dispatch({ type: "runtime-first-sentence", utteranceId });
  }

  private interruptCurrent(): void {
    const { status, utteranceId } = this.state;
    if (utteranceId === null || status === "idle" || status === "error") return;
    this.clearRecordingTimer();
    this.sttController?.abort();
    this.sttController = null;
    if (this.captureHandle !== null) {
      try {
        this.deps.releaseCapture(this.captureHandle);
      } catch {
        // Best effort.
      }
      this.captureHandle = null;
    }
    this.capturePending = false;
    this.pendingStop = false;
    if (status === "thinking" || status === "speaking") {
      // New voice utterance interrupts the old turn: abort the in-flight
      // Runtime request (ownership stays with the message path) and clear
      // queued old sentences so stale audio never plays.
      try {
        this.deps.interruptRuntimeTurn();
      } catch {
        // Best effort.
      }
      try {
        this.deps.cancelSpeech(utteranceId);
      } catch {
        // Best effort.
      }
    }
    this.segmenter?.reset();
    this.segmenter = null;
    this.dispatch({ type: "interrupt", utteranceId });
  }

  private armRecordingTimer(utteranceId: string): void {
    this.clearRecordingTimer();
    this.recordingTimer = setTimeout(() => {
      this.recordingTimer = null;
      if (this.disposed || !this.isCurrent(utteranceId)) return;
      if (this.state.status !== "recording") return;
      // Bounded utterance boundary: auto-stop instead of recording forever.
      this.stopRecording();
    }, this.maxRecordingMs);
    const timer = this.recordingTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }

  private clearRecordingTimer(): void {
    if (this.recordingTimer !== null) {
      clearTimeout(this.recordingTimer);
      this.recordingTimer = null;
    }
  }
}
