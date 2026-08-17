import { describe, expect, it } from "vitest";
import { createInitialBehaviorPolicyState } from "./behavior-policy.js";
import {
  evaluateSilentAttentionEligibility,
  SILENT_ATTENTION_COOLDOWN_MS,
  SILENT_ATTENTION_IDLE_DELAY_MS
} from "./proactive-eligibility.js";
import {
  createInitialCompanionPresence,
  type CompanionPresenceProjection
} from "./companion-presence.js";

function presence(
  overrides: Partial<CompanionPresenceProjection> = {}
): CompanionPresenceProjection {
  return {
    ...createInitialCompanionPresence("online"),
    capabilities: { tts: "unknown", audio: "unknown", live2d: "available" },
    ...overrides
  };
}

function input(
  overrides: Partial<Parameters<typeof evaluateSilentAttentionEligibility>[0]> = {}
): Parameters<typeof evaluateSilentAttentionEligibility>[0] {
  return {
    presence: presence(),
    visible: true,
    sessionId: "session-a",
    policyState: createInitialBehaviorPolicyState(),
    nowMs: SILENT_ATTENTION_IDLE_DELAY_MS,
    idleSinceMs: 0,
    lastSilentAttentionAtMs: null,
    consumedThisIdleEpisode: false,
    attemptedThisIdleEpisode: false,
    enabled: true,
    ...overrides
  };
}

describe("evaluateSilentAttentionEligibility", () => {
  it.each([
    ["hidden", { visible: false }, "hidden"],
    ["invalid session", { sessionId: "   " }, "invalid-session"],
    ["listening", { presence: presence({ activity: "listening" }) }, "not-idle"],
    ["thinking", { presence: presence({ activity: "thinking" }) }, "not-idle"],
    ["active lifecycle", { presence: presence({ lifecycle: "active" }) }, "lifecycle-active"],
    ["queued speech", { presence: presence({ speech: "queued" }) }, "speech-busy"],
    ["preparing speech", { presence: presence({ speech: "preparing" }) }, "speech-busy"],
    ["ready speech", { presence: presence({ speech: "ready" }) }, "speech-busy"],
    ["active speech", { presence: presence({ speech: "active" }) }, "speech-busy"],
    ["interrupted", { presence: presence({ transition: "interrupted" }) }, "interrupted"],
    ["unknown connectivity", { presence: presence({ connectivity: "unknown" }) }, "offline"],
    ["reconnecting", { presence: presence({ connectivity: "reconnecting" }) }, "offline"],
    ["offline", { presence: presence({ connectivity: "offline" }) }, "offline"],
    [
      "unknown Live2D",
      {
        presence: presence({
          capabilities: { tts: "unknown", audio: "unknown", live2d: "unknown" }
        })
      },
      "live2d-unavailable"
    ],
    [
      "unavailable Live2D",
      {
        presence: presence({
          capabilities: { tts: "unknown", audio: "unknown", live2d: "unavailable" }
        })
      },
      "live2d-unavailable"
    ],
    ["disabled", { enabled: false }, "disabled"]
  ])("blocks %s", (_label, overrides, reason) => {
    const result = evaluateSilentAttentionEligibility(input(overrides));
    expect(result).toMatchObject({
      eligible: false,
      baseEligible: false,
      reason,
      nextCheckAtMs: null
    });
  });

  it("does not require TTS or audio", () => {
    const result = evaluateSilentAttentionEligibility(
      input({
        presence: presence({
          capabilities: { tts: "unavailable", audio: "unavailable", live2d: "available" }
        })
      })
    );
    expect(result).toMatchObject({ eligible: true, baseEligible: true, reason: "eligible" });
  });

  it("blocks while policy state is occupied without ending the idle episode", () => {
    const policyState = {
      active: {
        intentId: "active-thinking",
        source: "lifecycle",
        reason: "thinking",
        priority: "P1",
        createdAtMs: 0,
        expiresAtMs: 20_000,
        scope: "turn",
        epoch: "turn-a",
        kind: "gaze",
        payload: { target: "down-thoughtful", strength: 1 }
      }
    } as Parameters<typeof evaluateSilentAttentionEligibility>[0]["policyState"];
    const result = evaluateSilentAttentionEligibility(input({ policyState }));
    expect(result).toMatchObject({
      eligible: false,
      baseEligible: true,
      reason: "policy-busy",
      nextCheckAtMs: null
    });
  });

  it("returns the exact idle-delay boundary", () => {
    const before = evaluateSilentAttentionEligibility(
      input({ nowMs: SILENT_ATTENTION_IDLE_DELAY_MS - 1 })
    );
    expect(before).toMatchObject({
      eligible: false,
      baseEligible: true,
      reason: "idle-delay",
      nextCheckAtMs: SILENT_ATTENTION_IDLE_DELAY_MS
    });

    const at = evaluateSilentAttentionEligibility(input({ nowMs: SILENT_ATTENTION_IDLE_DELAY_MS }));
    expect(at).toMatchObject({ eligible: true, reason: "eligible", nextCheckAtMs: null });
  });

  it("returns the exact cooldown boundary", () => {
    const lastAttentionAtMs = 10_000;
    const before = evaluateSilentAttentionEligibility(
      input({
        nowMs: lastAttentionAtMs + SILENT_ATTENTION_COOLDOWN_MS - 1,
        lastSilentAttentionAtMs: lastAttentionAtMs
      })
    );
    expect(before).toMatchObject({
      eligible: false,
      reason: "cooldown",
      nextCheckAtMs: lastAttentionAtMs + SILENT_ATTENTION_COOLDOWN_MS
    });

    const at = evaluateSilentAttentionEligibility(
      input({
        nowMs: lastAttentionAtMs + SILENT_ATTENTION_COOLDOWN_MS,
        lastSilentAttentionAtMs: lastAttentionAtMs
      })
    );
    expect(at).toMatchObject({ eligible: true, reason: "eligible" });
  });

  it("uses the later of idle delay and cooldown", () => {
    const result = evaluateSilentAttentionEligibility(
      input({
        nowMs: 20_000,
        idleSinceMs: 0,
        lastSilentAttentionAtMs: 10_000
      })
    );
    expect(result).toMatchObject({
      eligible: false,
      reason: "cooldown",
      nextCheckAtMs: 40_000
    });
  });

  it.each([
    ["budget", { consumedThisIdleEpisode: true }, "idle-budget"],
    ["failed attempt", { attemptedThisIdleEpisode: true }, "attempted"]
  ])("blocks after %s", (_label, overrides, reason) => {
    const result = evaluateSilentAttentionEligibility(input(overrides));
    expect(result).toMatchObject({ eligible: false, baseEligible: true, reason });
  });
});
