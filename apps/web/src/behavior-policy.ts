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

export type BehaviorPolicyContext = {
  readonly presence: CompanionPresenceProjection;
  readonly sessionId: string | null;
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
      readonly type: "release";
      /** Omit to release unconditionally; provide it to make release identity-safe. */
      readonly intentId?: string;
    }
  | {
      readonly type: "cancel-intent";
      readonly intentId: string;
    }
  | {
      readonly type: "clock-tick";
      readonly nowMs: number;
      /** A timer-originated tick may target the intent that scheduled it. */
      readonly intentId?: string;
    };

export const NONE_BEHAVIOR_INTENT: BehaviorNoneIntent = { kind: "none" };

export function createInitialBehaviorPolicyState(): BehaviorPolicyState {
  return { active: NONE_BEHAVIOR_INTENT };
}

export function getBehaviorPriority(intent: BehaviorIntent): BehaviorPriority {
  if (intent.kind === "none") return "P4";
  return intent.priority;
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
  const eventNowMs =
    event.type === "clock-tick" && isNonNegativeFiniteNumber(event.nowMs)
      ? event.nowMs
      : context.nowMs;
  const effectiveContext: BehaviorPolicyContext = {
    presence: context.presence,
    sessionId: context.sessionId,
    nowMs: eventNowMs
  };

  if (!isValidPolicyContext(effectiveContext)) {
    return createInitialBehaviorPolicyState();
  }

  const targetedTick = event.type === "clock-tick" && event.intentId !== undefined;
  let current = reconcileActive(state, effectiveContext, !targetedTick);

  switch (event.type) {
    case "submit-intent": {
      const admitted = admitIntent(event.intent, effectiveContext);
      if (admitted === null) return current;
      if (current.active.kind === "none") return { active: admitted };

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
    case "release":
      return canRelease(current.active, event.intentId)
        ? createInitialBehaviorPolicyState()
        : current;
    case "cancel-intent":
      return canRelease(current.active, event.intentId)
        ? createInitialBehaviorPolicyState()
        : current;
    case "clock-tick":
      if (event.intentId === undefined) return reconcileActive(current, effectiveContext, true);
      if (
        current.active.kind !== "none" &&
        current.active.intentId === event.intentId &&
        event.nowMs >= current.active.expiresAtMs
      ) {
        return createInitialBehaviorPolicyState();
      }
      return current;
  }
}

function admitIntent(
  intent: BehaviorSemanticIntent,
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
  context: BehaviorPolicyContext,
  expireByTime: boolean
): BehaviorPolicyState {
  if (!isValidBehaviorPolicyState(state)) return createInitialBehaviorPolicyState();
  if (state.active.kind === "none") return state;
  if (!isCurrentCorrelation(state.active, context)) {
    return createInitialBehaviorPolicyState();
  }
  if (isVisualIntent(state.active) && context.presence.capabilities.live2d !== "available") {
    return createInitialBehaviorPolicyState();
  }
  if (expireByTime && context.nowMs >= state.active.expiresAtMs) {
    return createInitialBehaviorPolicyState();
  }
  return state;
}

function canRelease(active: BehaviorIntent, intentId: string | undefined): boolean {
  if (active.kind === "none") return true;
  if (intentId === undefined) return true;
  return isNonEmptyString(intentId) && active.intentId === intentId;
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
      return true;
  }
}

function isVisualIntent(intent: BehaviorSemanticIntent): boolean {
  return intent.kind === "attention" || intent.kind === "gaze" || intent.kind === "reaction";
}

function isValidPolicyContext(context: BehaviorPolicyContext): boolean {
  return (
    isNonNegativeFiniteNumber(context.nowMs) &&
    (context.sessionId === null || isNonEmptyString(context.sessionId)) &&
    isValidLive2dCapability(context.presence.capabilities.live2d)
  );
}

function isValidBehaviorPolicyState(state: BehaviorPolicyState): boolean {
  if (state.active.kind === "none") return true;
  return isValidBehaviorSemanticIntent(state.active);
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
    !isValidScopeFields(value)
  ) {
    return false;
  }

  if (!isRecord(value["payload"])) return false;
  const payload = value["payload"];
  switch (value["kind"]) {
    case "attention":
    case "gaze":
      return isSemanticGazeTarget(payload["target"]) && isSemanticStrength(payload["strength"]);
    case "reaction":
      return (
        isBehaviorReactionType(payload["reaction"]) && isSemanticStrength(payload["intensity"])
      );
    case "proactive":
      return (
        isBehaviorProactiveAction(payload["action"]) &&
        isMatchingProactiveModality(payload["action"], payload["modality"])
      );
    default:
      return false;
  }
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
