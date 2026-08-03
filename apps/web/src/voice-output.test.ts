import { describe, expect, it } from "vitest";
import {
  readVoiceOutputPreference,
  writeVoiceOutputPreference,
  VOICE_OUTPUT_STORAGE_KEY
} from "./voice-output.js";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function createStorage(
  initial: Record<string, string> = {}
): StorageLike & { writes: Array<[string, string]> } {
  const values = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
      writes.push([key, value]);
    },
    writes
  };
}

describe("TTS output preference", () => {
  it("initializes to false when nothing was stored", () => {
    expect(readVoiceOutputPreference(createStorage())).toBe(false);
  });

  it("reads the persisted value on startup", () => {
    expect(
      readVoiceOutputPreference(createStorage({ [VOICE_OUTPUT_STORAGE_KEY]: "true" }))
    ).toBe(true);
    expect(
      readVoiceOutputPreference(createStorage({ [VOICE_OUTPUT_STORAGE_KEY]: "false" }))
    ).toBe(false);
  });

  it("persists immediately on toggle", () => {
    const storage = createStorage();
    writeVoiceOutputPreference(true, storage);
    expect(storage.writes).toEqual([[VOICE_OUTPUT_STORAGE_KEY, "true"]]);
    expect(readVoiceOutputPreference(storage)).toBe(true);
  });

  it("returns the latest value after each change (no stale snapshot)", () => {
    const storage = createStorage();
    writeVoiceOutputPreference(false, storage);
    expect(readVoiceOutputPreference(storage)).toBe(false);
    writeVoiceOutputPreference(true, storage);
    expect(readVoiceOutputPreference(storage)).toBe(true);
    writeVoiceOutputPreference(false, storage);
    expect(readVoiceOutputPreference(storage)).toBe(false);
  });

  it("restores the preference after the main window is rebuilt", () => {
    const firstSession = createStorage();
    writeVoiceOutputPreference(true, firstSession);
    // A fresh window reads the same underlying storage.
    const secondSession = createStorage({
      [VOICE_OUTPUT_STORAGE_KEY]: firstSession.getItem(VOICE_OUTPUT_STORAGE_KEY) ?? "false"
    });
    expect(readVoiceOutputPreference(secondSession)).toBe(true);
  });

  it("never throws when storage is unavailable", () => {
    expect(readVoiceOutputPreference(null)).toBe(false);
    expect(() => writeVoiceOutputPreference(true, null)).not.toThrow();
  });
});
