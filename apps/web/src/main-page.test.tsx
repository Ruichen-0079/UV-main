import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  correlateMainPlaybackStatus,
  createRuntimeStreamRequest,
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

describe("MainPage voice input", () => {
  it("exposes ordinary microphone capture and transcription actions", () => {
    const markup = renderMainPage();
    expect(markup).toContain("Voice input");
    expect(markup).toContain("Record voice");
    expect(markup).toContain("Transcribe recording");
  });

  it("exposes a hands-free voice mode surface with an explicit state", () => {
    const markup = renderMainPage();
    expect(markup).toContain("Voice Mode");
    expect(markup).toContain("Start voice");
  });
});

describe("MainPage runtime request contract", () => {
  it("routes voice transcripts through the normal runtime path without double TTS", () => {
    const request = createRuntimeStreamRequest("default", "hello from voice mode", {
      readMemory: true,
      writeMemory: true,
      promptPreview: true
    });
    expect(request).toEqual({
      sessionId: "default",
      text: "hello from voice mode",
      options: {
        readMemory: true,
        writeMemory: true,
        voiceOutput: false,
        promptPreview: true
      }
    });
  });
});

describe("MainPage chat presentation", () => {
  it("does not render backend trace metadata in the ordinary chat surface", () => {
    expect(renderMainPage()).not.toContain("Latest trace");
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
