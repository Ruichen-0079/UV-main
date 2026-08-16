import { describe, expect, it } from "vitest";
import {
  compareBehaviorPriority,
  createInitialBehaviorPolicyState,
  getBehaviorIntentRef,
  getBehaviorPriority,
  reduceBehaviorPolicy,
  type BehaviorPolicyContext,
  type BehaviorPolicyState,
  type BehaviorSemanticIntent
} from "./behavior-policy.js";
import { createInitialCompanionPresence } from "./companion-presence.js";

const baseContext: BehaviorPolicyContext = {
  presence: {
    ...createInitialCompanionPresence(),
    epoch: "turn-b",
    capabilities: { tts: "unknown", audio: "unknown", live2d: "available" }
  },
  sessionId: "session-a",
  nowMs: 100
};

type IntentOverrides = {
  intentId?: string;
  source?: BehaviorSemanticIntent["source"];
  reason?: BehaviorSemanticIntent["reason"];
  priority: BehaviorSemanticIntent["priority"];
  createdAtMs?: number;
  expiresAtMs?: number;
  scope: BehaviorSemanticIntent["scope"];
  epoch?: string;
  sessionId?: string;
  resourceId?: string;
  resourceGeneration?: string;
  decisionId?: string;
  kind: BehaviorSemanticIntent["kind"];
  payload?: BehaviorSemanticIntent["payload"];
};

function defaultSemanticCategory(
  kind: BehaviorSemanticIntent["kind"],
  priority: BehaviorSemanticIntent["priority"]
): Pick<IntentOverrides, "source" | "reason"> {
  if (kind === "reaction") return { source: "lifecycle", reason: "lifecycle-reaction" };
  if (kind === "proactive") return { source: "idle-policy", reason: "proactive-candidate" };
  if (priority === "P0") return { source: "user-interaction", reason: "user-gesture" };
  if (priority === "P1") return { source: "lifecycle", reason: "thinking" };
  if (priority === "P3") return { source: "idle-policy", reason: "silent-attention" };
  return { source: "external", reason: "external-command" };
}

function intent(overrides: IntentOverrides): BehaviorSemanticIntent {
  const defaults = defaultSemanticCategory(overrides.kind, overrides.priority);
  const common = {
    intentId: overrides.intentId ?? "intent-a",
    source: overrides.source ?? defaults.source,
    reason: overrides.reason ?? defaults.reason,
    priority: overrides.priority,
    createdAtMs: overrides.createdAtMs ?? 100,
    expiresAtMs: overrides.expiresAtMs ?? 500,
    ...(overrides.scope === "turn"
      ? { scope: "turn" as const, epoch: overrides.epoch ?? "turn-b" }
      : overrides.scope === "session"
        ? { scope: "session" as const, sessionId: overrides.sessionId ?? "session-a" }
        : overrides.scope === "resource"
          ? {
              scope: "resource" as const,
              resourceId: overrides.resourceId ?? "resource-a",
              ...(overrides.resourceGeneration === undefined
                ? {}
                : { resourceGeneration: overrides.resourceGeneration })
            }
          : { scope: "decision" as const, decisionId: overrides.decisionId ?? "decision-a" }),
    kind: overrides.kind,
    payload: overrides.payload ?? defaultPayload(overrides.kind)
  };
  return common as BehaviorSemanticIntent;
}

function defaultPayload(kind: BehaviorSemanticIntent["kind"]): BehaviorSemanticIntent["payload"] {
  switch (kind) {
    case "reaction":
      return { reaction: "engage-user", intensity: 1 };
    case "proactive":
      return { action: "silent-attention", modality: "silent" };
    case "attention":
    case "gaze":
      return { target: "user", strength: 1 };
  }
}

function activeId(state: BehaviorPolicyState): string | null {
  return state.active.kind === "none" ? null : state.active.intentId;
}

function context(overrides: Partial<BehaviorPolicyContext> = {}): BehaviorPolicyContext {
  return { ...baseContext, ...overrides };
}

function submit(
  state: BehaviorPolicyState,
  candidate: BehaviorSemanticIntent,
  policyContext: BehaviorPolicyContext = baseContext
): BehaviorPolicyState {
  return reduceBehaviorPolicy(state, { type: "submit-intent", intent: candidate }, policyContext);
}

describe("P6-A semantic behavior policy", () => {
  it("defines none as residual release and keeps policy state minimal", () => {
    const initial = createInitialBehaviorPolicyState();
    expect(initial.active).toEqual({ kind: "none" });
    expect(getBehaviorPriority(initial.active)).toBe("P4");
    expect(Object.keys(initial)).toEqual(["active"]);
  });

  it("keeps the frozen priority order explicit", () => {
    expect(compareBehaviorPriority("P0", "P1")).toBeLessThan(0);
    expect(compareBehaviorPriority("P1", "P2")).toBeLessThan(0);
    expect(compareBehaviorPriority("P2", "P3")).toBeLessThan(0);
    expect(compareBehaviorPriority("P3", "P4")).toBeLessThan(0);
    expect(compareBehaviorPriority("P0", "P3")).toBeLessThan(0);
    expect(compareBehaviorPriority("P3", "P0")).toBeGreaterThan(0);
  });

  it("owns priority by semantic category and rejects forged promotions", () => {
    const forgedProactive = intent({
      intentId: "forged-proactive-p0",
      kind: "proactive",
      priority: "P0",
      scope: "turn"
    });
    const forgedReaction = intent({
      intentId: "forged-reaction-p0",
      kind: "reaction",
      priority: "P0",
      scope: "turn",
      source: "user-interaction",
      reason: "user-gesture",
      payload: { reaction: "avert-think", intensity: 1 }
    });
    expect(submit(createInitialBehaviorPolicyState(), forgedProactive).active).toEqual({
      kind: "none"
    });
    expect(submit(createInitialBehaviorPolicyState(), forgedReaction).active).toEqual({
      kind: "none"
    });

    const valid = [
      intent({ intentId: "p0", kind: "gaze", priority: "P0", scope: "turn" }),
      intent({ intentId: "p1", kind: "gaze", priority: "P1", scope: "turn" }),
      intent({ intentId: "p2", kind: "reaction", priority: "P2", scope: "turn" }),
      intent({ intentId: "p3", kind: "proactive", priority: "P3", scope: "turn" })
    ];
    for (const candidate of valid) {
      expect(submit(createInitialBehaviorPolicyState(), candidate).active).toEqual(candidate);
    }
  });

  it("applies every priority boundary through the single reducer", () => {
    const cases: Array<readonly [BehaviorSemanticIntent, BehaviorSemanticIntent]> = [
      [
        intent({ intentId: "low-p1", kind: "gaze", priority: "P1", scope: "turn" }),
        intent({
          intentId: "high-p0",
          kind: "gaze",
          priority: "P0",
          scope: "turn",
          createdAtMs: 90
        })
      ],
      [
        intent({ intentId: "low-p2", kind: "reaction", priority: "P2", scope: "turn" }),
        intent({
          intentId: "high-p1",
          kind: "gaze",
          priority: "P1",
          scope: "turn",
          createdAtMs: 90
        })
      ],
      [
        intent({ intentId: "low-p3", kind: "proactive", priority: "P3", scope: "turn" }),
        intent({
          intentId: "high-p2",
          kind: "reaction",
          priority: "P2",
          scope: "turn",
          createdAtMs: 90
        })
      ]
    ];
    for (const [low, high] of cases) {
      let state = submit(createInitialBehaviorPolicyState(), low);
      state = submit(state, high);
      expect(activeId(state)).toBe(high.intentId);
    }

    const ambient = intent({
      intentId: "ambient-release-boundary",
      kind: "proactive",
      priority: "P3",
      scope: "turn"
    });
    expect(activeId(submit(createInitialBehaviorPolicyState(), ambient))).toBe(
      "ambient-release-boundary"
    );
  });

  it("admits valid turn, session, resource, and decision correlations", () => {
    const cases: BehaviorSemanticIntent[] = [
      intent({ intentId: "turn", kind: "gaze", priority: "P0", scope: "turn" }),
      intent({ intentId: "session", kind: "attention", priority: "P1", scope: "session" }),
      intent({ intentId: "resource", kind: "proactive", priority: "P3", scope: "resource" }),
      intent({ intentId: "decision", kind: "proactive", priority: "P3", scope: "decision" })
    ];
    let state = createInitialBehaviorPolicyState();
    for (const candidate of cases) {
      state = submit(state, candidate);
      expect(activeId(state)).toBe(candidate.intentId);
      state = reduceBehaviorPolicy(
        state,
        { type: "release-intent", intentRef: getBehaviorIntentRef(candidate) },
        baseContext
      );
    }
  });

  it("rejects stale turn and mismatched session correlations", () => {
    const staleTurn = intent({
      intentId: "stale-turn",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      epoch: "turn-a"
    });
    const mismatchedSession = intent({
      intentId: "stale-session",
      kind: "gaze",
      priority: "P0",
      scope: "session",
      sessionId: "session-b"
    });
    expect(submit(createInitialBehaviorPolicyState(), staleTurn).active).toEqual({ kind: "none" });
    expect(submit(createInitialBehaviorPolicyState(), mismatchedSession).active).toEqual({
      kind: "none"
    });

    const activeSession = intent({
      intentId: "active-session",
      kind: "gaze",
      priority: "P0",
      scope: "session"
    });
    const activeState = submit(createInitialBehaviorPolicyState(), activeSession);
    expect(
      reduceBehaviorPolicy(
        activeState,
        { type: "clock-tick", intentRef: getBehaviorIntentRef(activeSession) },
        context({ sessionId: "session-b", nowMs: 120 })
      ).active
    ).toEqual({ kind: "none" });
  });

  it("requires finite, non-negative TTL values with expiry after creation", () => {
    const valid = intent({ intentId: "valid", kind: "gaze", priority: "P0", scope: "turn" });
    expect(submit(createInitialBehaviorPolicyState(), valid).active).toEqual(valid);

    for (const timing of [
      { createdAtMs: Number.NaN, expiresAtMs: 500 },
      { createdAtMs: Number.POSITIVE_INFINITY, expiresAtMs: 500 },
      { createdAtMs: Number.NEGATIVE_INFINITY, expiresAtMs: 500 },
      { createdAtMs: -1, expiresAtMs: 500 },
      { createdAtMs: 500, expiresAtMs: Number.POSITIVE_INFINITY },
      { createdAtMs: 500, expiresAtMs: 500 },
      { createdAtMs: 500, expiresAtMs: 400 }
    ]) {
      const invalid = intent({
        intentId: `invalid-${String(timing.createdAtMs)}-${timing.expiresAtMs}`,
        kind: "gaze",
        priority: "P0",
        scope: "turn",
        ...timing
      });
      expect(submit(createInitialBehaviorPolicyState(), invalid).active).toEqual({ kind: "none" });
    }
  });

  it("preempts lower priority and drops it permanently", () => {
    const ambient = intent({
      intentId: "ambient",
      kind: "proactive",
      priority: "P3",
      scope: "turn"
    });
    const user = intent({
      intentId: "user",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      createdAtMs: 90
    });
    let state = submit(createInitialBehaviorPolicyState(), ambient);
    state = submit(state, user);
    expect(activeId(state)).toBe("user");
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", intentRef: getBehaviorIntentRef(user) },
      context({ nowMs: 500 })
    );
    expect(state.active).toEqual({ kind: "none" });
  });

  it("suppresses lower priority without queueing it", () => {
    const task = intent({ intentId: "task", kind: "gaze", priority: "P1", scope: "turn" });
    const ambient = intent({
      intentId: "ambient",
      kind: "proactive",
      priority: "P3",
      scope: "turn",
      createdAtMs: 110
    });
    let state = submit(createInitialBehaviorPolicyState(), task);
    state = submit(state, ambient, context({ nowMs: 110 }));
    expect(activeId(state)).toBe("task");
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", intentRef: getBehaviorIntentRef(task) },
      context({ nowMs: 500 })
    );
    expect(state.active).toEqual({ kind: "none" });
  });

  it("replaces same-priority active intent only when the newer candidate is valid", () => {
    const first = intent({ intentId: "first", kind: "reaction", priority: "P2", scope: "turn" });
    const newer = intent({
      intentId: "newer",
      kind: "reaction",
      priority: "P2",
      scope: "turn",
      createdAtMs: 120
    });
    const equalTime = intent({
      intentId: "equal-time",
      kind: "reaction",
      priority: "P2",
      scope: "turn",
      createdAtMs: 120
    });
    const stale = intent({
      intentId: "stale",
      kind: "reaction",
      priority: "P2",
      scope: "turn",
      epoch: "turn-a",
      createdAtMs: 130
    });
    let state = submit(createInitialBehaviorPolicyState(), first);
    state = submit(state, newer, context({ nowMs: 120 }));
    expect(activeId(state)).toBe("newer");
    state = submit(state, equalTime, context({ nowMs: 120 }));
    expect(activeId(state)).toBe("newer");
    state = submit(state, stale, context({ nowMs: 130 }));
    expect(activeId(state)).toBe("newer");
  });

  it("clears stale active turns before accepting a current lower-priority turn", () => {
    const oldTurn = intent({
      intentId: "old-turn",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      epoch: "turn-a"
    });
    const currentTurn = intent({
      intentId: "current-turn",
      kind: "proactive",
      priority: "P3",
      scope: "turn",
      epoch: "turn-b"
    });
    let state = submit(
      createInitialBehaviorPolicyState(),
      oldTurn,
      context({ presence: { ...baseContext.presence, epoch: "turn-a" } })
    );
    state = submit(state, currentTurn);
    expect(activeId(state)).toBe("current-turn");
    state = submit(
      state,
      oldTurn,
      context({ presence: { ...baseContext.presence, epoch: "turn-b" } })
    );
    expect(activeId(state)).toBe("current-turn");
  });

  it("clears active turn intent when Presence epoch changes and rejects late old events", () => {
    const oldTurn = intent({ intentId: "old-turn", kind: "gaze", priority: "P0", scope: "turn" });
    let state = submit(createInitialBehaviorPolicyState(), oldTurn);
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", intentRef: getBehaviorIntentRef(oldTurn) },
      context({
        nowMs: 120,
        presence: { ...baseContext.presence, epoch: "turn-c" }
      })
    );
    expect(state.active).toEqual({ kind: "none" });
    state = submit(
      state,
      oldTurn,
      context({ nowMs: 120, presence: { ...baseContext.presence, epoch: "turn-c" } })
    );
    expect(state.active).toEqual({ kind: "none" });
  });

  it("expires before, at, and after TTL without replaying expired intent", () => {
    const candidate = intent({
      intentId: "short",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      expiresAtMs: 200
    });
    let state = submit(createInitialBehaviorPolicyState(), candidate);
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", intentRef: getBehaviorIntentRef(candidate) },
      context({ nowMs: 199 })
    );
    expect(activeId(state)).toBe("short");
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", intentRef: getBehaviorIntentRef(candidate) },
      context({ nowMs: 200 })
    );
    expect(state.active).toEqual({ kind: "none" });
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", intentRef: getBehaviorIntentRef(candidate) },
      context({ nowMs: 300 })
    );
    expect(state.active).toEqual({ kind: "none" });
  });

  it("does not let an old targeted expiry clear a newer active intent", () => {
    const oldIntent = intent({
      intentId: "old",
      kind: "proactive",
      priority: "P3",
      scope: "turn",
      expiresAtMs: 150
    });
    const newIntent = intent({
      intentId: "new",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      createdAtMs: 120,
      expiresAtMs: 500
    });
    let state = submit(createInitialBehaviorPolicyState(), oldIntent);
    state = submit(state, newIntent, context({ nowMs: 120 }));
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", intentRef: getBehaviorIntentRef(oldIntent) },
      context({ nowMs: 150 })
    );
    expect(activeId(state)).toBe("new");
  });

  it("protects a replacement when intentId is reused", () => {
    const first = intent({
      intentId: "same",
      kind: "proactive",
      priority: "P3",
      scope: "turn",
      expiresAtMs: 200
    });
    const second = intent({
      intentId: "same",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      createdAtMs: 150,
      expiresAtMs: 300
    });
    let state = submit(createInitialBehaviorPolicyState(), first);
    state = submit(state, second, context({ nowMs: 150 }));
    expect(activeId(state)).toBe("same");

    for (const event of [
      { type: "cancel-intent", intentRef: getBehaviorIntentRef(first) },
      { type: "release-intent", intentRef: getBehaviorIntentRef(first) },
      { type: "clock-tick", intentRef: getBehaviorIntentRef(first) }
    ] as const) {
      state = reduceBehaviorPolicy(state, event, context({ nowMs: 200 }));
      expect(state.active.kind === "none" ? null : state.active.createdAtMs).toBe(150);
    }

    state = reduceBehaviorPolicy(
      state,
      { type: "cancel-intent", intentRef: getBehaviorIntentRef(second) },
      context({ nowMs: 200 })
    );
    expect(state.active).toEqual({ kind: "none" });
  });

  it("rejects reuse of an exact intent reference for different semantics", () => {
    const first = intent({
      intentId: "same-pair",
      kind: "proactive",
      priority: "P3",
      scope: "turn",
      createdAtMs: 100
    });
    const collision = intent({
      intentId: "same-pair",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      createdAtMs: 100
    });
    let state = submit(createInitialBehaviorPolicyState(), first);
    state = submit(state, collision);
    expect(state.active).toEqual(first);
  });

  it("supports exact cancellation and an explicit reset separately", () => {
    const first = intent({ intentId: "first", kind: "gaze", priority: "P0", scope: "turn" });
    const second = intent({
      intentId: "second",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      createdAtMs: 110
    });
    let state = submit(createInitialBehaviorPolicyState(), first);
    state = submit(state, second, context({ nowMs: 110 }));
    state = reduceBehaviorPolicy(
      state,
      { type: "cancel-intent", intentRef: getBehaviorIntentRef(first) },
      context({ nowMs: 110 })
    );
    expect(activeId(state)).toBe("second");
    state = reduceBehaviorPolicy(state, { type: "reset" }, context({ nowMs: 110 }));
    expect(state.active).toEqual({ kind: "none" });
  });

  it("fails closed for visual intent when Live2D is unavailable or unknown", () => {
    for (const live2d of ["unavailable", "unknown"] as const) {
      const visual = intent({ intentId: live2d, kind: "gaze", priority: "P0", scope: "turn" });
      const next = submit(
        createInitialBehaviorPolicyState(),
        visual,
        context({
          presence: {
            ...baseContext.presence,
            capabilities: { ...baseContext.presence.capabilities, live2d }
          }
        })
      );
      expect(next.active).toEqual({ kind: "none" });
    }
  });

  it("treats proactive silent-attention as visual but request actions as nonvisual", () => {
    const silent = intent({
      intentId: "silent",
      kind: "proactive",
      priority: "P3",
      scope: "decision",
      payload: { action: "silent-attention", modality: "silent" }
    });
    for (const live2d of ["unknown", "unavailable"] as const) {
      expect(
        submit(
          createInitialBehaviorPolicyState(),
          silent,
          context({
            presence: {
              ...baseContext.presence,
              capabilities: { ...baseContext.presence.capabilities, live2d }
            }
          })
        ).active
      ).toEqual({ kind: "none" });
    }
    expect(submit(createInitialBehaviorPolicyState(), silent).active).toEqual(silent);

    for (const [action, modality] of [
      ["request-turn-text", "text"],
      ["request-turn-speech", "speech"]
    ] as const) {
      const request = intent({
        intentId: action,
        kind: "proactive",
        priority: "P3",
        scope: "decision",
        payload: { action, modality }
      });
      expect(
        submit(
          createInitialBehaviorPolicyState(),
          request,
          context({
            presence: {
              ...baseContext.presence,
              capabilities: { ...baseContext.presence.capabilities, live2d: "unavailable" }
            }
          })
        ).active
      ).toEqual(request);
    }
  });

  it("releases visual state on capability downgrade without clearing nonvisual structure", () => {
    const silent = intent({
      intentId: "silent",
      kind: "proactive",
      priority: "P3",
      scope: "decision",
      payload: { action: "silent-attention", modality: "silent" }
    });
    const silentState = submit(createInitialBehaviorPolicyState(), silent);
    expect(
      reduceBehaviorPolicy(
        silentState,
        { type: "clock-tick", intentRef: getBehaviorIntentRef(silent) },
        context({
          nowMs: 120,
          presence: {
            ...baseContext.presence,
            capabilities: { ...baseContext.presence.capabilities, live2d: "unavailable" }
          }
        })
      ).active
    ).toEqual({ kind: "none" });

    const request = intent({
      intentId: "request",
      kind: "proactive",
      priority: "P3",
      scope: "decision",
      payload: { action: "request-turn-text", modality: "text" }
    });
    const requestState = submit(createInitialBehaviorPolicyState(), request);
    expect(
      reduceBehaviorPolicy(
        requestState,
        { type: "clock-tick", intentRef: getBehaviorIntentRef(request) },
        context({
          nowMs: 120,
          presence: {
            ...baseContext.presence,
            capabilities: { ...baseContext.presence.capabilities, live2d: "unavailable" }
          }
        })
      ).active
    ).toEqual(request);
  });

  it("admits otherwise-valid visual intent only when Live2D is available", () => {
    const visual = intent({ intentId: "visual", kind: "attention", priority: "P1", scope: "turn" });
    expect(submit(createInitialBehaviorPolicyState(), visual).active).toEqual(visual);
  });

  it("releases P0 through P3 explicitly regardless of priority", () => {
    const activeIntents = [
      intent({ intentId: "p0", kind: "gaze", priority: "P0", scope: "turn" }),
      intent({ intentId: "p1", kind: "gaze", priority: "P1", scope: "turn" }),
      intent({ intentId: "p2", kind: "reaction", priority: "P2", scope: "turn" }),
      intent({ intentId: "p3", kind: "proactive", priority: "P3", scope: "turn" })
    ];
    for (const active of activeIntents) {
      const state = submit(createInitialBehaviorPolicyState(), active);
      const released = reduceBehaviorPolicy(
        state,
        { type: "release-intent", intentRef: getBehaviorIntentRef(active) },
        baseContext
      );
      expect(released.active).toEqual({ kind: "none" });
    }
  });

  it("keeps a newer active intent when old identity-bound events arrive", () => {
    const first = intent({ intentId: "first", kind: "reaction", priority: "P2", scope: "turn" });
    const second = intent({
      intentId: "second",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      createdAtMs: 120
    });
    let state = submit(createInitialBehaviorPolicyState(), first);
    state = submit(state, second, context({ nowMs: 120 }));
    state = reduceBehaviorPolicy(
      state,
      { type: "release-intent", intentRef: getBehaviorIntentRef(first) },
      context({ nowMs: 120 })
    );
    expect(activeId(state)).toBe("second");
    state = reduceBehaviorPolicy(
      state,
      { type: "cancel-intent", intentRef: getBehaviorIntentRef(first) },
      context({ nowMs: 120 })
    );
    expect(activeId(state)).toBe("second");
  });

  it("uses context.nowMs as the only time authority and rejects future candidates", () => {
    const candidate = intent({
      intentId: "timed",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      expiresAtMs: 200
    });
    let state = submit(createInitialBehaviorPolicyState(), candidate);
    const contradictoryEvent = {
      type: "clock-tick",
      intentRef: getBehaviorIntentRef(candidate),
      nowMs: 100
    } as never;
    state = reduceBehaviorPolicy(state, contradictoryEvent, context({ nowMs: 199 }));
    expect(activeId(state)).toBe("timed");
    state = reduceBehaviorPolicy(state, contradictoryEvent, context({ nowMs: 200 }));
    expect(state.active).toEqual({ kind: "none" });

    const future = intent({
      intentId: "future",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      createdAtMs: 200,
      expiresAtMs: 300
    });
    expect(
      submit(createInitialBehaviorPolicyState(), future, context({ nowMs: 100 })).active
    ).toEqual({ kind: "none" });
  });

  it("fails closed for invalid authoritative context time", () => {
    const active = intent({ intentId: "active", kind: "gaze", priority: "P0", scope: "turn" });
    const state = submit(createInitialBehaviorPolicyState(), active);
    for (const nowMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(
        reduceBehaviorPolicy(
          state,
          { type: "clock-tick", intentRef: getBehaviorIntentRef(active) },
          context({ nowMs })
        ).active
      ).toEqual({ kind: "none" });
    }
  });

  it("fails safely for malformed and unknown events without turning them into reset", () => {
    const active = intent({ intentId: "active", kind: "gaze", priority: "P0", scope: "turn" });
    const state = submit(createInitialBehaviorPolicyState(), active);
    const malformedIdentity = intent({
      intentId: "",
      kind: "gaze",
      priority: "P0",
      scope: "turn"
    });
    const invalidPayload = intent({
      intentId: "invalid-payload",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      payload: { target: "raw-x-y", strength: 1 } as never
    });
    expect(submit(createInitialBehaviorPolicyState(), malformedIdentity).active).toEqual({
      kind: "none"
    });
    expect(submit(createInitialBehaviorPolicyState(), invalidPayload).active).toEqual({
      kind: "none"
    });
    const malformedEvents = [
      { type: "cancel-intent" },
      { type: "release-intent" },
      { type: "clock-tick" },
      { type: "submit-intent", intent: null },
      { type: "unknown" },
      null
    ] as never[];
    for (const event of malformedEvents) {
      const next = reduceBehaviorPolicy(state, event, baseContext);
      expect(next).toEqual(state);
      expect(next).not.toBeUndefined();
    }

    const expired = reduceBehaviorPolicy(
      submit(createInitialBehaviorPolicyState(), active),
      { type: "unknown" } as never,
      context({ nowMs: 500 })
    );
    expect(expired.active).toEqual({ kind: "none" });
  });

  it("does not allow an invalid high-priority candidate to erase valid state", () => {
    const ambient = intent({
      intentId: "ambient",
      kind: "proactive",
      priority: "P3",
      scope: "turn"
    });
    const forged = intent({
      intentId: "forged",
      kind: "proactive",
      priority: "P0",
      scope: "turn",
      createdAtMs: 90
    });
    const state = submit(createInitialBehaviorPolicyState(), ambient);
    expect(submit(state, forged).active).toEqual(ambient);
  });

  it("is source-reviewable as a pure semantic module", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs
      .readFile(new URL("./behavior-policy.ts", import.meta.url), "utf8")
      .catch(() => fs.readFile(new URL("../../src/behavior-policy.ts", import.meta.url), "utf8"));
    for (const forbidden of [
      "React",
      "window",
      "document",
      "Date.now",
      "performance.now",
      "Math.random",
      "setTimeout",
      "setInterval",
      "requestAnimationFrame",
      "BroadcastChannel",
      "Audio",
      "CompanionBus",
      "fetch",
      "Cubism",
      "DeepSeek",
      "xAI",
      "DashScope",
      "Mem0",
      "provider"
    ]) {
      const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = forbidden === "React" ? `\\b${escaped}\\b` : escaped;
      expect(source).not.toMatch(new RegExp(pattern, "i"));
    }
  });
});
