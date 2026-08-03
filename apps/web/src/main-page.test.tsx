import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MainPage } from "./main-page.js";
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

  it("initializes the TTS checkbox off when nothing was stored", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {}
    };
    expect(readTtsToggleChecked(renderMainPage())).toBe(false);
  });

  it("renders without crashing when localStorage is unavailable", () => {
    expect(() => renderMainPage()).not.toThrow();
  });
});
