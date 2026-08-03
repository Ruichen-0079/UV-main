/**
 * Persisted per-turn UI preference for TTS output in the main window.
 *
 * TTS output is a turn-level UI preference, not a Runtime-wide setting: the
 * main surface keeps it in localStorage, restores it on startup and mirrors
 * the current value to the companion window over the CompanionBus. No
 * Runtime settings reload is involved.
 */

export const VOICE_OUTPUT_STORAGE_KEY = "yuvi.main.voiceOutput";

export type VoiceOutputStorage = Pick<Storage, "getItem" | "setItem">;

export function defaultVoiceOutputStorage(): VoiceOutputStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readVoiceOutputPreference(
  storage: VoiceOutputStorage | null = defaultVoiceOutputStorage()
): boolean {
  try {
    return storage?.getItem(VOICE_OUTPUT_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeVoiceOutputPreference(
  enabled: boolean,
  storage: VoiceOutputStorage | null = defaultVoiceOutputStorage()
): void {
  try {
    storage?.setItem(VOICE_OUTPUT_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Storage can be unavailable (private browsing, SSR, restricted tests).
    // The in-memory React state still applies for the current session.
  }
}
