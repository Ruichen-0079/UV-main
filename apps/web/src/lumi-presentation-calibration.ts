/** Lumi-only tuning. Coordinates never cross the semantic Presentation boundary. */
export const LUMI_PRESENTATION_CALIBRATION = Object.freeze({
  smile: 1,
  attackMs: 180,
  holdMs: 2400,
  fadeMs: 650,
  settleMs: 220,
  gazeHoldMs: 2400,
  gazeSettleMs: 6000,
  interruptMs: 75,
  intensity: { low: 0.35, medium: 0.7, high: 1.25 },
  idleX: 0.016,
  idleY: 0.009,
  swayX: 0.105,
  bounceY: 0.14,
  speakingX: 0.032,
  speakingY: 0.012,
  maxX: 0.16,
  maxY: 0.14,
  headroomScale: 0.82,
  headAngle: 26,
  bodyAngle: 18
});

/** Composable expression coefficients, not animation clips. Intensity is renderer-local. */
export const LUMI_EXPRESSION_PROFILES = {
  neutral: { intensity: "low", smile: 0, sway: 0, bounce: 0, tilt: 0, lift: 0 },
  "soft-smile": { intensity: "low", smile: 1, sway: 0.45, bounce: 0, tilt: 0.2, lift: 0.15 },
  attentive: { intensity: "medium", smile: 0.1, sway: 0.15, bounce: 0, tilt: 0, lift: 0.5 },
  thinking: { intensity: "medium", smile: 0, sway: 0.5, bounce: 0, tilt: -0.65, lift: -0.25 },
  amused: { intensity: "high", smile: 1, sway: 1, bounce: 0.5, tilt: 0.5, lift: 0.2 },
  excited: { intensity: "high", smile: 1, sway: 0.75, bounce: 1, tilt: -0.25, lift: 0.6 },
  "acknowledge-interrupt": {
    intensity: "low",
    smile: 0,
    sway: 0,
    bounce: 0,
    tilt: -0.2,
    lift: -0.4
  }
} as const;
export type LumiExpression = keyof typeof LUMI_EXPRESSION_PROFILES;
export function isLumiExpression(intent: string): intent is LumiExpression {
  return Object.hasOwn(LUMI_EXPRESSION_PROFILES, intent);
}
export function bounded(value: number, limit: number): number {
  return Number.isFinite(value) ? Math.max(-limit, Math.min(limit, value)) : 0;
}
