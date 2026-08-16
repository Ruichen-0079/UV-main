import type {
  CompanionPresenceCapabilityState,
  CompanionPresenceConnectivity,
  CompanionPresenceProjection
} from "./companion-presence.js";
import {
  initialServiceStatusState,
  type ServiceStatusState,
  type ServiceLifecycle,
  type UiServiceSnapshot
} from "./service-status-state.js";
import type { CompanionTtsConfiguration } from "./companion-bus.js";
import type { LumiModelLifecycle } from "./lumi-live2d.js";

export type BrowserAudioCapability = CompanionPresenceCapabilityState;

export type CapabilityProjection = {
  connectivity: CompanionPresenceConnectivity;
  capabilities: {
    tts: CompanionPresenceCapabilityState;
    audio: BrowserAudioCapability;
    live2d: CompanionPresenceCapabilityState;
  };
  ttsServiceHealth: CompanionPresenceCapabilityState;
  ttsReason: string | null;
};

export type EffectiveVoiceOutput = {
  requestTts: boolean;
  reason: "persistent-disabled" | "settings-pending" | "voice-disabled" | "tts-unavailable" | null;
};

export function deriveRuntimeConnectivity(
  state: ServiceStatusState = initialServiceStatusState
): CompanionPresenceConnectivity {
  if (!state.ready && !state.instanceId) return "unknown";
  if (!state.connected) return state.instanceId ? "reconnecting" : "unknown";
  if (state.shuttingDown) return "reconnecting";

  const runtime = findService(state.services, "runtime");
  if (!runtime) return "unknown";
  return lifecycleToConnectivity(runtime.status);
}

export function deriveTtsServiceHealth(
  state: ServiceStatusState,
  configuration: CompanionTtsConfiguration | null
): CompanionPresenceCapabilityState {
  const wrapper = findService(state.services, "tts_wrapper");
  const upstream = findService(state.services, "tts_upstream");

  if (!wrapper) {
    // An external TTS service is not proven unhealthy merely because the
    // supervisor does not own or expose it. A managed service missing from an
    // authoritative connected snapshot is unavailable.
    if (state.connected && state.ready && configuration?.mode === "managed") {
      return "unavailable";
    }
    return "unknown";
  }

  const wrapperHealth = serviceToCapability(wrapper.status);
  if (wrapperHealth !== "available") return wrapperHealth;

  // The local wrapper delegates to an upstream when one is present. If the
  // supervisor does not report one, the wrapper's own health is sufficient
  // for external deployments.
  if (!upstream) return "available";
  const upstreamHealth = serviceToCapability(upstream.status);
  return upstreamHealth === "available" ? "available" : upstreamHealth;
}

export function deriveTtsCapability(
  persistentTtsEnabled: boolean | null,
  serviceHealth: CompanionPresenceCapabilityState
): { capability: CompanionPresenceCapabilityState; reason: string | null } {
  if (persistentTtsEnabled === false) {
    return { capability: "unavailable", reason: "TTS disabled by persistent settings." };
  }
  if (persistentTtsEnabled === null) {
    return { capability: "unknown", reason: "Persistent TTS settings are still loading." };
  }
  if (serviceHealth === "unavailable") {
    return { capability: "unavailable", reason: "TTS service is unavailable." };
  }
  if (serviceHealth === "unknown") {
    return { capability: "unknown", reason: "TTS service health is unknown." };
  }
  return { capability: "available", reason: null };
}

export function deriveLive2dCapability(
  lifecycle: LumiModelLifecycle
): CompanionPresenceCapabilityState {
  switch (lifecycle) {
    case "ready":
      return "available";
    case "failed":
    case "disposed":
      return "unavailable";
    case "loading":
      return "unknown";
  }
}

export function detectBrowserAudioCapability(): BrowserAudioCapability {
  if (typeof window === "undefined") return "unknown";
  return typeof globalThis.Audio === "function" ? "available" : "unavailable";
}

export function deriveCapabilityProjection(input: {
  serviceStatus?: ServiceStatusState;
  persistentTtsEnabled: boolean | null;
  ttsConfiguration: CompanionTtsConfiguration | null;
  audio: BrowserAudioCapability;
  live2dLifecycle: LumiModelLifecycle;
}): CapabilityProjection {
  const serviceStatus = input.serviceStatus ?? initialServiceStatusState;
  const ttsServiceHealth = deriveTtsServiceHealth(serviceStatus, input.ttsConfiguration);
  const tts = deriveTtsCapability(input.persistentTtsEnabled, ttsServiceHealth);
  return {
    connectivity: deriveRuntimeConnectivity(serviceStatus),
    capabilities: {
      tts: tts.capability,
      audio: input.audio,
      live2d: deriveLive2dCapability(input.live2dLifecycle)
    },
    ttsServiceHealth,
    ttsReason: tts.reason
  };
}

export function deriveEffectiveVoiceOutput(input: {
  persistentTtsEnabled: boolean | null;
  perTurnVoiceOutput: boolean;
  ttsCapability: CompanionPresenceCapabilityState;
}): EffectiveVoiceOutput {
  if (input.persistentTtsEnabled === false) {
    return { requestTts: false, reason: "persistent-disabled" };
  }
  if (input.persistentTtsEnabled === null) {
    return { requestTts: false, reason: "settings-pending" };
  }
  if (!input.perTurnVoiceOutput) {
    return { requestTts: false, reason: "voice-disabled" };
  }
  // Unknown is intentionally not treated as unavailable. In external mode,
  // supervisor absence does not prove that the configured TTS endpoint is
  // down; an actual synthesis failure remains item-level P5-B truth.
  if (input.ttsCapability === "unavailable") {
    return { requestTts: false, reason: "tts-unavailable" };
  }
  return { requestTts: true, reason: null };
}

/** Apply only connectivity/capability dimensions; activity and speech remain untouched. */
export function applyCapabilityProjection(
  current: CompanionPresenceProjection,
  projection: CapabilityProjection,
  reduce: (
    value: CompanionPresenceProjection,
    event:
      | { type: "connectivity"; state: CompanionPresenceConnectivity }
      | { type: "disconnect"; state: "offline" }
      | {
          type: "capability";
          capability: keyof CapabilityProjection["capabilities"];
          state: CompanionPresenceCapabilityState;
        }
  ) => CompanionPresenceProjection
): CompanionPresenceProjection {
  let next = current;
  const targetConnectivity = projection.connectivity;
  if (
    targetConnectivity === "offline" &&
    (next.connectivity !== "offline" || next.lifecycle === "active")
  ) {
    next = reduce(next, { type: "disconnect", state: "offline" });
  } else if (next.connectivity !== targetConnectivity) {
    next = reduce(next, { type: "connectivity", state: targetConnectivity });
  }

  for (const capability of ["tts", "audio", "live2d"] as const) {
    const state = projection.capabilities[capability];
    if (next.capabilities[capability] !== state) {
      next = reduce(next, { type: "capability", capability, state });
    }
  }
  return next;
}

function findService(
  services: UiServiceSnapshot[],
  id: UiServiceSnapshot["id"]
): UiServiceSnapshot | null {
  return services.find((service) => service.id === id) ?? null;
}

function lifecycleToConnectivity(status: ServiceLifecycle): CompanionPresenceConnectivity {
  switch (status) {
    case "healthy":
    case "degraded":
      return "online";
    case "starting":
    case "restarting":
      return "reconnecting";
    case "unavailable":
    case "stopped":
      return "offline";
  }
}

function serviceToCapability(status: ServiceLifecycle): CompanionPresenceCapabilityState {
  switch (status) {
    case "healthy":
    case "degraded":
      return "available";
    case "unavailable":
    case "stopped":
      return "unavailable";
    case "starting":
    case "restarting":
      return "unknown";
  }
}
