import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  correlateMainPlaybackStatus,
  MainPage,
  resolveSpeechCommandEpoch,
  voicePlaybackStatusLabel
} from "./main-page.js";
import { createSpeechPlaybackCorrelation } from "./speech-playback-correlation.js";
import { VOICE_OUTPUT_STORAGE_KEY } from "./voice-output.js";

function renderMainPage(): string {
  return renderToStaticMarkup(<MainPage />);
}

function readTtsToggleChecked(markup: string): boolean {
  const toggle = markup.match(/<input[^>]*data-testid="tts-output-toggle"[^>]*>/)?.[0];
  expect(toggle, "expected the TTS output checkbox to be rendered").toBeTruthy();
  return toggle?.includes("checked") ?? false;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("MainPage TTS output preference", () => {
  it("initializes the TTS checkbox from the persisted preference", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => (key === VOICE_OUTPUT_STORAGE_KEY ? "true" : null),
      setItem: () => {}
    };
    expect(readTtsToggleChecked(renderMainPage())).toBe(true);
  });

  it("initializes the TTS checkbox on when nothing was stored", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {}
    };
    expect(readTtsToggleChecked(renderMainPage())).toBe(true);
  });

  it("renders without crashing when localStorage is unavailable", () => {
    expect(() => renderMainPage()).not.toThrow();
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
