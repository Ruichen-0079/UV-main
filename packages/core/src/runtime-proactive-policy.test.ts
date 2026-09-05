import { describe, expect, it } from "vitest";
import {
  advanceActivityRevision,
  applyAuthorizedEngagement,
  applyCharacterProactiveProposal,
  canMutateDurableProactivePolicy,
  createInitialProactiveState,
  evaluateProactiveEligibility,
  normalizeProactiveState,
  parseIso8601DurationMs,
  parseProactivePolicySnapshot,
  serializeProactivePolicySnapshot
} from "./runtime-proactive-policy.js";

const t0 = Date.parse("2026-09-05T12:00:00Z");

describe("Runtime proactive policy", () => {
  it("admits when suppression is none and the clock is at or after eligible_after", () => {
    const state = createInitialProactiveState();
    expect(evaluateProactiveEligibility(state, t0, undefined)).toEqual({ admitted: true });
    expect(evaluateProactiveEligibility({ ...state, eligibleAfterMs: t0 + 1 }, t0, true)).toEqual({
      admitted: false,
      reason: "not-eligible"
    });
  });

  it("denies while UNTIL(time) is active and admits after the deadline without a second timer", () => {
    const suppressed = applyCharacterProactiveProposal(
      createInitialProactiveState(),
      { action: "SUPPRESS", scope: { kind: "UNTIL", duration: "PT5M" } },
      t0,
      "LOCAL_EXPLICIT_CONTROLLER"
    );
    expect(evaluateProactiveEligibility(suppressed, t0 + 5 * 60 * 1000 - 1, true)).toEqual({
      admitted: false,
      reason: "suppressed"
    });
    expect(evaluateProactiveEligibility(suppressed, t0 + 5 * 60 * 1000, true)).toEqual({
      admitted: true
    });
    expect(normalizeProactiveState(suppressed, t0 + 5 * 60 * 1000).suppression).toEqual({
      kind: "NONE"
    });
  });

  it("does not let untrusted input mutate durable suppression", () => {
    const kept = applyCharacterProactiveProposal(
      createInitialProactiveState(),
      { action: "SUPPRESS", scope: { kind: "UNTIL_EXPLICIT_RESUME" } },
      t0,
      "UNTRUSTED"
    );
    expect(kept.suppression).toEqual({ kind: "NONE" });
    expect(canMutateDurableProactivePolicy("UNTRUSTED")).toBe(false);
  });

  it("clears UNTIL_ENGAGEMENT only for authorized explicit engagement", () => {
    const suppressed = applyCharacterProactiveProposal(
      createInitialProactiveState(),
      { action: "SUPPRESS", scope: { kind: "UNTIL_ENGAGEMENT" } },
      t0,
      "LOCAL_EXPLICIT_CONTROLLER"
    );
    expect(applyAuthorizedEngagement(suppressed, t0, "UNTRUSTED").suppression).toEqual({
      kind: "UNTIL_ENGAGEMENT"
    });
    expect(
      applyAuthorizedEngagement(suppressed, t0, "LOCAL_EXPLICIT_CONTROLLER").suppression
    ).toEqual({ kind: "NONE" });
  });

  it("applies KEEP, CLEAR, DEFER, and SUPPRESS from an authorized controller", () => {
    const initial = createInitialProactiveState();
    expect(
      applyCharacterProactiveProposal(initial, { action: "KEEP" }, t0, "LOCAL_EXPLICIT_CONTROLLER")
    ).toEqual(initial);

    const suppressed = applyCharacterProactiveProposal(
      initial,
      { action: "SUPPRESS", scope: { kind: "UNTIL_EXPLICIT_RESUME" } },
      t0,
      "LOCAL_EXPLICIT_CONTROLLER"
    );
    expect(suppressed.suppression).toEqual({ kind: "UNTIL_EXPLICIT_RESUME" });

    const cleared = applyCharacterProactiveProposal(
      suppressed,
      { action: "CLEAR" },
      t0,
      "LOCAL_EXPLICIT_CONTROLLER"
    );
    expect(cleared.suppression).toEqual({ kind: "NONE" });

    const deferred = applyCharacterProactiveProposal(
      cleared,
      { action: "DEFER", horizon: "SHORT" },
      t0,
      "LOCAL_EXPLICIT_CONTROLLER"
    );
    expect(deferred.eligibleAfterMs).toBe(t0 + 30_000);
    expect(evaluateProactiveEligibility(deferred, t0 + 29_999, true)).toEqual({
      admitted: false,
      reason: "not-eligible"
    });
  });

  it("advances activity_revision and round-trips persistent suppression", () => {
    const next = advanceActivityRevision(createInitialProactiveState());
    expect(next.activityRevision).toBe(1);
    const suppressed = applyCharacterProactiveProposal(
      next,
      { action: "SUPPRESS", scope: { kind: "UNTIL_ENGAGEMENT" } },
      t0,
      "LOCAL_EXPLICIT_CONTROLLER"
    );
    const snapshot = serializeProactivePolicySnapshot(suppressed, false);
    const loaded = parseProactivePolicySnapshot(snapshot, t0);
    expect(loaded?.state.suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });
    expect(loaded?.state.activityRevision).toBe(0);
    expect(loaded?.consentEnabled).toBe(false);
  });

  it("parses PT5M as five minutes", () => {
    expect(parseIso8601DurationMs("PT5M")).toBe(5 * 60 * 1000);
  });
});
