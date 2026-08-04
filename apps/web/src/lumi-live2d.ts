import {
  AudioMouthEnvelope,
  type AudioEnvelopeHost,
  type MouthParameterTarget
} from "./lumi-audio.js";
import type { SpeechPlaybackEvent } from "./speech-queue.js";
import {
  loadLumiCubismModel,
  type LumiParameterInfo,
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

/** Central mapping for the Presence-owned gaze, head, and body channels. */
export const LUMI_PRESENCE_PARAMETER_MAP = {
  eyeBallX: { id: "ParamEyeBallX", min: -1, max: 1, neutral: 0 },
  eyeBallY: { id: "ParamEyeBallY", min: -1, max: 1, neutral: 0 },
  headAngleX: { id: "ParamAngleX", min: -30, max: 30, neutral: 0 },
  headAngleY: { id: "ParamAngleY", min: -30, max: 30, neutral: 0 },
  headAngleZ: { id: "ParamAngleZ", min: -30, max: 30, neutral: 0 },
  bodyAngleX: { id: "ParamBodyAngleX", min: -30, max: 30, neutral: 0 },
  bodyAngleY: { id: "ParamBodyAngleY", min: -30, max: 30, neutral: 0 },
  bodyAngleZ: { id: "ParamBodyAngleZ", min: -30, max: 30, neutral: 0 }
} as const;

export type LumiPresenceAnimation = {
  blink?: number;
  breath?: number;
  eyeBallX?: number;
  eyeBallY?: number;
  headAngleX?: number;
  headAngleY?: number;
  headAngleZ?: number;
  bodyAngleX?: number;
  bodyAngleY?: number;
  bodyAngleZ?: number;
};

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
  getPendingParameter?(id: string): number | undefined;
  getParameterInfo?(id: string): LumiParameterInfo | undefined;
  getCoreParameterValue?(id: string): number | undefined;
  getLastPreUpdateParameters?(): Readonly<Record<string, number>>;
  getOwnedParameterIds?(): ReadonlySet<string>;
  setBreath(value: number): void;
  setFraming(framing: LumiFraming): void;
  getFraming?(): LumiFraming;
  getFramingDiagnostics?(): import("./lumi-framing.js").LumiFramingDiagnostics | null;
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

  getPendingParameter(id: string): number | undefined {
    return this.model?.getPendingParameter(id);
  }

  getParameterInfo(id: string): LumiParameterInfo | undefined {
    return this.model?.getParameterInfo?.(id);
  }

  getCoreParameterValue(id: string): number | undefined {
    return this.model?.getCoreParameterValue?.(id);
  }

  getLastPreUpdateParameters(): Readonly<Record<string, number>> {
    return this.model?.getLastPreUpdateParameters?.() ?? {};
  }

  getOwnedParameterIds(): ReadonlySet<string> {
    return this.model?.parameterIds ?? new Set();
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

  getFraming(): LumiFraming {
    return this.model?.getFraming() ?? "half";
  }

  getFramingDiagnostics(): import("./lumi-framing.js").LumiFramingDiagnostics | null {
    return this.model?.getFramingDiagnostics() ?? null;
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
  setPresenceAnimation(animation: LumiPresenceAnimation): void;
  setPresenceAnimation(blink: number, breath: number): void;
  resumeAudio(): void;
  handlePlaybackEvent(event: SpeechPlaybackEvent): void;
  resize(width: number, height: number): void;
  dispose(): void;
  getPresence(): PresenceState;
  getFramingDiagnostics(): import("./lumi-framing.js").LumiFramingDiagnostics | null;
  getDebugInfo(): {
    instanceId: number;
    generation: number;
    pendingEyeLeft?: number;
    pendingEyeRight?: number;
    pendingBreath?: number;
    pendingMouth?: number;
    pendingEyeBallX?: number;
    pendingEyeBallY?: number;
    pendingHeadAngleX?: number;
    pendingHeadAngleY?: number;
    pendingHeadAngleZ?: number;
    pendingBodyAngleX?: number;
    pendingBodyAngleY?: number;
    pendingBodyAngleZ?: number;
    preUpdateEyeBallX?: number;
    preUpdateEyeBallY?: number;
    preUpdateAngleX?: number;
    preUpdateAngleY?: number;
    preUpdateAngleZ?: number;
    preUpdateBodyAngleX?: number;
    preUpdateBodyAngleY?: number;
    preUpdateBodyAngleZ?: number;
    preUpdateEyeBallPhysicsX?: number;
    preUpdateEyeBallPhysicsY?: number;
    ownedParameterIds?: string[];
  };
};

let nextLumiControllerInstanceId = 1;

export class LumiController {
  private readonly instanceId = nextLumiControllerInstanceId++;
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

  setPresenceAnimation(animation: LumiPresenceAnimation): void;
  setPresenceAnimation(blink: number, breath: number): void;
  setPresenceAnimation(
    animationOrBlink: LumiPresenceAnimation | number,
    positionalBreath?: number
  ): void {
    if (!this.adapter) return;
    const animation: LumiPresenceAnimation =
      typeof animationOrBlink === "number"
        ? positionalBreath === undefined
          ? { blink: animationOrBlink }
          : { blink: animationOrBlink, breath: positionalBreath }
        : animationOrBlink;
    // Presence owns only eyes and breath. ParamMouthOpenY remains exclusively
    // driven by the active AudioMouthEnvelope while playback is speaking.
    if (animation.blink !== undefined) {
      const eyeOpen = 1 - clamp(animation.blink, 0, 1);
      this.adapter.setParameter(lumiMapping.eyeLeft, eyeOpen);
      this.adapter.setParameter(lumiMapping.eyeRight, eyeOpen);
    }
    if (animation.breath !== undefined) this.adapter.setBreath(clamp(animation.breath, 0, 1));
    this.setOwnedParameter("eyeBallX", animation.eyeBallX);
    this.setOwnedParameter("eyeBallY", animation.eyeBallY);
    this.setOwnedParameter("headAngleX", animation.headAngleX);
    this.setOwnedParameter("headAngleY", animation.headAngleY);
    this.setOwnedParameter("headAngleZ", animation.headAngleZ);
    this.setOwnedParameter("bodyAngleX", animation.bodyAngleX);
    this.setOwnedParameter("bodyAngleY", animation.bodyAngleY);
    this.setOwnedParameter("bodyAngleZ", animation.bodyAngleZ);
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

  getFramingDiagnostics(): import("./lumi-framing.js").LumiFramingDiagnostics | null {
    return this.adapter?.getFramingDiagnostics?.() ?? null;
  }

  dispose(): void {
    this.generation += 1;
    this.setPresenceAnimation({
      blink: 0,
      breath: 0,
      eyeBallX: 0,
      eyeBallY: 0,
      headAngleX: 0,
      headAngleY: 0,
      headAngleZ: 0,
      bodyAngleX: 0,
      bodyAngleY: 0,
      bodyAngleZ: 0
    });
    this.adapter?.resetMouth();
    this.envelope?.dispose();
    this.envelope = null;
    this.adapter?.dispose();
    this.adapter = null;
  }

  getPresence(): PresenceState {
    return this.state;
  }

  getDebugInfo(): {
    instanceId: number;
    generation: number;
    pendingEyeLeft?: number;
    pendingEyeRight?: number;
    pendingBreath?: number;
    pendingMouth?: number;
    pendingEyeBallX?: number;
    pendingEyeBallY?: number;
    pendingHeadAngleX?: number;
    pendingHeadAngleY?: number;
    pendingHeadAngleZ?: number;
    pendingBodyAngleX?: number;
    pendingBodyAngleY?: number;
    pendingBodyAngleZ?: number;
    preUpdateEyeBallX?: number;
    preUpdateEyeBallY?: number;
    preUpdateAngleX?: number;
    preUpdateAngleY?: number;
    preUpdateAngleZ?: number;
    preUpdateBodyAngleX?: number;
    preUpdateBodyAngleY?: number;
    preUpdateBodyAngleZ?: number;
    preUpdateEyeBallPhysicsX?: number;
    preUpdateEyeBallPhysicsY?: number;
    ownedParameterIds?: string[];
  } {
    const info: {
      instanceId: number;
      generation: number;
      pendingEyeLeft?: number;
      pendingEyeRight?: number;
      pendingBreath?: number;
      pendingMouth?: number;
      pendingEyeBallX?: number;
      pendingEyeBallY?: number;
      pendingHeadAngleX?: number;
      pendingHeadAngleY?: number;
      pendingHeadAngleZ?: number;
      pendingBodyAngleX?: number;
      pendingBodyAngleY?: number;
      pendingBodyAngleZ?: number;
      preUpdateEyeBallX?: number;
      preUpdateEyeBallY?: number;
      preUpdateAngleX?: number;
      preUpdateAngleY?: number;
      preUpdateAngleZ?: number;
      preUpdateBodyAngleX?: number;
      preUpdateBodyAngleY?: number;
      preUpdateBodyAngleZ?: number;
      preUpdateEyeBallPhysicsX?: number;
      preUpdateEyeBallPhysicsY?: number;
      ownedParameterIds?: string[];
    } = {
      instanceId: this.instanceId,
      generation: this.generation
    };
    const eyeLeft = this.adapter?.getPendingParameter?.(lumiMapping.eyeLeft);
    const eyeRight = this.adapter?.getPendingParameter?.(lumiMapping.eyeRight);
    const breath = this.adapter?.getPendingParameter?.(lumiMapping.breath.id);
    const mouth = this.adapter?.getPendingParameter?.(lumiMapping.mouthOpen.id);
    if (eyeLeft !== undefined) info.pendingEyeLeft = eyeLeft;
    if (eyeRight !== undefined) info.pendingEyeRight = eyeRight;
    if (breath !== undefined) info.pendingBreath = breath;
    if (mouth !== undefined) info.pendingMouth = mouth;
    const eyeBallX = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.eyeBallX.id);
    const eyeBallY = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.eyeBallY.id);
    const headAngleX = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.headAngleX.id);
    const headAngleY = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.headAngleY.id);
    const headAngleZ = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.headAngleZ.id);
    const bodyAngleX = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.bodyAngleX.id);
    const bodyAngleY = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.bodyAngleY.id);
    const bodyAngleZ = this.adapter?.getPendingParameter?.(LUMI_PRESENCE_PARAMETER_MAP.bodyAngleZ.id);
    if (eyeBallX !== undefined) info.pendingEyeBallX = eyeBallX;
    if (eyeBallY !== undefined) info.pendingEyeBallY = eyeBallY;
    if (headAngleX !== undefined) info.pendingHeadAngleX = headAngleX;
    if (headAngleY !== undefined) info.pendingHeadAngleY = headAngleY;
    if (headAngleZ !== undefined) info.pendingHeadAngleZ = headAngleZ;
    if (bodyAngleX !== undefined) info.pendingBodyAngleX = bodyAngleX;
    if (bodyAngleY !== undefined) info.pendingBodyAngleY = bodyAngleY;
    if (bodyAngleZ !== undefined) info.pendingBodyAngleZ = bodyAngleZ;
    const preUpdate = this.adapter?.getLastPreUpdateParameters?.() ?? {};
    if (preUpdate["ParamEyeBallX"] !== undefined) info.preUpdateEyeBallX = preUpdate["ParamEyeBallX"];
    if (preUpdate["ParamEyeBallY"] !== undefined) info.preUpdateEyeBallY = preUpdate["ParamEyeBallY"];
    if (preUpdate["ParamAngleX"] !== undefined) info.preUpdateAngleX = preUpdate["ParamAngleX"];
    if (preUpdate["ParamAngleY"] !== undefined) info.preUpdateAngleY = preUpdate["ParamAngleY"];
    if (preUpdate["ParamAngleZ"] !== undefined) info.preUpdateAngleZ = preUpdate["ParamAngleZ"];
    if (preUpdate["ParamBodyAngleX"] !== undefined) info.preUpdateBodyAngleX = preUpdate["ParamBodyAngleX"];
    if (preUpdate["ParamBodyAngleY"] !== undefined) info.preUpdateBodyAngleY = preUpdate["ParamBodyAngleY"];
    if (preUpdate["ParamBodyAngleZ"] !== undefined) info.preUpdateBodyAngleZ = preUpdate["ParamBodyAngleZ"];
    if (preUpdate["ParamEyeBallPhysicsX"] !== undefined) {
      info.preUpdateEyeBallPhysicsX = preUpdate["ParamEyeBallPhysicsX"];
    }
    if (preUpdate["ParamEyeBallPhysicsY"] !== undefined) {
      info.preUpdateEyeBallPhysicsY = preUpdate["ParamEyeBallPhysicsY"];
    }
    const owned = this.adapter?.getOwnedParameterIds?.();
    if (owned) info.ownedParameterIds = [...owned];
    return info;
  }

  private setOwnedParameter(
    key: keyof typeof LUMI_PRESENCE_PARAMETER_MAP,
    value: number | undefined
  ): void {
    if (value === undefined || !this.adapter) return;
    const configured = LUMI_PRESENCE_PARAMETER_MAP[key];
    const actual = this.adapter.getParameterInfo?.(configured.id);
    // A real Cubism adapter exposes the model's parameter table. Missing
    // optional gaze/head channels are a supported degradation; do not stage a
    // value for an ID the model does not actually contain.
    if (this.adapter.getParameterInfo && !actual) return;
    this.adapter.setParameter(
      configured.id,
      clamp(value, actual?.min ?? configured.min, actual?.max ?? configured.max)
    );
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
