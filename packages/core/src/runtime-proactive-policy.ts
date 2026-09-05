import type { CharacterProactiveProposal } from "@companion/character-abi";

/**
 * Runtime-owned proactive policy. Character proposes; this module authorizes
 * and applies. Operational timer handles are not part of this state.
 */
export const PROACTIVE_CONTROL_AUTHORITIES = ["LOCAL_EXPLICIT_CONTROLLER", "UNTRUSTED"] as const;
export type ProactiveControlAuthority = (typeof PROACTIVE_CONTROL_AUTHORITIES)[number];

export const PROACTIVE_ADMISSION_REASONS = [
  "consent-disabled",
  "suppressed",
  "not-eligible",
  "stale-revision"
] as const;
export type ProactiveAdmissionReason = (typeof PROACTIVE_ADMISSION_REASONS)[number];

export const PROACTIVE_DEFER_HORIZON_MS = {
  SHORT: 30_000,
  NORMAL: 120_000,
  LONG: 600_000
} as const;

/** Deterministic quiet after a NO_OP so the scheduler cannot hot-loop tokens. */
export const PROACTIVE_NO_OP_BACKOFF_MS = PROACTIVE_DEFER_HORIZON_MS.SHORT;
/** Quiet after a committed proactive emit. */
export const PROACTIVE_EMIT_QUIET_MS = PROACTIVE_DEFER_HORIZON_MS.NORMAL;

export type ProactiveSuppression =
  | { readonly kind: "NONE" }
  | { readonly kind: "UNTIL"; readonly untilMs: number }
  | { readonly kind: "UNTIL_ENGAGEMENT" }
  | { readonly kind: "UNTIL_EXPLICIT_RESUME" };

export type ProactiveState = Readonly<{
  suppression: ProactiveSuppression;
  eligibleAfterMs: number;
  activityRevision: number;
}>;

export type ProactiveEligibility =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: ProactiveAdmissionReason };

export type ProactivePolicySnapshot = Readonly<{
  version: 1;
  suppression: ProactiveSuppression;
  eligibleAfterMs: number;
  consentEnabled?: boolean;
}>;

export type RuntimeProactiveStateStore = {
  load(): ProactivePolicySnapshot | null;
  save(snapshot: ProactivePolicySnapshot): void;
};

export function createInitialProactiveState(): ProactiveState {
  return Object.freeze({
    suppression: Object.freeze({ kind: "NONE" as const }),
    eligibleAfterMs: 0,
    activityRevision: 0
  });
}

export function canMutateDurableProactivePolicy(authority: ProactiveControlAuthority): boolean {
  return authority === "LOCAL_EXPLICIT_CONTROLLER";
}

export function isAuthorizedExplicitEngagement(authority: ProactiveControlAuthority): boolean {
  return authority === "LOCAL_EXPLICIT_CONTROLLER";
}

export function normalizeProactiveState(state: ProactiveState, nowMs: number): ProactiveState {
  if (state.suppression.kind !== "UNTIL" || nowMs < state.suppression.untilMs) {
    return state;
  }
  return Object.freeze({
    ...state,
    suppression: Object.freeze({ kind: "NONE" as const })
  });
}

export function isProactiveSuppressionActive(state: ProactiveState, nowMs: number): boolean {
  const normalized = normalizeProactiveState(state, nowMs);
  return normalized.suppression.kind !== "NONE";
}

export function evaluateProactiveEligibility(
  state: ProactiveState,
  nowMs: number,
  consentEnabled: boolean | undefined
): ProactiveEligibility {
  if (consentEnabled === false) {
    return { admitted: false, reason: "consent-disabled" };
  }
  const normalized = normalizeProactiveState(state, nowMs);
  if (normalized.suppression.kind !== "NONE") {
    return { admitted: false, reason: "suppressed" };
  }
  if (nowMs < normalized.eligibleAfterMs) {
    return { admitted: false, reason: "not-eligible" };
  }
  return { admitted: true };
}

export function advanceActivityRevision(state: ProactiveState): ProactiveState {
  return Object.freeze({
    ...state,
    activityRevision: state.activityRevision + 1
  });
}

export function deferProactiveEligibility(
  state: ProactiveState,
  nowMs: number,
  delayMs: number
): ProactiveState {
  const normalized = normalizeProactiveState(state, nowMs);
  const dueAtMs = nowMs + delayMs;
  return Object.freeze({
    ...normalized,
    eligibleAfterMs: Math.max(normalized.eligibleAfterMs, dueAtMs)
  });
}

export function applyAuthorizedEngagement(
  state: ProactiveState,
  nowMs: number,
  authority: ProactiveControlAuthority
): ProactiveState {
  const normalized = normalizeProactiveState(state, nowMs);
  if (normalized.suppression.kind !== "UNTIL_ENGAGEMENT") {
    return normalized;
  }
  if (!isAuthorizedExplicitEngagement(authority)) {
    return normalized;
  }
  return Object.freeze({
    ...normalized,
    suppression: Object.freeze({ kind: "NONE" as const })
  });
}

export function applyCharacterProactiveProposal(
  state: ProactiveState,
  proposal: CharacterProactiveProposal,
  nowMs: number,
  authority: ProactiveControlAuthority
): ProactiveState {
  const normalized = normalizeProactiveState(state, nowMs);
  if (!canMutateDurableProactivePolicy(authority)) {
    return normalized;
  }
  switch (proposal.action) {
    case "KEEP":
      return normalized;
    case "CLEAR":
      return Object.freeze({
        ...normalized,
        suppression: Object.freeze({ kind: "NONE" as const })
      });
    case "DEFER": {
      const dueAtMs = nowMs + PROACTIVE_DEFER_HORIZON_MS[proposal.horizon];
      return Object.freeze({
        ...normalized,
        eligibleAfterMs: Math.max(normalized.eligibleAfterMs, dueAtMs)
      });
    }
    case "SUPPRESS":
      return Object.freeze({
        ...normalized,
        suppression: suppressionFromProposal(proposal.scope, nowMs)
      });
  }
}

export function parseProactivePolicySnapshot(
  input: unknown,
  nowMs: number
): { state: ProactiveState; consentEnabled?: boolean } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const value = input as Record<string, unknown>;
  if (value["version"] !== 1) {
    return null;
  }
  const suppression = parseSuppression(value["suppression"]);
  if (!suppression) {
    return null;
  }
  const eligibleAfterMs = value["eligibleAfterMs"];
  if (
    typeof eligibleAfterMs !== "number" ||
    !Number.isFinite(eligibleAfterMs) ||
    eligibleAfterMs < 0
  ) {
    return null;
  }
  const consentEnabled =
    typeof value["consentEnabled"] === "boolean" ? value["consentEnabled"] : undefined;
  const state = normalizeProactiveState(
    Object.freeze({
      suppression,
      eligibleAfterMs,
      activityRevision: 0
    }),
    nowMs
  );
  return consentEnabled === undefined ? { state } : { state, consentEnabled };
}

export function serializeProactivePolicySnapshot(
  state: ProactiveState,
  consentEnabled: boolean | undefined
): ProactivePolicySnapshot {
  const snapshot: ProactivePolicySnapshot = {
    version: 1,
    suppression: state.suppression,
    eligibleAfterMs: state.eligibleAfterMs,
    ...(consentEnabled === undefined ? {} : { consentEnabled })
  };
  return snapshot;
}

export function parseIso8601DurationMs(duration: string): number {
  const match = /^P(?!$)(?:(\d+)D)?(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    duration
  );
  if (!match) {
    throw new Error("ISO-8601 duration is invalid.");
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const ms = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error("ISO-8601 duration is invalid.");
  }
  return ms;
}

function suppressionFromProposal(
  scope: Extract<CharacterProactiveProposal, { action: "SUPPRESS" }>["scope"],
  nowMs: number
): ProactiveSuppression {
  switch (scope.kind) {
    case "UNTIL_ENGAGEMENT":
      return Object.freeze({ kind: "UNTIL_ENGAGEMENT" });
    case "UNTIL_EXPLICIT_RESUME":
      return Object.freeze({ kind: "UNTIL_EXPLICIT_RESUME" });
    case "UNTIL": {
      const untilMs =
        scope.time !== undefined
          ? Date.parse(scope.time)
          : nowMs + parseIso8601DurationMs(scope.duration ?? "PT0S");
      if (!Number.isFinite(untilMs)) {
        throw new Error("UNTIL suppression time is invalid.");
      }
      return Object.freeze({ kind: "UNTIL", untilMs });
    }
  }
}

function parseSuppression(input: unknown): ProactiveSuppression | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const value = input as Record<string, unknown>;
  if (value["kind"] === "NONE" && Object.keys(value).length === 1) {
    return Object.freeze({ kind: "NONE" });
  }
  if (value["kind"] === "UNTIL_ENGAGEMENT" && Object.keys(value).length === 1) {
    return Object.freeze({ kind: "UNTIL_ENGAGEMENT" });
  }
  if (value["kind"] === "UNTIL_EXPLICIT_RESUME" && Object.keys(value).length === 1) {
    return Object.freeze({ kind: "UNTIL_EXPLICIT_RESUME" });
  }
  const untilMs = value["untilMs"];
  if (
    value["kind"] === "UNTIL" &&
    typeof untilMs === "number" &&
    Number.isFinite(untilMs) &&
    untilMs >= 0 &&
    Object.keys(value).length === 2
  ) {
    return Object.freeze({ kind: "UNTIL", untilMs });
  }
  return null;
}
