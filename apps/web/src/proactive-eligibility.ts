import type { BehaviorPolicyState } from "./behavior-policy.js";
import type { CompanionPresenceProjection } from "./companion-presence.js";

export const SILENT_ATTENTION_ENABLED = true;
export const SILENT_ATTENTION_IDLE_DELAY_MS = 12_000;
export const SILENT_ATTENTION_TTL_MS = 1_800;
export const SILENT_ATTENTION_COOLDOWN_MS = 30_000;
export const SILENT_ATTENTION_MAX_PER_IDLE_EPISODE = 1;

export type SilentAttentionEligibilityReason =
  | "disabled"
  | "hidden"
  | "invalid-session"
  | "not-idle"
  | "lifecycle-active"
  | "speech-busy"
  | "interrupted"
  | "offline"
  | "live2d-unavailable"
  | "invalid-time"
  | "idle-delay"
  | "cooldown"
  | "idle-budget"
  | "attempted"
  | "policy-busy"
  | "eligible";

export type SilentAttentionEligibilityInput = {
  readonly presence: CompanionPresenceProjection;
  readonly visible: boolean;
  readonly sessionId: string | null;
  readonly policyState: BehaviorPolicyState;
  readonly nowMs: number;
  readonly idleSinceMs: number | null;
  readonly lastSilentAttentionAtMs: number | null;
  readonly consumedThisIdleEpisode: boolean;
  readonly attemptedThisIdleEpisode: boolean;
  readonly enabled: boolean;
};

export type SilentAttentionEligibilityResult = {
  readonly eligible: boolean;
  readonly baseEligible: boolean;
  readonly reason: SilentAttentionEligibilityReason;
  readonly nextCheckAtMs: number | null;
};

function isValidMonotonicTime(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function hasValidSessionId(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isBusySpeech(speech: CompanionPresenceProjection["speech"]): boolean {
  return speech === "queued" || speech === "preparing" || speech === "ready" || speech === "active";
}

export function evaluateSilentAttentionEligibility(
  input: SilentAttentionEligibilityInput
): SilentAttentionEligibilityResult {
  const {
    presence,
    visible,
    sessionId,
    policyState,
    nowMs,
    idleSinceMs,
    lastSilentAttentionAtMs,
    consumedThisIdleEpisode,
    attemptedThisIdleEpisode,
    enabled
  } = input;

  if (!enabled) {
    return { eligible: false, baseEligible: false, reason: "disabled", nextCheckAtMs: null };
  }
  if (!visible) {
    return { eligible: false, baseEligible: false, reason: "hidden", nextCheckAtMs: null };
  }
  if (!hasValidSessionId(sessionId)) {
    return {
      eligible: false,
      baseEligible: false,
      reason: "invalid-session",
      nextCheckAtMs: null
    };
  }
  if (presence.activity !== "idle") {
    return { eligible: false, baseEligible: false, reason: "not-idle", nextCheckAtMs: null };
  }
  if (presence.lifecycle === "active") {
    return {
      eligible: false,
      baseEligible: false,
      reason: "lifecycle-active",
      nextCheckAtMs: null
    };
  }
  if (isBusySpeech(presence.speech)) {
    return { eligible: false, baseEligible: false, reason: "speech-busy", nextCheckAtMs: null };
  }
  if (presence.transition !== "none") {
    return { eligible: false, baseEligible: false, reason: "interrupted", nextCheckAtMs: null };
  }
  if (presence.connectivity !== "online") {
    return { eligible: false, baseEligible: false, reason: "offline", nextCheckAtMs: null };
  }
  if (presence.capabilities.live2d !== "available") {
    return {
      eligible: false,
      baseEligible: false,
      reason: "live2d-unavailable",
      nextCheckAtMs: null
    };
  }

  const baseEligible = true;
  if (!isValidMonotonicTime(nowMs)) {
    return { eligible: false, baseEligible, reason: "invalid-time", nextCheckAtMs: null };
  }

  if (consumedThisIdleEpisode) {
    return {
      eligible: false,
      baseEligible,
      reason: "idle-budget",
      nextCheckAtMs: null
    };
  }
  if (attemptedThisIdleEpisode) {
    return { eligible: false, baseEligible, reason: "attempted", nextCheckAtMs: null };
  }

  const idleDueAtMs =
    idleSinceMs !== null && isValidMonotonicTime(idleSinceMs)
      ? idleSinceMs + SILENT_ATTENTION_IDLE_DELAY_MS
      : nowMs + SILENT_ATTENTION_IDLE_DELAY_MS;
  const cooldownDueAtMs =
    lastSilentAttentionAtMs !== null && isValidMonotonicTime(lastSilentAttentionAtMs)
      ? lastSilentAttentionAtMs + SILENT_ATTENTION_COOLDOWN_MS
      : nowMs;
  const nextTemporalDueAtMs = Math.max(idleDueAtMs, cooldownDueAtMs);

  if (nowMs < idleDueAtMs || nowMs < cooldownDueAtMs) {
    return {
      eligible: false,
      baseEligible,
      reason: nowMs < idleDueAtMs ? "idle-delay" : "cooldown",
      nextCheckAtMs: Number.isFinite(nextTemporalDueAtMs) ? nextTemporalDueAtMs : null
    };
  }
  if (policyState.active.kind !== "none") {
    return { eligible: false, baseEligible, reason: "policy-busy", nextCheckAtMs: null };
  }

  return { eligible: true, baseEligible, reason: "eligible", nextCheckAtMs: null };
}
