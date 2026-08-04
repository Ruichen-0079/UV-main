export type MouthEnvelopeConfig = {
  noiseGate: number;
  gain: number;
  attack: number;
  release: number;
  maxValue: number;
};

export const defaultMouthEnvelopeConfig: MouthEnvelopeConfig = {
  noiseGate: 0.018,
  gain: 5.2,
  attack: 0.045,
  release: 0.13,
  maxValue: 2.1
};

export interface MouthParameterTarget {
  setMouthOpen(value: number): void;
  setMouthForm(value: number): void;
  resetMouth(): void;
}

export function rmsFromTimeDomain(samples: Uint8Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / samples.length);
}

export function gatedEnvelope(rms: number, config: MouthEnvelopeConfig): number {
  if (!Number.isFinite(rms) || rms <= config.noiseGate) return 0;
  return Math.min(config.maxValue, Math.max(0, (rms - config.noiseGate) * config.gain));
}

export function smoothMouthEnvelope(
  current: number,
  target: number,
  deltaSeconds: number,
  config: MouthEnvelopeConfig
): number {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return 0;
  const duration = target > current ? config.attack : config.release;
  if (duration <= 0 || deltaSeconds <= 0) return Math.min(config.maxValue, Math.max(0, target));
  const alpha = 1 - Math.exp(-deltaSeconds / duration);
  return Math.min(config.maxValue, Math.max(0, current + (target - current) * alpha));
}

export type AudioEnvelopeHost = {
  attach(audio: HTMLAudioElement): void;
  startPlayback?(audio: HTMLAudioElement): void;
  resume?(): void;
  detach(): void;
  stop(): void;
  dispose(): void;
};

type AudioContextLike = {
  createMediaElementSource(audio: HTMLAudioElement): {
    connect(destination: unknown): void;
    disconnect(): void;
  };
  createAnalyser(): {
    fftSize: number;
    connect(destination: unknown): void;
    disconnect(): void;
    getByteTimeDomainData(target: Uint8Array): void;
  };
  destination: unknown;
  state?: string;
  resume?(): Promise<void>;
  close?(): Promise<void>;
};

type AudioContextFactory = () => AudioContextLike;

/**
 * Drives Lumi's mouth only from the audio element that is currently playing.
 * The controller owns one AudioContext for its lifetime and never infers
 * articulation from the text stream or the synthesis queue.
 */
export class AudioMouthEnvelope implements AudioEnvelopeHost {
  private readonly context: AudioContextLike | null;
  private analyser: ReturnType<AudioContextLike["createAnalyser"]> | null = null;
  private source: ReturnType<AudioContextLike["createMediaElementSource"]> | null = null;
  private readonly sources = new WeakMap<HTMLAudioElement, ReturnType<AudioContextLike["createMediaElementSource"]>>();
  private attachedAudio: HTMLAudioElement | null = null;
  private samples = new Uint8Array(1024);
  private animationFrame: number | null = null;
  private previousTime: number | null = null;
  private value = 0;
  private disposed = false;
  private debugAudioId: number | null = null;
  private debugLastReportedAt = 0;
  private debugRawMin = Number.POSITIVE_INFINITY;
  private debugRawMax = 0;
  private debugMouthMin = Number.POSITIVE_INFINITY;
  private debugMouthMax = 0;
  private readonly visibilityHandler = () => {
    if (typeof document === "undefined") return;
    if (document.hidden) this.stop();
    else this.startLoop();
  };

  constructor(
    private readonly target: MouthParameterTarget,
    private readonly config: MouthEnvelopeConfig = defaultMouthEnvelopeConfig,
    factory: AudioContextFactory = defaultAudioContextFactory
  ) {
    try {
      this.context = typeof window === "undefined" ? null : factory();
    } catch {
      this.context = null;
    }
    this.target.setMouthForm(0);
    if (typeof document !== "undefined") {
      document.addEventListener?.("visibilitychange", this.visibilityHandler);
    }
    this.publishDebug({ context: this.context ? "created" : "unavailable" });
  }

  attach(audio: HTMLAudioElement): void {
    if (this.disposed || !this.context) return;
    this.detach();
    try {
      this.attachedAudio = audio;
      this.debugAudioId = getSpeechAudioDebugId(audio);
      this.source = this.sources.get(audio) ?? this.context.createMediaElementSource(audio);
      this.sources.set(audio, this.source);
      this.analyser ??= this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.source.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      this.previousTime = null;
      this.publishDebug({ attached: true, sourceBound: true });
    } catch {
      this.stop();
    }
  }

  /** Resume the shared context from the user's gesture before TTS resolves. */
  resume(): void {
    if (this.disposed || !this.context) return;
    const resumeResult = this.context.resume?.();
    if (resumeResult) {
      void resumeResult.then(
        () => this.publishDebug({ resume: "resolved" }),
        () => this.publishDebug({ resume: "rejected" })
      );
    }
  }

  /** Start sampling only after the corresponding HTMLAudioElement is playing. */
  startPlayback(audio: HTMLAudioElement): void {
    if (this.disposed || !this.context || this.attachedAudio !== audio || !this.source || !this.analyser) {
      return;
    }
    this.previousTime = null;
    this.resetDebugRange();
    const resumeResult = this.context.resume?.();
    if (resumeResult) {
      void resumeResult.then(
        () => {
          if (!this.disposed && this.attachedAudio === audio) this.startLoop();
          this.publishDebug({ resume: "resolved" });
        },
        () => {
          this.publishDebug({ resume: "rejected" });
          // Audio playback must not be blocked when analysis cannot resume.
          if (!this.disposed && this.attachedAudio === audio) this.startLoop();
        }
      );
    } else {
      this.startLoop();
    }
  }

  detach(): void {
    this.stop();
    try {
      this.source?.disconnect();
      this.analyser?.disconnect();
    } catch {
      // Browser audio nodes can already be disconnected during page teardown.
    }
    this.source = null;
    this.attachedAudio = null;
    this.debugAudioId = null;
    this.publishDebug({ attached: false, sourceBound: false });
  }

  stop(): void {
    if (this.animationFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = null;
    this.previousTime = null;
    this.value = 0;
    this.target.resetMouth();
    this.publishDebug({ mouth: 0 });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof document !== "undefined") {
      document.removeEventListener?.("visibilitychange", this.visibilityHandler);
    }
    this.detach();
    void this.context?.close?.();
  }

  private startLoop(): void {
    if (
      this.animationFrame !== null ||
      !this.analyser ||
      typeof requestAnimationFrame !== "function"
    ) {
      return;
    }
    const frame = (time: number) => {
      this.animationFrame = null;
      if (this.disposed || !this.analyser) return;
      if (typeof document !== "undefined" && document.hidden) {
        this.stop();
        return;
      }
      const deltaSeconds =
        this.previousTime === null
          ? 1 / 60
          : Math.min(0.1, Math.max(0, (time - this.previousTime) / 1000));
      this.previousTime = time;
      this.analyser.getByteTimeDomainData(this.samples);
      const rawRms = rmsFromTimeDomain(this.samples);
      const target = gatedEnvelope(rawRms, this.config);
      this.value = smoothMouthEnvelope(this.value, target, deltaSeconds, this.config);
      this.target.setMouthOpen(this.value);
      this.target.setMouthForm(0);
      this.debugRawMin = Math.min(this.debugRawMin, rawRms);
      this.debugRawMax = Math.max(this.debugRawMax, rawRms);
      this.debugMouthMin = Math.min(this.debugMouthMin, this.value);
      this.debugMouthMax = Math.max(this.debugMouthMax, this.value);
      this.publishDebug({ rawRms, gatedRms: target, mouth: this.value });
      this.animationFrame = requestAnimationFrame(frame);
    };
    this.animationFrame = requestAnimationFrame(frame);
  }

  private resetDebugRange(): void {
    this.debugRawMin = Number.POSITIVE_INFINITY;
    this.debugRawMax = 0;
    this.debugMouthMin = Number.POSITIVE_INFINITY;
    this.debugMouthMax = 0;
  }

  private publishDebug(values: Record<string, unknown>): void {
    if (!import.meta.env.DEV || typeof document === "undefined") return;
    const now = typeof performance === "undefined" ? 0 : performance.now();
    if (
      now - this.debugLastReportedAt < 1000 &&
      values["resume"] === undefined &&
      values["attached"] === undefined
    ) {
      return;
    }
    this.debugLastReportedAt = now;
    const audio = this.attachedAudio;
    document.documentElement.dataset["yuviLumiAudio"] = JSON.stringify({
      audioId: this.debugAudioId,
      contextState: this.context?.state ?? "unknown",
      audioPaused: audio?.paused ?? true,
      currentTime: audio?.currentTime ?? 0,
      volume: audio?.volume ?? 0,
      analyserBound: this.analyser !== null,
      sourceBound: this.source !== null,
      rawRmsMin: Number.isFinite(this.debugRawMin) ? this.debugRawMin : 0,
      rawRmsMax: this.debugRawMax,
      mouthMin: Number.isFinite(this.debugMouthMin) ? this.debugMouthMin : 0,
      mouthMax: this.debugMouthMax,
      ...values
    });
  }
}

function defaultAudioContextFactory(): AudioContextLike {
  const AudioContextConstructor =
    globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextConstructor) throw new Error("Web Audio is unavailable.");
  return new AudioContextConstructor() as unknown as AudioContextLike;
}
import { getSpeechAudioDebugId } from "./speech-queue.js";
