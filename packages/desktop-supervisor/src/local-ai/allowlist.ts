import type { LocalAiServiceId, LocalAiStartPolicy } from "./types.js";

/**
 * The only systemd --user units this manager may inspect or control.
 * User-supplied unit names are never passed to systemctl.
 */
export const ALLOWLISTED_SYSTEMD_UNITS = {
  "alice.upstream": "gpt-sovits-upstream.service",
  "alice.wrapper": "alice-tts-wrapper.service",
  embedding: "yuvi-local-embedding.service"
} as const satisfies Partial<Record<LocalAiServiceId, string>>;

export type AllowlistedSystemdServiceId = keyof typeof ALLOWLISTED_SYSTEMD_UNITS;

export const ALLOWLISTED_SYSTEMD_UNIT_NAMES = new Set<string>(
  Object.values(ALLOWLISTED_SYSTEMD_UNITS)
);

export const LOCAL_AI_SERVICE_IDS: LocalAiServiceId[] = [
  "alice",
  "alice.upstream",
  "alice.wrapper",
  "embedding",
  "stt",
  "local-llm"
];

export const DEFAULT_START_POLICY: Record<LocalAiServiceId, LocalAiStartPolicy> = {
  alice: "ALWAYS",
  "alice.upstream": "ALWAYS",
  "alice.wrapper": "ALWAYS",
  embedding: "ALWAYS",
  stt: "ON_DEMAND",
  "local-llm": "MANUAL"
};

export function isLocalAiServiceId(value: string): value is LocalAiServiceId {
  return (LOCAL_AI_SERVICE_IDS as string[]).includes(value);
}

export function systemdUnitFor(id: LocalAiServiceId): string | null {
  if (id === "alice.upstream" || id === "alice.wrapper" || id === "embedding") {
    return ALLOWLISTED_SYSTEMD_UNITS[id];
  }
  return null;
}

export function assertAllowlistedUnit(unit: string): string {
  if (!ALLOWLISTED_SYSTEMD_UNIT_NAMES.has(unit)) {
    throw new Error(`systemd unit '${unit}' is not allowlisted for YUVI control.`);
  }
  return unit;
}
