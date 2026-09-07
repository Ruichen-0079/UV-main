import type {
  EmbodiedPresentationRequest,
  EmbodiedPresentationOutcomeReport
} from "@companion/protocol";
import type { CompanionPresentationState } from "./companion-presence.js";
import type { LumiPresenceAnimation } from "./lumi-live2d.js";
import {
  bounded,
  LUMI_PRESENTATION_CALIBRATION as C,
  LUMI_EXPRESSION_PROFILES,
  type LumiExpression
} from "./lumi-presentation-calibration.js";

type Effect = { request: EmbodiedPresentationRequest; intent: LumiExpression; startedAt: number };
/** Render-local envelope only. Runtime still accepts observations and owns effect lifecycle. */
export class LumiPresentationMotion {
  private effect: Effect | null = null;
  private offsets = { x: 0, y: 0, tilt: 0, lift: 0, smile: 0 };
  constructor(
    private readonly report: (report: EmbodiedPresentationOutcomeReport) => void = () => {}
  ) {}

  replace(request: EmbodiedPresentationRequest, intent: LumiExpression, now: number): void {
    this.finish("INTERRUPTED");
    this.effect = { request, intent, startedAt: now };
  }
  clear(): void {
    this.finish("INTERRUPTED");
    this.resetOffsets();
  }
  resetOffsets(): void {
    this.offsets = { x: 0, y: 0, tilt: 0, lift: 0, smile: 0 };
  }
  sample(
    base: LumiPresenceAnimation,
    state: CompanionPresentationState,
    now: number,
    delta: number
  ): LumiPresenceAnimation {
    now = Number.isFinite(now) ? Math.max(0, now) : 0;
    delta = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    const t = now / 1000;
    const interrupted = state === "interrupted";
    if (interrupted) this.finish("INTERRUPTED");
    const effect = this.effect;
    const age = effect ? Math.max(0, now - effect.startedAt) : 0;
    const duration = C.attackMs + C.holdMs + C.fadeMs;
    const envelope = effect
      ? Math.min(1, age / C.attackMs) * Math.max(0, Math.min(1, (duration - age) / C.fadeMs))
      : 0;
    const profile = LUMI_EXPRESSION_PROFILES[effect?.intent ?? "neutral"];
    const strength = C.intensity[profile.intensity] * envelope;
    // Incommensurate waves provide deterministic asymmetric drift, never integrated position.
    const drift = (Math.sin(t * 1.31) + 0.36 * Math.sin(t * 2.17 + 0.8)) / 1.36;
    const expressivePhase = age / 1000;
    const sway = (Math.sin(expressivePhase * 5.1) + 0.27 * Math.sin(expressivePhase * 8.3)) / 1.27;
    const bounce = Math.max(0, Math.sin(expressivePhase * 6.8)) * Math.exp(-expressivePhase * 0.6);
    const speaking = state === "speaking";
    const thinking = state === "thinking";
    const attentive = state === "listening";
    const target = {
      x: interrupted
        ? 0
        : C.idleX * drift * (thinking ? 2 : 1) +
          strength * C.swayX * profile.sway * sway +
          (speaking ? C.speakingX * Math.sin(t * 3.7) : 0),
      y: interrupted
        ? 0
        : C.idleY * Math.sin(t * 1.7) +
          strength * C.bounceY * profile.bounce * bounce +
          (speaking ? C.speakingY * Math.sin(t * 4.3) : attentive ? 0.014 : 0),
      tilt: interrupted ? 0 : strength * profile.tilt * 12 + (thinking ? -3 + drift * 3 : 0),
      lift: interrupted ? 0 : strength * profile.lift * 10 + (attentive ? 4 : 0),
      smile: interrupted ? 0 : profile.smile * C.smile * envelope
    };
    const alpha =
      1 - Math.exp(-Math.max(0, Math.min(100, delta)) / (interrupted ? C.interruptMs : C.settleMs));
    for (const key of Object.keys(target) as (keyof typeof target)[]) {
      this.offsets[key] += (target[key] - this.offsets[key]) * alpha;
      if (Math.abs(this.offsets[key] - target[key]) < 0.00001) this.offsets[key] = target[key];
    }
    if (effect && age >= duration + C.settleMs * 12) {
      this.offsets.smile = 0;
      this.finish("COMPLETED");
    }
    const o = this.offsets;
    return {
      ...base,
      mouthForm: bounded(o.smile, 1),
      translateX: bounded(o.x, C.maxX),
      translateY: bounded(o.y, C.maxY),
      headAngleX: bounded((base.headAngleX ?? 0) + o.x * 85, C.headAngle),
      headAngleY: bounded((base.headAngleY ?? 0) + o.lift + o.y * 70, C.headAngle),
      headAngleZ: bounded((base.headAngleZ ?? 0) + o.tilt - o.x * 35, C.headAngle),
      bodyAngleX: bounded((base.bodyAngleX ?? 0) + o.x * 65, C.bodyAngle),
      bodyAngleY: bounded((base.bodyAngleY ?? 0) + o.y * 45, C.bodyAngle),
      bodyAngleZ: bounded((base.bodyAngleZ ?? 0) + o.tilt * 0.4 - o.x * 25, C.bodyAngle),
      eyeBallX: bounded(base.eyeBallX ?? 0, 1),
      eyeBallY: bounded(base.eyeBallY ?? 0, 1)
    };
  }
  private finish(outcome: "INTERRUPTED" | "COMPLETED"): void {
    const effect = this.effect;
    this.effect = null; // Clear before reporting; reentrant/late work cannot restore it.
    if (effect)
      this.report({
        version: "embodied-presentation-outcome-7k.v1",
        effectId: effect.request.effectId,
        outcome
      });
  }
}
