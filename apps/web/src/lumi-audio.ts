import { getSpeechAudioData } from "./speech-queue.js";

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

type AudioDecoder = Pick<OfflineAudioContext, "decodeAudioData">;
type AudioContextFactory = () => AudioDecoder;

/**
 * Passive lip-sync: decode a copy of the synthesized bytes and sample it at
 * the playing element's media time. Never bind a MediaElementSource: doing so
 * takes ownership of audible output, and WebKitGTK can skip buffered speech
 * when that binding happens after play(). Decoder failure only loses lip-sync.
 */
export class AudioMouthEnvelope implements AudioEnvelopeHost {
  private readonly decoder: AudioDecoder | null;
  private buffer: AudioBuffer | null = null;
  private attachedAudio: HTMLAudioElement | null = null;
  private playing = false;
  private generation = 0;
  private animationFrame: number | null = null;
  private previousTime: number | null = null;
  private value = 0;
  private disposed = false;
  private readonly visibilityHandler = () => {
    if (document.hidden) this.clearFrame();
    else this.startLoop();
  };

  constructor(
    private readonly target: MouthParameterTarget,
    private readonly config: MouthEnvelopeConfig = defaultMouthEnvelopeConfig,
    factory: AudioContextFactory = defaultAudioContextFactory
  ) {
    try {
      this.decoder = typeof window === "undefined" ? null : factory();
    } catch {
      this.decoder = null;
    }
    if (typeof document !== "undefined") {
      document.addEventListener?.("visibilitychange", this.visibilityHandler);
    }
  }

  attach(audio: HTMLAudioElement): void {
    if (this.disposed) return;
    this.detach();
    this.attachedAudio = audio;
    const generation = this.generation;
    const data = getSpeechAudioData(audio);
    if (!this.decoder || !data) return;
    try {
      // decodeAudioData detaches its argument; pass a private copy so the
      // player-owned bytes and the blob URL cannot be transferred.
      void this.decoder.decodeAudioData(data.slice(0)).then(
        (buffer) => {
          if (this.disposed || generation !== this.generation || this.attachedAudio !== audio) return;
          this.buffer = buffer;
          this.startLoop();
        },
        () => { /* Analysis is optional; native speech remains untouched. */ }
      );
    } catch {
      // Some WebViews reject decoding synchronously. Playback still owns audio.
    }
  }

  startPlayback(audio: HTMLAudioElement): void {
    if (this.disposed || this.attachedAudio !== audio) return;
    this.playing = true;
    this.startLoop();
  }

  detach(): void {
    this.generation += 1;
    this.stop();
    this.buffer = null;
    this.attachedAudio = null;
  }

  stop(): void {
    this.playing = false;
    this.clearFrame();
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    if (typeof document !== "undefined") {
      document.removeEventListener?.("visibilitychange", this.visibilityHandler);
    }
  }

  private clearFrame(): void {
    if (this.animationFrame !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.animationFrame);
    }
    this.animationFrame = null;
    this.previousTime = null;
    this.value = 0;
    // ParamMouthForm belongs to expression, including during terminal cleanup.
    this.target.setMouthOpen(0);
  }

  private startLoop(): void {
    if (this.disposed || !this.playing || !this.buffer || this.animationFrame !== null ||
        typeof requestAnimationFrame !== "function" ||
        (typeof document !== "undefined" && document.hidden)) return;
    const frame = (time: number) => {
      this.animationFrame = null;
      const audio = this.attachedAudio;
      const buffer = this.buffer;
      if (this.disposed || !this.playing || !audio || !buffer) return;
      if (typeof document !== "undefined" && document.hidden) {
        this.clearFrame();
        return;
      }
      const deltaSeconds = this.previousTime === null ? 1 / 60
        : Math.min(0.1, Math.max(0, (time - this.previousTime) / 1000));
      this.previousTime = time;
      if (audio.paused || audio.ended || audio.muted || audio.readyState < 3) {
        this.value = 0;
      } else {
        const end = Math.min(buffer.length, Math.max(0, Math.floor(audio.currentTime * buffer.sampleRate)));
        const start = Math.max(0, end - 1024);
        let sum = 0;
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          const samples = buffer.getChannelData(channel);
          for (let index = start; index < end; index += 1) sum += (samples[index] ?? 0) ** 2;
        }
        const count = (end - start) * buffer.numberOfChannels;
        const rms = count > 0 ? Math.sqrt(sum / count) * audio.volume : 0;
        this.value = smoothMouthEnvelope(this.value, gatedEnvelope(rms, this.config), deltaSeconds, this.config);
      }
      this.target.setMouthOpen(this.value);
      this.animationFrame = requestAnimationFrame(frame);
    };
    this.animationFrame = requestAnimationFrame(frame);
  }
}

function defaultAudioContextFactory(): AudioDecoder {
  // Offline decoding has no connection to a speaker or to the media element.
  return new OfflineAudioContext(1, 1, 48000);
}
