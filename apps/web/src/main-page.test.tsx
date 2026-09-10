import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  correlateMainPlaybackStatus,
  MainPage,
  resolveSpeechCommandEpoch,
  voicePlaybackStatusLabel
} from "./main-page.js";
import { createSpeechPlaybackCorrelation } from "./speech-playback-correlation.js";

function renderMainPage(): string {
  return renderToStaticMarkup(<MainPage />);
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("MainPage product presentation", () => {
  it("renders a quiet conversation shell with history and one composer", () => {
    const markup = renderMainPage();

    expect(markup).toContain("yuvi-main-chat");
    expect(markup).toContain("What would you like to talk about?");
    expect(markup).toContain('aria-label="Chat message"');
    expect(markup).toContain('aria-label="Start Voice Mode"');
    expect(markup).toContain('aria-label="Send message"');
    expect(markup).toContain("Message YUVI");
  });

  it("keeps operational and debug controls out of ordinary Main", () => {
    const markup = renderMainPage();

    for (const hidden of [
      "Service status",
      "Chat History</",
      "Voice input</",
      "Turn Options",
      "Session ID",
      "Read Memory",
      "Write Memory",
      "TTS output",
      ">WebUI<",
      "显示形象",
      "隐藏形象",
      "重新打开",
      "companion connected",
      "companion offline",
      "Record voice",
      "Transcribe recording",
      "Type a runtime test message",
      "Latest trace"
    ]) {
      expect(markup).not.toContain(hidden);
    }
  });

  it("exposes one real PNG/JPEG image attachment input", () => {
    const markup = renderMainPage();
    expect(markup).toContain('type="file"');
    expect(markup).toContain('accept="image/png,image/jpeg"');
    expect(markup).toContain('aria-label="Image attachment"');
    expect(markup).toContain('aria-label="Attach image"');
  });

  it("renders safely when localStorage is unavailable", () => {
    expect(() => renderMainPage()).not.toThrow();
  });
});

describe("MainPage voice input", () => {
  it("exposes one microphone affordance backed by existing Voice Mode", () => {
    const markup = renderMainPage();
    expect(markup).toContain('aria-label="Start Voice Mode"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).not.toContain("Record voice");
    expect(markup).not.toContain("Transcribe recording");
  });
});

describe("MainPage speech lifecycle correlation", () => {
  it("retains the speech epoch after generation ownership ends", () => {
    expect(resolveSpeechCommandEpoch("turn-a", null)).toBe("turn-a");
    expect(resolveSpeechCommandEpoch(null, "turn-a")).toBe("turn-a");
    expect(resolveSpeechCommandEpoch(null, null)).toBeNull();
  });

  it("does not label queue scheduling as actual speaking", () => {
    expect(voicePlaybackStatusLabel("playing", false)).toBe("Speech queued…");
    expect(voicePlaybackStatusLabel("playing", true)).toBe("Speaking…");
  });

  it("keeps a newer segment speaking after an old terminal status", () => {
    let state = createSpeechPlaybackCorrelation();
    const first = { requestId: "turn-a", sequence: 0 };
    const second = { requestId: "turn-a", sequence: 1 };

    state = correlateMainPlaybackStatus(state, "started", first).state;
    state = correlateMainPlaybackStatus(state, "started", second).state;
    const stale = correlateMainPlaybackStatus(state, "terminal", first);

    expect(stale.accepted).toBe(false);
    expect(stale.state.active).toEqual(second);
  });
});
