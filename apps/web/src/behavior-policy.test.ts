import { describe, expect, it } from "vitest";
import {
  compareBehaviorPriority,
  createInitialBehaviorPolicyState,
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

function intent(overrides: IntentOverrides): BehaviorSemanticIntent {
  const common = {
    intentId: overrides.intentId ?? "intent-a",
    source: overrides.source ?? "user-interaction",
    reason: overrides.reason ?? "user-gesture",
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

  it("applies every priority boundary through the single reducer", () => {
    const precedence: Array<readonly ["P0" | "P1" | "P2" | "P3", "P1" | "P2" | "P3"]> = [
      ["P0", "P1"],
      ["P1", "P2"],
      ["P2", "P3"]
    ];
    for (const [higher, lower] of precedence) {
      const low = intent({
        intentId: `low-${lower}`,
        kind: "gaze",
        priority: lower,
        scope: "turn"
      });
      const high = intent({
        intentId: `high-${higher}`,
        kind: "gaze",
        priority: higher,
        scope: "turn",
        createdAtMs: 110
      });
      let state = submit(createInitialBehaviorPolicyState(), low);
      state = submit(state, high, context({ nowMs: 110 }));
      expect(activeId(state)).toBe(`high-${higher}`);
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
        { type: "release", intentId: candidate.intentId },
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
  });

  it("requires finite, non-negative TTL values with expiry after creation", () => {
    const valid = intent({ intentId: "valid", kind: "gaze", priority: "P0", scope: "turn" });
    expect(submit(createInitialBehaviorPolicyState(), valid).active).toEqual(valid);

    for (const timing of [
      { createdAtMs: Number.NaN, expiresAtMs: 500 },
      { createdAtMs: Number.POSITIVE_INFINITY, expiresAtMs: 500 },
      { createdAtMs: -1, expiresAtMs: 500 },
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
      createdAtMs: 110
    });
    let state = submit(createInitialBehaviorPolicyState(), ambient);
    state = submit(state, user, context({ nowMs: 110 }));
    expect(activeId(state)).toBe("user");
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", nowMs: 500 },
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
      { type: "clock-tick", nowMs: 500 },
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
    state = submit(state, stale, context({ nowMs: 130 }));
    expect(activeId(state)).toBe("newer");
  });

  it("clears active turn intent when Presence epoch changes and rejects late old events", () => {
    const oldTurn = intent({ intentId: "old-turn", kind: "gaze", priority: "P0", scope: "turn" });
    let state = submit(createInitialBehaviorPolicyState(), oldTurn);
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", nowMs: 120 },
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
      { type: "clock-tick", nowMs: 199 },
      context({ nowMs: 199 })
    );
    expect(activeId(state)).toBe("short");
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", nowMs: 200 },
      context({ nowMs: 200 })
    );
    expect(state.active).toEqual({ kind: "none" });
    state = reduceBehaviorPolicy(
      state,
      { type: "clock-tick", nowMs: 300 },
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
      { type: "clock-tick", intentId: "old", nowMs: 150 },
      context({ nowMs: 150 })
    );
    expect(activeId(state)).toBe("new");
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

  it("admits otherwise-valid visual intent only when Live2D is available", () => {
    const visual = intent({ intentId: "visual", kind: "attention", priority: "P1", scope: "turn" });
    expect(submit(createInitialBehaviorPolicyState(), visual).active).toEqual(visual);
  });

  it("releases an already-active visual intent after a Live2D capability downgrade", () => {
    const visual = intent({ intentId: "visual", kind: "gaze", priority: "P1", scope: "turn" });
    const active = submit(createInitialBehaviorPolicyState(), visual);
    const downgraded = reduceBehaviorPolicy(
      active,
      { type: "clock-tick", nowMs: 120 },
      context({
        nowMs: 120,
        presence: {
          ...baseContext.presence,
          capabilities: { ...baseContext.presence.capabilities, live2d: "unavailable" }
        }
      })
    );
    expect(downgraded.active).toEqual({ kind: "none" });
  });

  it("keeps proactive structure distinct from visual capability gating", () => {
    const proactive = intent({
      intentId: "proactive",
      kind: "proactive",
      priority: "P3",
      scope: "decision"
    });
    const next = submit(
      createInitialBehaviorPolicyState(),
      proactive,
      context({
        presence: {
          ...baseContext.presence,
          capabilities: { ...baseContext.presence.capabilities, live2d: "unknown" }
        }
      })
    );
    expect(next.active).toEqual(proactive);
  });

  it("releases P0 through P3 explicitly regardless of priority", () => {
    for (const priority of ["P0", "P1", "P2", "P3"] as const) {
      const active = intent({ intentId: priority, kind: "gaze", priority, scope: "turn" });
      const state = submit(createInitialBehaviorPolicyState(), active);
      const released = reduceBehaviorPolicy(
        state,
        { type: "release", intentId: priority },
        baseContext
      );
      expect(released.active).toEqual({ kind: "none" });
    }
  });

  it("keeps a newer active intent when an old release or cancellation arrives", () => {
    const first = intent({ intentId: "first", kind: "gaze", priority: "P2", scope: "turn" });
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
      { type: "release", intentId: "first" },
      context({ nowMs: 120 })
    );
    expect(activeId(state)).toBe("second");
    state = reduceBehaviorPolicy(
      state,
      { type: "cancel-intent", intentId: "first" },
      context({ nowMs: 120 })
    );
    expect(activeId(state)).toBe("second");
  });

  it("fails closed on malformed identity, invalid semantic payload, and invalid context time", () => {
    const malformed = intent({ intentId: "", kind: "gaze", priority: "P0", scope: "turn" });
    const invalidPayload = intent({
      intentId: "invalid-payload",
      kind: "gaze",
      priority: "P0",
      scope: "turn",
      payload: { target: "raw-x-y", strength: 1 } as never
    });
    expect(submit(createInitialBehaviorPolicyState(), malformed).active).toEqual({ kind: "none" });
    expect(submit(createInitialBehaviorPolicyState(), invalidPayload).active).toEqual({
      kind: "none"
    });
    expect(
      submit(
        createInitialBehaviorPolicyState(),
        intent({ intentId: "bad-context", kind: "gaze", priority: "P0", scope: "turn" }),
        context({ nowMs: Number.NaN })
      ).active
    ).toEqual({ kind: "none" });
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
      "setTimeout",
      "setInterval",
      "requestAnimationFrame",
      "Audio",
      "CompanionBus",
      "provider",
      "Cubism"
    ]) {
      expect(source.toLowerCase()).not.toMatch(new RegExp(`\\b${forbidden.toLowerCase()}\\b`));
    }
  });
});
