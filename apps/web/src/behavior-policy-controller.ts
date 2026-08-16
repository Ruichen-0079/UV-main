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

function sameIntentRef(left: BehaviorIntentRef, right: BehaviorIntentRef): boolean {
  return left.intentId === right.intentId && left.createdAtMs === right.createdAtMs;
}

function activeRef(state: BehaviorPolicyState): BehaviorIntentRef | null {
  return state.active.kind === "none" ? null : getBehaviorIntentRef(state.active);
}

function isValidMonotonicNow(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
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
      return null;
  }
}

function createLifecycleIntent(
  spec: LifecycleIntentSpec,
  presence: CompanionPresenceProjection,
  sessionId: string,
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
      ? sessionId.trim().length > 0
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
  let disposed = false;
  let lastExecutionKey: string | null = null;
  const controllerId =
    typeof options.controllerId === "string" && options.controllerId.length > 0
      ? options.controllerId
      : "behavior-controller";

  function readNow(): number {
    try {
      return options.now();
    } catch {
      return Number.NaN;
    }
  }

  function context(presence: CompanionPresenceProjection, nowMs: number): BehaviorPolicyContext {
    return { presence, sessionId: options.sessionId, nowMs };
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

  function scheduleActiveTimer(intent: BehaviorSemanticIntent, nowMs: number): void {
    if (!isValidMonotonicNow(nowMs)) {
      failSafe();
      return;
    }

    const delayMs = Math.max(0, intent.expiresAtMs - nowMs);
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
      }, delayMs);
      timer = { token: currentTimerToken, generation: timerGeneration, intentRef, handle };
    } catch {
      failSafe();
    }
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
      options.sessionId,
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
    reconcile(next, nowMs);
    if (previous === null) return;

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
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation += 1;
    clearActiveTimer();
    state = createInitialBehaviorPolicyState();
    previousPresence = null;
    applyExecution(null, true);
  }

  return {
    updatePresence,
    getState: () => state,
    getPreviousPresence: () => previousPresence,
    dispose
  };
}
