import { describe, expect, it } from "vitest";
import {
  dashboardVoicePlaybackStatusLabel,
  deriveDashboardTtsPolicy,
  flushDashboardSpeechTail
} from "./App.js";
import {
  createInitialCompanionPresence,
  getCompanionPresentationState,
  reduceCompanionPresence
} from "./companion-presence.js";

describe("dashboard speech playback display", () => {
  it("does not present queue scheduling as actual speaking", () => {
    expect(dashboardVoicePlaybackStatusLabel("playing", false)).toBe("Speech queued…");
    expect(dashboardVoicePlaybackStatusLabel("playing", true)).toBe("Speaking…");
  });

  it("only presents speaking while browser playback is active", () => {
    expect(dashboardVoicePlaybackStatusLabel("synthesizing", false)).toBe("Preparing speech…");
    expect(dashboardVoicePlaybackStatusLabel("idle", false)).toBe("");
    expect(dashboardVoicePlaybackStatusLabel("error", false)).toContain("unavailable");
  });
});

describe("dashboard normalized Presence contract", () => {
  it("keeps speaking active after generation completes until playback ends", () => {
    let presence = createInitialCompanionPresence();
    presence = reduceCompanionPresence(presence, { type: "turn-start", epoch: "turn-a" });
    presence = reduceCompanionPresence(presence, {
      type: "generation",
      epoch: "turn-a",
      state: "idle"
    });
    presence = reduceCompanionPresence(presence, {
      type: "playback",
      epoch: "turn-a",
      state: "started"
    });

    expect(presence.lifecycle).toBe("generation-complete");
    expect(presence.speech).toBe("active");
    expect(getCompanionPresentationState(presence)).toBe("speaking");

    presence = reduceCompanionPresence(presence, {
      type: "playback",
      epoch: "turn-a",
      state: "ended"
    });
    expect(presence.speech).toBe("completed");
  });

  it("rejects a late terminal event from an older dashboard turn", () => {
    let presence = createInitialCompanionPresence();
    presence = reduceCompanionPresence(presence, { type: "turn-start", epoch: "turn-a" });
    presence = reduceCompanionPresence(presence, { type: "turn-start", epoch: "turn-b" });
    presence = reduceCompanionPresence(presence, {
      type: "playback",
      epoch: "turn-a",
      state: "ended"
    });

    expect(presence.epoch).toBe("turn-b");
    expect(presence.speech).toBe("inactive");
  });

  it("keeps model capability failure separate from dashboard activity", () => {
    let presence = createInitialCompanionPresence();
    presence = reduceCompanionPresence(presence, { type: "turn-start", epoch: "turn-a" });
    presence = reduceCompanionPresence(presence, {
      type: "capability",
      capability: "live2d",
      state: "unavailable"
    });

    expect(presence.activity).toBe("thinking");
    expect(presence.capabilities.live2d).toBe("unavailable");
  });
});

describe("dashboard effective TTS policy", () => {
  const policy = (
    mode: "managed" | "external",
    enabled: boolean,
    health: "unknown" | "available" | "unavailable",
    perTurnVoiceOutput = true
  ) =>
    deriveDashboardTtsPolicy({
      persistentTtsEnabled: enabled,
      perTurnVoiceOutput,
      ttsCapability: health,
      ttsConfiguration: { enabled, mode }
    });

  it("blocks managed unknown and allows external unknown", () => {
    expect(policy("managed", true, "unknown").requestTts).toBe(false);
    expect(policy("external", true, "unknown").requestTts).toBe(true);
  });

  it("keeps persistent and per-turn disablement authoritative", () => {
    expect(policy("managed", false, "available").requestTts).toBe(false);
    expect(policy("external", true, "available", false).requestTts).toBe(false);
  });
});

describe("dashboard failed-tail speech admission", () => {
  it("does not admit a failed tail when the current policy forbids TTS", () => {
    const enqueued: string[] = [];
    let finished = 0;
    const policy = deriveDashboardTtsPolicy({
      persistentTtsEnabled: true,
      perTurnVoiceOutput: true,
      ttsCapability: "unknown",
      ttsConfiguration: { enabled: true, mode: "managed" }
    });

    flushDashboardSpeechTail(
      ["tail"],
      policy.requestTts,
      (text) => enqueued.push(text),
      () => {
        finished += 1;
      }
    );

    expect(enqueued).toEqual([]);
    expect(finished).toBe(1);
  });

  it("blocks failed-tail admission after persistent TTS is disabled", () => {
    const enqueued: string[] = [];
    let finished = 0;
    const policy = deriveDashboardTtsPolicy({
      persistentTtsEnabled: false,
      perTurnVoiceOutput: true,
      ttsCapability: "available",
      ttsConfiguration: { enabled: false, mode: "managed" }
    });

    flushDashboardSpeechTail(
      ["tail"],
      policy.requestTts,
      (text) => enqueued.push(text),
      () => {
        finished += 1;
      }
    );

    expect(policy.requestTts).toBe(false);
    expect(enqueued).toEqual([]);
    expect(finished).toBe(1);
  });

  it("blocks failed-tail admission after the per-turn voice preference is disabled", () => {
    const enqueued: string[] = [];
    let finished = 0;
    const policy = deriveDashboardTtsPolicy({
      persistentTtsEnabled: true,
      perTurnVoiceOutput: false,
      ttsCapability: "available",
      ttsConfiguration: { enabled: true, mode: "managed" }
    });

    flushDashboardSpeechTail(
      ["tail"],
      policy.requestTts,
      (text) => enqueued.push(text),
      () => {
        finished += 1;
      }
    );

    expect(policy.requestTts).toBe(false);
    expect(enqueued).toEqual([]);
    expect(finished).toBe(1);
  });

  it("keeps failed-tail admission when the current policy allows TTS", () => {
    const enqueued: string[] = [];
    let finished = 0;
    const policy = deriveDashboardTtsPolicy({
      persistentTtsEnabled: true,
      perTurnVoiceOutput: true,
      ttsCapability: "unknown",
      ttsConfiguration: { enabled: true, mode: "external" }
    });

    flushDashboardSpeechTail(
      ["tail-1", "tail-2"],
      policy.requestTts,
      (text) => enqueued.push(text),
      () => {
        finished += 1;
      }
    );

    expect(enqueued).toEqual(["tail-1", "tail-2"]);
    expect(finished).toBe(1);
  });

  it("finishes an empty tail without admitting or cancelling speech", () => {
    const enqueued: string[] = [];
    let finished = 0;

    flushDashboardSpeechTail(
      [],
      false,
      (text) => enqueued.push(text),
      () => {
        finished += 1;
      }
    );

    expect(enqueued).toEqual([]);
    expect(finished).toBe(1);
  });
});
