import { describe, expect, it } from "vitest";
import { dashboardVoicePlaybackStatusLabel } from "./App.js";

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
