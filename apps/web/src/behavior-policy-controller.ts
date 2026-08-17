import {
  createInitialBehaviorPolicyState,
  getBehaviorIntentRef,
  reduceBehaviorPolicy,
  type BehaviorIntent,
  type BehaviorIntentRef,
  type BehaviorPolicyContext,
  type BehaviorPolicyState,
  type BehaviorSemanticIntent,
  type BehaviorSemanticStrength
} from "./behavior-policy.js";
import type { CompanionPresenceProjection } from "./companion-presence.js";
import { adaptSemanticGaze } from "./semantic-gaze-adapter.js";
import type { SuppliedGazeTarget } from "./companion-gaze.js";
import {
  evaluateSilentAttentionEligibility,
  SILENT_ATTENTION_ENABLED,
  SILENT_ATTENTION_TTL_MS
} from "./proactive-eligibility.js";

export type BehaviorPolicyTimerHandle = unknown;

export type BehaviorPolicyControllerOptions = {
  readonly sessionId: string;
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => BehaviorPolicyTimerHandle;
  readonly clearTimer: (handle: BehaviorPolicyTimerHandle) => void;
  readonly setGazeTarget: (target: SuppliedGazeTarget | null) => void;
  readonly controllerId?: string;
};

export type BehaviorPolicyController = {
  updatePresence(next: CompanionPresenceProjection): void;
  updateVisibility(visible: boolean): void;
  getState(): BehaviorPolicyState;
  getPreviousPresence(): CompanionPresenceProjection | null;
  dispose(): void;
};

export const LIFECYCLE_PULSE_TTL_MS = {
  listening: 750,
  thinking: 900,
  speaking: 1000,
  interrupted: 650
} as const;

export const ACTIVE_TIMER_CLOCK_RETRY_DELAY_MS = 50;

type LifecycleIntentSpec =
  | {
      readonly kind: "attention";
      readonly source: "user-interaction";
      readonly reason: "listening-entry";
      readonly priority: "P0";
      readonly payload: { readonly target: "user"; readonly strength: BehaviorSemanticStrength };
    }
  | {
      readonly kind: "gaze";
      readonly source: "lifecycle";
      readonly reason: "thinking" | "speech-active";
      readonly priority: "P1";
      readonly payload: {
        readonly target: "down-thoughtful" | "user";
        readonly strength: BehaviorSemanticStrength;
      };
    }
  | {
      readonly kind: "reaction";
      readonly source: "user-interaction";
      readonly reason: "interrupt-acknowledgement";
      readonly priority: "P2";
      readonly payload: {
        readonly reaction: "acknowledge-interrupt";
        readonly intensity: BehaviorSemanticStrength;
      };
    };

type ActiveTimer = {
  readonly token: number;
  readonly generation: number;
  readonly intentRef: BehaviorIntentRef;
  readonly handle: BehaviorPolicyTimerHandle;
};

type ProactiveTimer = {
  readonly token: number;
  readonly generation: number;
  readonly dueAtMs: number;
  readonly handle: BehaviorPolicyTimerHandle;
};

function sameIntentRef(left: BehaviorIntentRef, right: BehaviorIntentRef): boolean {
  return left.intentId === right.intentId && left.createdAtMs === right.createdAtMs;
}

function activeRef(state: BehaviorPolicyState): BehaviorIntentRef | null {
  return state.active.kind === "none" ? null : getBehaviorIntentRef(state.active);
}

function isValidMonotonicNow(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function isThinkingLifecycleIntent(intent: BehaviorIntent): boolean {
  return (
    intent.kind === "gaze" &&
    intent.source === "lifecycle" &&
    intent.reason === "thinking" &&
    intent.payload.target === "down-thoughtful"
  );
}

function semanticGazeForIntent(intent: BehaviorIntent): {
  readonly target: Parameters<typeof adaptSemanticGaze>[0];
  readonly strength: BehaviorSemanticStrength;
} | null {
  if (intent.kind === "none") return null;
  switch (intent.kind) {
    case "attention":
    case "gaze":
      return { target: intent.payload.target, strength: intent.payload.strength };
    case "reaction":
      switch (intent.payload.reaction) {
        case "acknowledge-interrupt":
        case "engage-user":
          return { target: "user", strength: intent.payload.intensity };
        case "avert-think":
          return { target: "down-thoughtful", strength: intent.payload.intensity };
        case "capability-suppress":
          return null;
      }
    case "proactive":
      return intent.payload.action === "silent-attention" ? { target: "user", strength: 1 } : null;
  }
}

function isSilentAttentionIntent(
  intent: BehaviorIntent
): intent is Extract<BehaviorSemanticIntent, { readonly kind: "proactive" }> {
  return intent.kind === "proactive" && intent.payload.action === "silent-attention";
}

function createLifecycleIntent(
  spec: LifecycleIntentSpec,
  presence: CompanionPresenceProjection,
  sessionId: string | null,
  controllerId: string,
  generation: number,
  sequence: number,
  nowMs: number,
  ttlMs: number
): BehaviorSemanticIntent | null {
  if (!isValidMonotonicNow(nowMs) || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;

  const expiresAtMs = nowMs + ttlMs;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;

  const scope =
    spec.reason === "listening-entry"
      ? sessionId !== null
        ? { scope: "session" as const, sessionId }
        : null
      : presence.epoch !== null && presence.epoch.trim().length > 0
        ? { scope: "turn" as const, epoch: presence.epoch }
        : null;
  if (scope === null) return null;

  return {
    intentId: `${controllerId}:${generation}:${sequence}:${spec.reason}`,
    source: spec.source,
    reason: spec.reason,
    priority: spec.priority,
    createdAtMs: nowMs,
    expiresAtMs,
    ...scope,
    kind: spec.kind,
    payload: spec.payload
  } as BehaviorSemanticIntent;
}

export function createBehaviorPolicyController(
  options: BehaviorPolicyControllerOptions
): BehaviorPolicyController {
  let state = createInitialBehaviorPolicyState();
  let previousPresence: CompanionPresenceProjection | null = null;
  let timer: ActiveTimer | null = null;
  let generation = 0;
  let sequence = 0;
  let timerToken = 0;
  let proactiveTimer: ProactiveTimer | null = null;
  let proactiveTimerToken = 0;
  let visible = false;
  let idleSinceMs: number | null = null;
  let lastSilentAttentionAtMs: number | null = null;
  let consumedThisIdleEpisode = false;
  let attemptedThisIdleEpisode = false;
  let disposed = false;
  let lastExecutionKey: string | null = null;
  const controllerId =
    typeof options.controllerId === "string" && options.controllerId.length > 0
      ? options.controllerId
      : "behavior-controller";
  const sessionId = normalizeSessionId(options.sessionId);

  function readNow(): number {
    try {
      return options.now();
    } catch {
      return Number.NaN;
    }
  }

  function context(presence: CompanionPresenceProjection, nowMs: number): BehaviorPolicyContext {
    return { presence, sessionId, nowMs };
  }

  function clearActiveTimer(): void {
    timerToken += 1;
    if (timer === null) return;
    const current = timer;
    timer = null;
    try {
      options.clearTimer(current.handle);
    } catch {
      // Timer cancellation is an optimization; identity fencing remains the
      // correctness boundary when an already-queued callback still runs.
    }
  }

  function clearProactiveTimer(): void {
    proactiveTimerToken += 1;
    if (proactiveTimer === null) return;
    const current = proactiveTimer;
    proactiveTimer = null;
    try {
      options.clearTimer(current.handle);
    } catch {
      // Timer cancellation is an optimization; the schedule token remains
      // the correctness boundary for an already-queued callback.
    }
  }

  function resetProactiveEpisode(): void {
    idleSinceMs = null;
    consumedThisIdleEpisode = false;
    attemptedThisIdleEpisode = false;
    clearProactiveTimer();
  }

  function executionKey(target: SuppliedGazeTarget | null): string | null {
    if (target === null) return null;
    return `${target.x}:${target.y}:${target.strength ?? "undefined"}`;
  }

  function applyExecution(target: SuppliedGazeTarget | null, force = false): void {
    const key = executionKey(target);
    if (!force && lastExecutionKey === key) return;
    try {
      options.setGazeTarget(target);
      lastExecutionKey = key;
    } catch {
      // A missing/reloading Lumi surface must not break Presence or policy.
      // The semantic state and its finite timer remain authoritative.
    }
  }

  function applyState(nextState: BehaviorPolicyState, nowMs: number, reschedule = false): void {
    const previousRef = activeRef(state);
    const nextRef = activeRef(nextState);
    const changed =
      previousRef === null
        ? nextRef !== null
        : nextRef === null || !sameIntentRef(previousRef, nextRef);

    state = nextState;
    if (changed) clearActiveTimer();

    const semanticGaze = semanticGazeForIntent(state.active);
    applyExecution(
      semanticGaze === null ? null : adaptSemanticGaze(semanticGaze.target, semanticGaze.strength)
    );

    if (state.active.kind !== "none" && (changed || reschedule)) {
      scheduleActiveTimer(state.active, nowMs);
    }
  }

  function failSafe(): void {
    clearActiveTimer();
    resetProactiveEpisode();
    state = createInitialBehaviorPolicyState();
    applyExecution(null, true);
  }

  function reduceSafely(
    event: Parameters<typeof reduceBehaviorPolicy>[1],
    policyContext: BehaviorPolicyContext
  ): BehaviorPolicyState {
    try {
      return reduceBehaviorPolicy(state, event, policyContext);
    } catch {
      failSafe();
      return state;
    }
  }

  function proactiveInput(
    presence: CompanionPresenceProjection,
    nowMs: number
  ): Parameters<typeof evaluateSilentAttentionEligibility>[0] {
    return {
      presence,
      visible,
      sessionId,
      policyState: state,
      nowMs,
      idleSinceMs,
      lastSilentAttentionAtMs,
      consumedThisIdleEpisode,
      attemptedThisIdleEpisode,
      enabled: SILENT_ATTENTION_ENABLED
    };
  }

  function cancelActiveSilentAttention(presence: CompanionPresenceProjection, nowMs: number): void {
    if (!isSilentAttentionIntent(state.active)) return;
    const intentRef = getBehaviorIntentRef(state.active);
    const nextState = reduceSafely({ type: "cancel-intent", intentRef }, context(presence, nowMs));
    applyState(nextState, nowMs);
  }

  function synchronizeProactiveEnvironment(
    presence: CompanionPresenceProjection,
    nowMs: number
  ): void {
    const result = evaluateSilentAttentionEligibility(proactiveInput(presence, nowMs));
    if (!result.baseEligible) {
      cancelActiveSilentAttention(presence, nowMs);
      resetProactiveEpisode();
      return;
    }

    if (idleSinceMs === null && isValidMonotonicNow(nowMs)) {
      idleSinceMs = nowMs;
      consumedThisIdleEpisode = false;
      attemptedThisIdleEpisode = false;
    }
  }

  function handleInvalidClockEnvironment(presence: CompanionPresenceProjection): void {
    // An invalid sample cannot authorize a policy reduction. Keep the current
    // semantic winner and only invalidate proactive scheduling until time is
    // readable again.
    clearProactiveTimer();
    const result = evaluateSilentAttentionEligibility(proactiveInput(presence, Number.NaN));
    if (result.baseEligible) return;

    resetProactiveEpisode();
    if (isSilentAttentionIntent(state.active)) {
      scheduleActiveTimerRetry(state.active);
    }
  }

  function createSilentAttentionIntent(nowMs: number): BehaviorSemanticIntent | null {
    if (
      sessionId === null ||
      !isValidMonotonicNow(nowMs) ||
      !Number.isFinite(SILENT_ATTENTION_TTL_MS) ||
      SILENT_ATTENTION_TTL_MS <= 0
    ) {
      return null;
    }

    const expiresAtMs = nowMs + SILENT_ATTENTION_TTL_MS;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return null;

    return {
      intentId: `${controllerId}:${generation}:${sequence++}:silent-attention`,
      source: "idle-policy",
      reason: "silent-attention",
      priority: "P3",
      createdAtMs: nowMs,
      expiresAtMs,
      scope: "session",
      sessionId,
      kind: "proactive",
      payload: { action: "silent-attention", modality: "silent" }
    };
  }

  function scheduleProactiveTimer(dueAtMs: number, nowMs: number): void {
    if (disposed || !isValidMonotonicNow(nowMs) || !Number.isFinite(dueAtMs) || dueAtMs < nowMs) {
      return;
    }

    if (proactiveTimer !== null) clearProactiveTimer();
    const timerGeneration = generation;
    const currentToken = ++proactiveTimerToken;
    const delayMs = Math.max(0, dueAtMs - nowMs);
    try {
      const handle = options.setTimer(() => {
        if (disposed || timerGeneration !== generation) return;
        if (
          proactiveTimer === null ||
          proactiveTimer.token !== currentToken ||
          proactiveTimer.generation !== timerGeneration ||
          proactiveTimer.dueAtMs !== dueAtMs
        ) {
          return;
        }

        // Consume the concrete schedule before any path that may schedule a
        // replacement. A duplicate invocation of this closure is stale.
        proactiveTimer = null;
        const callbackNow = readNow();
        const currentPresence = previousPresence;
        if (currentPresence === null || !isValidMonotonicNow(callbackNow)) return;

        synchronizeProactiveEnvironment(currentPresence, callbackNow);
        const currentEvaluation = evaluateSilentAttentionEligibility(
          proactiveInput(currentPresence, callbackNow)
        );
        if (!currentEvaluation.baseEligible) return;

        if (callbackNow < dueAtMs) {
          scheduleProactiveTimer(dueAtMs, callbackNow);
          return;
        }

        if (!currentEvaluation.eligible) {
          if (currentEvaluation.nextCheckAtMs !== null) {
            scheduleProactiveTimer(currentEvaluation.nextCheckAtMs, callbackNow);
          }
          return;
        }

        const intent = createSilentAttentionIntent(callbackNow);
        if (intent === null) return;

        const nextState = reduceSafely(
          { type: "submit-intent", intent },
          context(currentPresence, callbackNow)
        );
        const admitted =
          isSilentAttentionIntent(nextState.active) &&
          sameIntentRef(getBehaviorIntentRef(nextState.active), getBehaviorIntentRef(intent));
        applyState(nextState, callbackNow);
        attemptedThisIdleEpisode = true;
        if (admitted) {
          consumedThisIdleEpisode = true;
          lastSilentAttentionAtMs = callbackNow;
        }
      }, delayMs);
      proactiveTimer = {
        token: currentToken,
        generation: timerGeneration,
        dueAtMs,
        handle
      };
    } catch {
      proactiveTimer = null;
    }
  }

  function reevaluateProactive(presence: CompanionPresenceProjection, nowMs: number): void {
    if (disposed || !isValidMonotonicNow(nowMs)) {
      if (!isValidMonotonicNow(nowMs)) clearProactiveTimer();
      return;
    }

    if (idleSinceMs === null) {
      synchronizeProactiveEnvironment(presence, nowMs);
    }

    const result = evaluateSilentAttentionEligibility(proactiveInput(presence, nowMs));
    if (!result.baseEligible) return;

    if (result.eligible) {
      if (proactiveTimer === null) scheduleProactiveTimer(nowMs, nowMs);
      return;
    }

    if (proactiveTimer !== null && result.nextCheckAtMs === null) {
      clearProactiveTimer();
    } else if (proactiveTimer === null && result.nextCheckAtMs !== null) {
      scheduleProactiveTimer(result.nextCheckAtMs, nowMs);
    }
  }

  function scheduleActiveTimerWithDelay(intent: BehaviorSemanticIntent, delayMs: number): void {
    if (disposed || !Number.isFinite(delayMs) || delayMs < 0) return;

    if (timer !== null) clearActiveTimer();
    const intentRef = Object.freeze(getBehaviorIntentRef(intent));
    const timerGeneration = generation;
    const currentTimerToken = ++timerToken;
    try {
      const handle = options.setTimer(() => {
        if (disposed || timerGeneration !== generation) return;
        if (
          timer === null ||
          timer.token !== currentTimerToken ||
          timer.generation !== timerGeneration ||
          !sameIntentRef(timer.intentRef, intentRef)
        )
          return;
        timer = null;

        const callbackNow = readNow();
        const currentPresence = previousPresence;
        if (currentPresence === null) {
          failSafe();
          return;
        }
        if (!isValidMonotonicNow(callbackNow)) {
          // Clock failure delays expiry processing; it does not mean the
          // exact active intent was semantically released.
          if (
            state.active.kind !== "none" &&
            sameIntentRef(getBehaviorIntentRef(state.active), intentRef)
          ) {
            scheduleActiveTimerRetry(state.active);
          }
          return;
        }
        const nextState = reduceSafely(
          { type: "clock-tick", intentRef },
          context(currentPresence, callbackNow)
        );
        applyState(nextState, callbackNow);

        const active = nextState.active;
        if (
          active.kind !== "none" &&
          sameIntentRef(getBehaviorIntentRef(active), intentRef) &&
          isValidMonotonicNow(callbackNow) &&
          callbackNow < active.expiresAtMs
        ) {
          // A timer may fire early. Keep the exact identity and wait for the
          // remaining monotonic lifetime rather than clearing execution.
          scheduleActiveTimer(active, callbackNow);
        }
        reevaluateProactive(currentPresence, callbackNow);
      }, delayMs);
      timer = { token: currentTimerToken, generation: timerGeneration, intentRef, handle };
    } catch {
      failSafe();
    }
  }

  function scheduleActiveTimer(intent: BehaviorSemanticIntent, nowMs: number): void {
    if (!isValidMonotonicNow(nowMs)) return;
    scheduleActiveTimerWithDelay(intent, Math.max(0, intent.expiresAtMs - nowMs));
  }

  function scheduleActiveTimerRetry(intent: BehaviorSemanticIntent): void {
    scheduleActiveTimerWithDelay(intent, ACTIVE_TIMER_CLOCK_RETRY_DELAY_MS);
  }

  function submit(
    spec: LifecycleIntentSpec,
    presence: CompanionPresenceProjection,
    nowMs: number,
    ttlMs: number
  ): void {
    const intent = createLifecycleIntent(
      spec,
      presence,
      sessionId,
      controllerId,
      generation,
      sequence++,
      nowMs,
      ttlMs
    );
    if (intent === null) return;

    const current = state.active;
    const shouldRetireThinking =
      spec.reason === "speech-active" && isThinkingLifecycleIntent(current);
    if (
      shouldRetireThinking &&
      current.kind !== "none" &&
      isAdmittedCandidate(intent, presence, nowMs)
    ) {
      const currentRef = getBehaviorIntentRef(current);
      const retiredState = reduceSafely(
        { type: "release-intent", intentRef: currentRef },
        context(presence, nowMs)
      );
      applyState(retiredState, nowMs);
    }

    const nextState = reduceSafely({ type: "submit-intent", intent }, context(presence, nowMs));
    applyState(nextState, nowMs);
  }

  function isAdmittedCandidate(
    intent: BehaviorSemanticIntent,
    presence: CompanionPresenceProjection,
    nowMs: number
  ): boolean {
    try {
      const candidateState = reduceBehaviorPolicy(
        createInitialBehaviorPolicyState(),
        { type: "submit-intent", intent },
        context(presence, nowMs)
      );
      return (
        candidateState.active.kind !== "none" &&
        sameIntentRef(getBehaviorIntentRef(candidateState.active), getBehaviorIntentRef(intent))
      );
    } catch {
      return false;
    }
  }

  function reconcile(presence: CompanionPresenceProjection, nowMs: number): void {
    const current = state.active;
    const intentRef =
      current.kind === "none"
        ? { intentId: "reconcile", createdAtMs: 0 }
        : getBehaviorIntentRef(current);
    const nextState = reduceSafely({ type: "clock-tick", intentRef }, context(presence, nowMs));
    applyState(nextState, nowMs);
  }

  function updatePresence(next: CompanionPresenceProjection): void {
    if (disposed) return;

    const previous = previousPresence;
    previousPresence = next;
    const nowMs = readNow();
    if (!isValidMonotonicNow(nowMs)) {
      handleInvalidClockEnvironment(next);
      return;
    }
    reconcile(next, nowMs);
    synchronizeProactiveEnvironment(next, nowMs);
    if (previous === null) {
      reevaluateProactive(next, nowMs);
      return;
    }

    if (previous.activity !== "listening" && next.activity === "listening") {
      submit(
        {
          kind: "attention",
          source: "user-interaction",
          reason: "listening-entry",
          priority: "P0",
          payload: { target: "user", strength: 1 }
        },
        next,
        nowMs,
        LIFECYCLE_PULSE_TTL_MS.listening
      );
    }

    if (previous.activity !== "thinking" && next.activity === "thinking") {
      submit(
        {
          kind: "gaze",
          source: "lifecycle",
          reason: "thinking",
          priority: "P1",
          payload: { target: "down-thoughtful", strength: 1 }
        },
        next,
        nowMs,
        LIFECYCLE_PULSE_TTL_MS.thinking
      );
    }

    if (previous.speech !== "active" && next.speech === "active") {
      submit(
        {
          kind: "gaze",
          source: "lifecycle",
          reason: "speech-active",
          priority: "P1",
          payload: { target: "user", strength: 1 }
        },
        next,
        nowMs,
        LIFECYCLE_PULSE_TTL_MS.speaking
      );
    }

    if (previous.transition !== "interrupted" && next.transition === "interrupted") {
      submit(
        {
          kind: "reaction",
          source: "user-interaction",
          reason: "interrupt-acknowledgement",
          priority: "P2",
          payload: { reaction: "acknowledge-interrupt", intensity: 1 }
        },
        next,
        nowMs,
        LIFECYCLE_PULSE_TTL_MS.interrupted
      );
    }

    reevaluateProactive(next, nowMs);
  }

  function updateVisibility(nextVisible: boolean): void {
    if (disposed || visible === nextVisible) return;
    visible = nextVisible;
    const currentPresence = previousPresence;
    if (currentPresence === null) return;
    const nowMs = readNow();
    if (!isValidMonotonicNow(nowMs)) {
      handleInvalidClockEnvironment(currentPresence);
      return;
    }
    synchronizeProactiveEnvironment(currentPresence, nowMs);
    reevaluateProactive(currentPresence, nowMs);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation += 1;
    clearActiveTimer();
    resetProactiveEpisode();
    visible = false;
    state = createInitialBehaviorPolicyState();
    previousPresence = null;
    applyExecution(null, true);
  }

  return {
    updatePresence,
    updateVisibility,
    getState: () => state,
    getPreviousPresence: () => previousPresence,
    dispose
  };
}
