import type { CompanionPresenceProjection } from "./companion-presence.js";

export type BehaviorIntentScope = "turn" | "session" | "resource" | "decision";

export type BehaviorIntentKind = "attention" | "gaze" | "reaction" | "proactive" | "none";

export type BehaviorIntentSource =
  | "lifecycle"
  | "capability"
  | "idle-policy"
  | "user-interaction"
  | "external";

export type BehaviorIntentReason =
  | "user-gesture"
  | "listening-entry"
  | "turn-start"
  | "thinking"
  | "speech-active"
  | "interrupt-acknowledgement"
  | "lifecycle-reaction"
  | "capability-gate"
  | "silent-attention"
  | "proactive-candidate"
  | "external-command";

export type BehaviorPriority = "P0" | "P1" | "P2" | "P3" | "P4";
export type NonNoneBehaviorPriority = Exclude<BehaviorPriority, "P4">;

export type SemanticGazeTarget =
  | "user"
  | "away-left"
  | "away-right"
  | "down-thoughtful"
  | "recenter"
  | "none";

export type BehaviorSemanticStrength = 0 | 1 | 2;

export type BehaviorReactionType =
  | "acknowledge-interrupt"
  | "engage-user"
  | "avert-think"
  | "capability-suppress";

export type BehaviorProactiveAction =
  | "silent-attention"
  | "request-turn-text"
  | "request-turn-speech"
  | "none";

export type BehaviorProactiveModality = "silent" | "text" | "speech" | "none";

export type BehaviorAttentionPayload = {
  readonly target: SemanticGazeTarget;
  readonly strength: BehaviorSemanticStrength;
};

export type BehaviorGazePayload = {
  readonly target: SemanticGazeTarget;
  readonly strength: BehaviorSemanticStrength;
};

export type BehaviorReactionPayload = {
  readonly reaction: BehaviorReactionType;
  readonly intensity: BehaviorSemanticStrength;
};

export type BehaviorProactivePayload = {
  readonly action: BehaviorProactiveAction;
  readonly modality: BehaviorProactiveModality;
};

type BehaviorIntentScopeFields =
  | {
      readonly scope: "turn";
      readonly epoch: string;
    }
  | {
      readonly scope: "session";
      readonly sessionId: string;
    }
  | {
      readonly scope: "resource";
      readonly resourceId: string;
      /** Optional only because no authoritative generation exists in P6-A. */
      readonly resourceGeneration?: string;
    }
  | {
      readonly scope: "decision";
      readonly decisionId: string;
    };

type BehaviorIntentMetadata = {
  readonly intentId: string;
  readonly source: BehaviorIntentSource;
  readonly reason: BehaviorIntentReason;
  /** Diagnostic copy of the centrally derived priority; admission validates it. */
  readonly priority: NonNoneBehaviorPriority;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
};

export type BehaviorSemanticIntent =
  | (BehaviorIntentMetadata &
      BehaviorIntentScopeFields & {
        readonly kind: "attention";
        readonly payload: BehaviorAttentionPayload;
      })
  | (BehaviorIntentMetadata &
      BehaviorIntentScopeFields & {
        readonly kind: "gaze";
        readonly payload: BehaviorGazePayload;
      })
  | (BehaviorIntentMetadata &
      BehaviorIntentScopeFields & {
        readonly kind: "reaction";
        readonly payload: BehaviorReactionPayload;
      })
  | (BehaviorIntentMetadata &
      BehaviorIntentScopeFields & {
        readonly kind: "proactive";
        readonly payload: BehaviorProactivePayload;
      });

export type BehaviorNoneIntent = {
  readonly kind: "none";
};

export type BehaviorIntent = BehaviorNoneIntent | BehaviorSemanticIntent;

export type BehaviorIntentRef = {
  readonly intentId: string;
  readonly createdAtMs: number;
};

export type BehaviorPolicyContext = {
  readonly presence: CompanionPresenceProjection;
  readonly sessionId: string | null;
  /** The only authoritative monotonic time for a reduction. */
  readonly nowMs: number;
};

export type BehaviorPolicyState = {
  readonly active: BehaviorIntent;
};

export type BehaviorPolicyEvent =
  | {
      readonly type: "submit-intent";
      readonly intent: BehaviorSemanticIntent;
    }
  | {
      /** Identity-bound release for an expiry/timer callback. */
      readonly type: "release-intent";
      readonly intentRef: BehaviorIntentRef;
    }
  | {
      /** Identity-bound cancellation of one exact active intent instance. */
      readonly type: "cancel-intent";
      readonly intentRef: BehaviorIntentRef;
    }
  | {
      /** Identity-bound clock notification; context.nowMs supplies the time. */
      readonly type: "clock-tick";
      readonly intentRef: BehaviorIntentRef;
    }
  | {
      /** Explicit whole-arbiter reset. RESET IS NOT FOR TIMER EXPIRY. */
      readonly type: "reset";
    };

export const NONE_BEHAVIOR_INTENT: BehaviorNoneIntent = { kind: "none" };

export function createInitialBehaviorPolicyState(): BehaviorPolicyState {
  return { active: NONE_BEHAVIOR_INTENT };
}

export function getBehaviorIntentRef(intent: BehaviorSemanticIntent): BehaviorIntentRef {
  return { intentId: intent.intentId, createdAtMs: intent.createdAtMs };
}

/**
 * Derive priority from the semantic policy category, never from caller priority.
 * The priority field on an intent is admitted only when it matches this result.
 */
export function deriveBehaviorPriority(
  intent: BehaviorSemanticIntent
): NonNoneBehaviorPriority | null {
  switch (intent.kind) {
    case "reaction":
      return isReactionCategory(intent.source, intent.reason) ? "P2" : null;
    case "proactive":
      return isProactiveCategory(intent.source, intent.reason) ? "P3" : null;
    case "attention":
    case "gaze":
      if (isUserInteractionCategory(intent.source, intent.reason)) return "P0";
      if (isActiveTaskCategory(intent.source, intent.reason)) return "P1";
      if (isAmbientCategory(intent.source, intent.reason)) return "P3";
      return null;
  }
}

export function getBehaviorPriority(intent: BehaviorIntent): BehaviorPriority {
  if (intent.kind === "none") return "P4";
  return deriveBehaviorPriority(intent) ?? "P4";
}

/** Explicit rank: a smaller P-number has greater authority. */
export function compareBehaviorPriority(left: BehaviorPriority, right: BehaviorPriority): number {
  return priorityRank(left) - priorityRank(right);
}

export function reduceBehaviorPolicy(
  state: BehaviorPolicyState,
  event: BehaviorPolicyEvent,
  context: BehaviorPolicyContext
): BehaviorPolicyState {
  if (isRecord(event) && event["type"] === "reset") {
    return createInitialBehaviorPolicyState();
  }

  if (!isValidPolicyContext(context)) {
    return createInitialBehaviorPolicyState();
  }

  // Reconcile before interpreting every event so stale state cannot block a
  // current candidate, and malformed events cannot keep invalid state alive.
  const current = reconcileActive(state, context);
  if (!isRecord(event)) return current;

  switch (event["type"]) {
    case "submit-intent": {
      const admitted = admitIntent(event["intent"], context);
      if (admitted === null) return current;
      if (current.active.kind === "none") return { active: admitted };

      // The pair is the exact immutable instance identity. It cannot be
      // silently reused for a different active semantic intent.
      if (sameIntentRef(current.active, getBehaviorIntentRef(admitted))) return current;

      const priorityComparison = compareBehaviorPriority(
        getBehaviorPriority(admitted),
        getBehaviorPriority(current.active)
      );
      if (priorityComparison < 0) return { active: admitted };
      if (priorityComparison === 0 && admitted.createdAtMs > current.active.createdAtMs) {
        return { active: admitted };
      }
      return current;
    }
    case "release-intent":
    case "cancel-intent":
      return targetsActive(current.active, event["intentRef"])
        ? createInitialBehaviorPolicyState()
        : current;
    case "clock-tick":
      // Expiry has already been reconciled against the one authoritative clock
      // above. A tick is only an identity-safe notification, never a second clock.
      if (!isValidBehaviorIntentRef(event["intentRef"])) return current;
      if (!targetsActive(current.active, event["intentRef"])) return current;
      return current;
    default:
      return current;
  }
}

function admitIntent(
  intent: unknown,
  context: BehaviorPolicyContext
): BehaviorSemanticIntent | null {
  if (!isValidBehaviorSemanticIntent(intent)) return null;
  if (intent.createdAtMs > context.nowMs || context.nowMs >= intent.expiresAtMs) {
    return null;
  }
  if (!isCurrentCorrelation(intent, context)) return null;
  if (isVisualIntent(intent) && context.presence.capabilities.live2d !== "available") {
    return null;
  }
  return intent;
}

function reconcileActive(
  state: BehaviorPolicyState,
  context: BehaviorPolicyContext
): BehaviorPolicyState {
  if (!isValidBehaviorPolicyState(state)) return createInitialBehaviorPolicyState();
  if (state.active.kind === "none") return state;
  if (!isCurrentCorrelation(state.active, context)) {
    return createInitialBehaviorPolicyState();
  }
  if (isVisualIntent(state.active) && context.presence.capabilities.live2d !== "available") {
    return createInitialBehaviorPolicyState();
  }
  if (context.nowMs >= state.active.expiresAtMs) {
    return createInitialBehaviorPolicyState();
  }
  return state;
}

function targetsActive(active: BehaviorIntent, intentRef: unknown): boolean {
  return (
    active.kind !== "none" &&
    isValidBehaviorIntentRef(intentRef) &&
    sameIntentRef(active, intentRef)
  );
}

function sameIntentRef(intent: BehaviorSemanticIntent, intentRef: BehaviorIntentRef): boolean {
  return intent.intentId === intentRef.intentId && intent.createdAtMs === intentRef.createdAtMs;
}

function isCurrentCorrelation(
  intent: BehaviorSemanticIntent,
  context: BehaviorPolicyContext
): boolean {
  switch (intent.scope) {
    case "turn":
      return context.presence.epoch !== null && intent.epoch === context.presence.epoch;
    case "session":
      return context.sessionId !== null && intent.sessionId === context.sessionId;
    case "resource":
    case "decision":
      // P6-A validates these correlations structurally. Authoritative resource
      // generations and decision fencing belong to later phases.
      return true;
  }
}

function isVisualIntent(intent: BehaviorSemanticIntent): boolean {
  return (
    intent.kind === "attention" ||
    intent.kind === "gaze" ||
    intent.kind === "reaction" ||
    (intent.kind === "proactive" && intent.payload.action === "silent-attention")
  );
}

function isValidPolicyContext(value: unknown): value is BehaviorPolicyContext {
  if (!isRecord(value) || !isRecord(value["presence"])) return false;
  const presence = value["presence"];
  const capabilities = presence["capabilities"];
  return (
    isNonNegativeFiniteNumber(value["nowMs"]) &&
    (value["sessionId"] === null || isNonEmptyString(value["sessionId"])) &&
    isRecord(capabilities) &&
    isValidLive2dCapability(capabilities["live2d"])
  );
}

function isValidBehaviorPolicyState(value: unknown): value is BehaviorPolicyState {
  if (!isRecord(value) || !isRecord(value["active"])) return false;
  const active = value["active"];
  return active["kind"] === "none" || isValidBehaviorSemanticIntent(active);
}

function isValidBehaviorSemanticIntent(value: unknown): value is BehaviorSemanticIntent {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value["intentId"]) ||
    !isBehaviorIntentSource(value["source"]) ||
    !isBehaviorIntentReason(value["reason"]) ||
    !isNonNonePriority(value["priority"]) ||
    !isNonNegativeFiniteNumber(value["createdAtMs"]) ||
    !isNonNegativeFiniteNumber(value["expiresAtMs"]) ||
    value["expiresAtMs"] <= value["createdAtMs"] ||
    !isValidScopeFields(value) ||
    !isRecord(value["payload"])
  ) {
    return false;
  }

  const payload = value["payload"];
  let validPayload = false;
  switch (value["kind"]) {
    case "attention":
    case "gaze":
      validPayload =
        isSemanticGazeTarget(payload["target"]) && isSemanticStrength(payload["strength"]);
      break;
    case "reaction":
      validPayload =
        isBehaviorReactionType(payload["reaction"]) && isSemanticStrength(payload["intensity"]);
      break;
    case "proactive":
      validPayload =
        isBehaviorProactiveAction(payload["action"]) &&
        isMatchingProactiveModality(payload["action"], payload["modality"]);
      break;
    default:
      return false;
  }

  if (!validPayload) return false;
  const expectedPriority = deriveBehaviorPriority(value as BehaviorSemanticIntent);
  return expectedPriority !== null && value["priority"] === expectedPriority;
}

function isValidBehaviorIntentRef(value: unknown): value is BehaviorIntentRef {
  return (
    isRecord(value) &&
    isNonEmptyString(value["intentId"]) &&
    isNonNegativeFiniteNumber(value["createdAtMs"])
  );
}

function isValidScopeFields(value: Record<string, unknown>): boolean {
  switch (value["scope"]) {
    case "turn":
      return isNonEmptyString(value["epoch"]);
    case "session":
      return isNonEmptyString(value["sessionId"]);
    case "resource":
      return (
        isNonEmptyString(value["resourceId"]) &&
        (value["resourceGeneration"] === undefined || isNonEmptyString(value["resourceGeneration"]))
      );
    case "decision":
      return isNonEmptyString(value["decisionId"]);
    default:
      return false;
  }
}

function isMatchingProactiveModality(
  action: unknown,
  modality: unknown
): modality is BehaviorProactiveModality {
  switch (action) {
    case "silent-attention":
      return modality === "silent";
    case "request-turn-text":
      return modality === "text";
    case "request-turn-speech":
      return modality === "speech";
    case "none":
      return modality === "none";
  }
  return false;
}

function isUserInteractionCategory(
  source: BehaviorIntentSource,
  reason: BehaviorIntentReason
): boolean {
  return (
    source === "user-interaction" &&
    (reason === "user-gesture" || reason === "listening-entry" || reason === "turn-start")
  );
}

function isActiveTaskCategory(source: BehaviorIntentSource, reason: BehaviorIntentReason): boolean {
  return source === "lifecycle" && (reason === "thinking" || reason === "speech-active");
}

function isAmbientCategory(source: BehaviorIntentSource, reason: BehaviorIntentReason): boolean {
  return (
    source === "idle-policy" && (reason === "silent-attention" || reason === "proactive-candidate")
  );
}

function isReactionCategory(source: BehaviorIntentSource, reason: BehaviorIntentReason): boolean {
  return (
    (source === "user-interaction" && reason === "interrupt-acknowledgement") ||
    (source === "lifecycle" && reason === "lifecycle-reaction") ||
    (source === "capability" && reason === "capability-gate") ||
    (source === "external" && reason === "external-command")
  );
}

function isProactiveCategory(source: BehaviorIntentSource, reason: BehaviorIntentReason): boolean {
  return (
    source === "idle-policy" && (reason === "silent-attention" || reason === "proactive-candidate")
  );
}

function priorityRank(priority: BehaviorPriority): number {
  switch (priority) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return 2;
    case "P3":
      return 3;
    case "P4":
      return 4;
  }
}

function isNonNonePriority(value: unknown): value is NonNoneBehaviorPriority {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

function isBehaviorIntentSource(value: unknown): value is BehaviorIntentSource {
  return (
    value === "lifecycle" ||
    value === "capability" ||
    value === "idle-policy" ||
    value === "user-interaction" ||
    value === "external"
  );
}

function isBehaviorIntentReason(value: unknown): value is BehaviorIntentReason {
  return (
    value === "user-gesture" ||
    value === "listening-entry" ||
    value === "turn-start" ||
    value === "thinking" ||
    value === "speech-active" ||
    value === "interrupt-acknowledgement" ||
    value === "lifecycle-reaction" ||
    value === "capability-gate" ||
    value === "silent-attention" ||
    value === "proactive-candidate" ||
    value === "external-command"
  );
}

function isSemanticGazeTarget(value: unknown): value is SemanticGazeTarget {
  return (
    value === "user" ||
    value === "away-left" ||
    value === "away-right" ||
    value === "down-thoughtful" ||
    value === "recenter" ||
    value === "none"
  );
}

function isSemanticStrength(value: unknown): value is BehaviorSemanticStrength {
  return value === 0 || value === 1 || value === 2;
}

function isBehaviorReactionType(value: unknown): value is BehaviorReactionType {
  return (
    value === "acknowledge-interrupt" ||
    value === "engage-user" ||
    value === "avert-think" ||
    value === "capability-suppress"
  );
}

function isBehaviorProactiveAction(value: unknown): value is BehaviorProactiveAction {
  return (
    value === "silent-attention" ||
    value === "request-turn-text" ||
    value === "request-turn-speech" ||
    value === "none"
  );
}

function isValidLive2dCapability(value: unknown): boolean {
  return value === "unknown" || value === "available" || value === "unavailable";
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
