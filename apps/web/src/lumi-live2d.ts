import {
  AudioMouthEnvelope,
  type AudioEnvelopeHost,
  type MouthParameterTarget
} from "./lumi-audio.js";
import type { SpeechPlaybackEvent } from "./speech-queue.js";
import {
  loadLumiCubismModel,
  type LumiCubismModel,
  type LumiFraming
} from "./lumi-cubism-model.js";

export const lumiMapping = {
  mouthOpen: { id: "ParamMouthOpenY", min: 0, max: 2.1 },
  mouthForm: { id: "ParamMouthForm", min: -1, max: 1 },
  breath: { id: "ParamBreath", min: 0, max: 1 },
  eyeLeft: "ParamEyeLOpen",
  eyeRight: "ParamEyeROpen"
} as const;

export type PresenceState = "idle" | "thinking" | "speaking" | "interrupted" | "unavailable";

export type PresenceEvent =
  | { type: "user-sent" }
  | { type: "playback-started" }
  | { type: "playback-ended" }
  | { type: "interrupted" }
  | { type: "model-ready" }
  | { type: "model-failed" };

export function reducePresence(state: PresenceState, event: PresenceEvent): PresenceState {
  switch (event.type) {
    case "model-failed":
      return "unavailable";
    case "model-ready":
      return "idle";
    case "user-sent":
      return state === "unavailable" ? state : "thinking";
    case "playback-started":
      return state === "unavailable" ? state : "speaking";
    case "playback-ended":
      return state === "unavailable" ? state : "idle";
    case "interrupted":
      return state === "unavailable" ? state : "interrupted";
  }
}

export interface Live2DAdapter extends MouthParameterTarget {
  load(source: string): Promise<void>;
  setParameter(id: string, value: number): void;
  setBreath(value: number): void;
  setFraming(framing: LumiFraming): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Official Cubism Framework/WebGL adapter for the Cubism 3 Lumi model. */
export class CubismLive2DAdapter implements Live2DAdapter {
  private model: LumiCubismModel | null = null;
  private disposed = false;
  private frame: number | null = null;
  private previousFrameAt: number | null = null;
  private loadAbort: AbortController | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async load(source: string): Promise<void> {
    if (this.disposed) throw new Error("Live2D adapter is disposed.");
    const loadAbort = new AbortController();
    this.loadAbort = loadAbort;
    const model = await loadLumiCubismModel(this.canvas, source, loadAbort.signal);
    if (this.disposed || loadAbort.signal.aborted) {
      model.dispose();
      throw new Error("Live2D adapter is disposed.");
    }
    this.model = model;
    this.loadAbort = null;
    this.resize(this.canvas.clientWidth || 320, this.canvas.clientHeight || 420);
    this.resetMouth();
    this.startRenderLoop();
  }

  setParameter(id: string, value: number): void {
    this.model?.setParameter(id, value);
  }

  setMouthOpen(value: number): void {
    this.setParameter(
      lumiMapping.mouthOpen.id,
      clamp(value, lumiMapping.mouthOpen.min, lumiMapping.mouthOpen.max)
    );
  }

  setMouthForm(value: number): void {
    this.setParameter(
      lumiMapping.mouthForm.id,
      clamp(value, lumiMapping.mouthForm.min, lumiMapping.mouthForm.max)
    );
  }

  setBreath(value: number): void {
    this.setParameter(
      lumiMapping.breath.id,
      clamp(value, lumiMapping.breath.min, lumiMapping.breath.max)
    );
  }

  setFraming(framing: LumiFraming): void {
    this.model?.setFraming(framing);
  }

  resetMouth(): void {
    this.setMouthOpen(0);
    this.setMouthForm(0);
  }

  resize(width: number, height: number): void {
    this.model?.resize(width, height);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loadAbort?.abort();
    this.loadAbort = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.model?.dispose();
    this.model = null;
  }

  private startRenderLoop(): void {
    const render = (now: number) => {
      if (this.disposed || !this.model) return;
      const delta = this.previousFrameAt === null ? 1 / 60 : (now - this.previousFrameAt) / 1000;
      this.previousFrameAt = now;
      this.model.render(delta);
      this.frame = requestAnimationFrame(render);
    };
    this.frame = requestAnimationFrame(render);
  }
}

export type LumiControllerHandle = {
  load(): Promise<void>;
  runMouthCalibration(): Promise<void>;
  setFraming(framing: LumiFraming): void;
  setPresence(state: PresenceState): void;
  resumeAudio(): void;
  handlePlaybackEvent(event: SpeechPlaybackEvent): void;
  resize(width: number, height: number): void;
  dispose(): void;
  getPresence(): PresenceState;
};

export class LumiController {
  private adapter: Live2DAdapter | null = null;
  private envelope: AudioEnvelopeHost | null = null;
  private state: PresenceState = "unavailable";
  private requestedPresence: PresenceState = "idle";
  private generation = 0;

  constructor(
    private readonly createAdapter: () => Live2DAdapter,
    private readonly source: string,
    private readonly onState?: (state: PresenceState) => void,
    private readonly createEnvelope: (target: MouthParameterTarget) => AudioEnvelopeHost = (
      target
    ) => new AudioMouthEnvelope(target)
  ) {}

  async load(): Promise<void> {
    const generation = ++this.generation;
    const adapter = this.createAdapter();
    this.adapter = adapter;
    try {
      await adapter.load(this.source);
      if (generation !== this.generation) {
        adapter.dispose();
        return;
      }
      this.envelope = this.createEnvelope(adapter);
      adapter.setBreath(0.16);
      adapter.resetMouth();
      this.transition({ type: "model-ready" });
      this.setPresence(this.requestedPresence);
    } catch (error) {
      if (generation !== this.generation) {
        adapter.dispose();
        return;
      }
      if (import.meta.env.DEV && typeof window !== "undefined") {
        console.warn("Lumi model is unavailable.", error);
      }
      adapter.dispose();
      this.adapter = null;
      this.envelope?.dispose();
      this.envelope = null;
      this.transition({ type: "model-failed" });
    }
  }

  setPresence(state: PresenceState): void {
    this.requestedPresence = state;
    // A text response can finish while its first audio segment is still
    // playing. That external idle request must not silence the RMS-driven
    // mouth; playbackEnded remains the authoritative transition to idle.
    if (state === "idle" && this.state === "speaking") return;
    this.applyPresence(state);
  }

  private applyPresence(state: PresenceState): void {
    if (state === "unavailable") {
      this.transition({ type: "model-failed" });
      return;
    }
    if (!this.adapter) return;
    this.setState(state);
    this.adapter.setBreath(state === "idle" || state === "thinking" ? 0.16 : 0);
    if (state !== "speaking") this.adapter.resetMouth();
  }

  handlePlaybackEvent(event: SpeechPlaybackEvent): void {
    if (event.type === "audioElementAttached") {
      this.envelope?.attach(event.audio);
    } else if (event.type === "playbackStarted") {
      this.envelope?.startPlayback?.(event.audio);
      this.setPresence("speaking");
    } else if (event.type === "playbackEnded") {
      this.envelope?.detach();
      this.requestedPresence = "idle";
      this.applyPresence("idle");
    } else if (event.type === "playbackStopped" || event.type === "playbackError") {
      this.envelope?.stop();
      this.transition({ type: "interrupted" });
      this.requestedPresence = "idle";
      this.applyPresence("idle");
    } else if (event.type === "audioElementDetached") {
      this.envelope?.detach();
    }
  }

  resumeAudio(): void {
    this.envelope?.resume?.();
  }

  async runMouthCalibration(): Promise<void> {
    const adapter = this.adapter;
    const generation = this.generation;
    if (!adapter || this.state === "speaking") return;
    for (const value of [0, 1, 2.1, 0]) {
      if (generation !== this.generation || adapter !== this.adapter) return;
      adapter.setMouthOpen(value);
      await pause(700);
    }
    if (generation === this.generation && adapter === this.adapter) adapter.resetMouth();
  }

  resize(width: number, height: number): void {
    this.adapter?.resize(width, height);
  }

  setFraming(framing: LumiFraming): void {
    this.adapter?.setFraming(framing);
  }

  dispose(): void {
    this.generation += 1;
    this.envelope?.dispose();
    this.envelope = null;
    this.adapter?.dispose();
    this.adapter = null;
  }

  getPresence(): PresenceState {
    return this.state;
  }

  private transition(event: PresenceEvent): void {
    this.setState(reducePresence(this.state, event));
  }

  private setState(state: PresenceState): void {
    this.state = state;
    this.onState?.(state);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
