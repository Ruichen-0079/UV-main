import { describe, expect, it } from "vitest";
import {
  applyCapabilityProjection,
  deriveCapabilityProjection,
  deriveEffectiveVoiceOutput,
  deriveRuntimeConnectivity,
  deriveTtsCapability,
  deriveTtsServiceHealth
} from "./capability-projection.js";
import {
  createInitialCompanionPresence,
  reduceCompanionPresence,
  type CompanionPresenceProjection
} from "./companion-presence.js";
import {
  initialServiceStatusState,
  type ServiceStatusState,
  type UiServiceSnapshot
} from "./service-status-state.js";

function service(
  id: UiServiceSnapshot["id"],
  status: UiServiceSnapshot["status"],
  ownership: UiServiceSnapshot["ownership"] = "owned"
): UiServiceSnapshot {
  return {
    id,
    label: id,
    status,
    ownership,
    url: null,
    summary: status,
    detail: null,
    lastError: null,
    managed: ownership === "owned",
    canRestart: false,
    canStop: false,
    checkedAt: "2026-01-01T00:00:00.000Z"
  };
}

function status(
  services: UiServiceSnapshot[],
  overrides: Partial<ServiceStatusState> = {}
): ServiceStatusState {
  return {
    ...initialServiceStatusState,
    ready: true,
    connected: true,
    instanceId: "instance-a",
    services,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function apply(
  current: CompanionPresenceProjection,
  projection: ReturnType<typeof deriveCapabilityProjection>
): CompanionPresenceProjection {
  return applyCapabilityProjection(current, projection, reduceCompanionPresence);
}

describe("P5-D capability projection", () => {
  it("maps runtime/service/model truth without replacing activity", () => {
    const projection = deriveCapabilityProjection({
      serviceStatus: status([
        service("runtime", "healthy"),
        service("tts_wrapper", "unavailable"),
        service("tts_upstream", "unavailable")
      ]),
      persistentTtsEnabled: true,
      ttsConfiguration: { enabled: true, mode: "managed" },
      audio: "available",
      live2dLifecycle: "ready"
    });
    expect(projection).toMatchObject({
      connectivity: "online",
      capabilities: { tts: "unavailable", audio: "available", live2d: "available" }
    });

    let current = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-a"
    });
    current = reduceCompanionPresence(current, {
      type: "generation",
      epoch: "turn-a",
      state: "thinking"
    });
    expect(apply(current, projection).activity).toBe("thinking");
  });

  it("represents reconnecting and Live2D failure independently", () => {
    const projection = deriveCapabilityProjection({
      serviceStatus: status([], { connected: false }),
      persistentTtsEnabled: true,
      ttsConfiguration: { enabled: true, mode: "external" },
      audio: "available",
      live2dLifecycle: "failed"
    });
    expect(projection.connectivity).toBe("reconnecting");
    expect(projection.capabilities.live2d).toBe("unavailable");

    const current = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-a"
    });
    const next = apply(current, projection);
    expect(next.activity).toBe("thinking");
    expect(next.capabilities.live2d).toBe("unavailable");
    expect(next.connectivity).toBe("reconnecting");
  });

  it("keeps queued speech non-speaking when audio is unavailable", () => {
    const projection = deriveCapabilityProjection({
      serviceStatus: status([service("runtime", "healthy")]),
      persistentTtsEnabled: true,
      ttsConfiguration: { enabled: true, mode: "external" },
      audio: "unavailable",
      live2dLifecycle: "ready"
    });
    let current = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-a"
    });
    current = reduceCompanionPresence(current, {
      type: "queue",
      epoch: "turn-a",
      state: "playing"
    });
    current = apply(current, projection);
    expect(current.speech).toBe("queued");
    expect(current.speech).not.toBe("active");
    expect(current.capabilities.audio).toBe("unavailable");
  });

  it("does not stop active playback for unrelated service degradation", () => {
    let current = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-a"
    });
    current = reduceCompanionPresence(current, {
      type: "playback",
      epoch: "turn-a",
      state: "started"
    });
    const projection = deriveCapabilityProjection({
      serviceStatus: status([
        service("runtime", "healthy"),
        service("mem0", "degraded"),
        service("postgres", "unavailable")
      ]),
      persistentTtsEnabled: true,
      ttsConfiguration: { enabled: true, mode: "external" },
      audio: "available",
      live2dLifecycle: "ready"
    });
    const next = apply(current, projection);
    expect(next.speech).toBe("active");
    expect(next.activity).toBe("thinking");
  });

  it("keeps the no-interaction ready state idle", () => {
    const projection = deriveCapabilityProjection({
      serviceStatus: status([service("runtime", "healthy")]),
      persistentTtsEnabled: true,
      ttsConfiguration: { enabled: true, mode: "external" },
      audio: "available",
      live2dLifecycle: "ready"
    });
    const next = apply(createInitialCompanionPresence(), projection);
    expect(next.activity).toBe("idle");
    expect(next.capabilities.live2d).toBe("available");
  });

  it("maps runtime lifecycle and missing supervisor evidence conservatively", () => {
    expect(deriveRuntimeConnectivity(initialServiceStatusState)).toBe("unknown");
    expect(deriveRuntimeConnectivity(status([service("runtime", "degraded")]))).toBe("online");
    expect(deriveRuntimeConnectivity(status([service("runtime", "starting")]))).toBe(
      "reconnecting"
    );
    expect(deriveRuntimeConnectivity(status([service("runtime", "stopped")]))).toBe("offline");
    expect(deriveRuntimeConnectivity(status([]))).toBe("unknown");
    expect(
      deriveRuntimeConnectivity(status([], { connected: false, instanceId: "instance-a" }))
    ).toBe("reconnecting");
  });

  it("composes managed and external TTS service health explicitly", () => {
    expect(
      deriveTtsServiceHealth(
        status([service("tts_wrapper", "healthy"), service("tts_upstream", "healthy")]),
        { enabled: true, mode: "managed" }
      )
    ).toBe("available");
    expect(
      deriveTtsServiceHealth(
        status([service("tts_wrapper", "healthy"), service("tts_upstream", "starting")]),
        { enabled: true, mode: "managed" }
      )
    ).toBe("unknown");
    expect(deriveTtsServiceHealth(status([]), { enabled: true, mode: "managed" })).toBe(
      "unavailable"
    );
    expect(deriveTtsServiceHealth(status([]), { enabled: true, mode: "external" })).toBe("unknown");
  });

  it("applies the persistent/per-turn/service precedence table", () => {
    expect(deriveTtsCapability(false, "available").capability).toBe("unavailable");
    expect(
      deriveEffectiveVoiceOutput({
        persistentTtsEnabled: false,
        perTurnVoiceOutput: true,
        ttsCapability: "available"
      }).requestTts
    ).toBe(false);
    expect(
      deriveEffectiveVoiceOutput({
        persistentTtsEnabled: true,
        perTurnVoiceOutput: false,
        ttsCapability: "available"
      }).requestTts
    ).toBe(false);
    expect(
      deriveEffectiveVoiceOutput({
        persistentTtsEnabled: true,
        perTurnVoiceOutput: true,
        ttsCapability: "available"
      }).requestTts
    ).toBe(true);
    expect(
      deriveEffectiveVoiceOutput({
        persistentTtsEnabled: true,
        perTurnVoiceOutput: true,
        ttsCapability: "unavailable"
      }).requestTts
    ).toBe(false);
    expect(
      deriveEffectiveVoiceOutput({
        persistentTtsEnabled: true,
        perTurnVoiceOutput: true,
        ttsCapability: "unknown"
      }).requestTts
    ).toBe(true);
  });

  it("preserves the active epoch on capability updates and invalidates only offline", () => {
    let current = reduceCompanionPresence(createInitialCompanionPresence(), {
      type: "turn-start",
      epoch: "turn-a"
    });
    current = reduceCompanionPresence(current, {
      type: "playback",
      epoch: "turn-a",
      state: "started"
    });
    const reconnecting = deriveCapabilityProjection({
      serviceStatus: status([], { connected: false }),
      persistentTtsEnabled: true,
      ttsConfiguration: { enabled: true, mode: "external" },
      audio: "available",
      live2dLifecycle: "ready"
    });
    current = apply(current, reconnecting);
    expect(current.connectivity).toBe("reconnecting");
    expect(current.speech).toBe("active");

    const offline = deriveCapabilityProjection({
      serviceStatus: status([service("runtime", "stopped")]),
      persistentTtsEnabled: true,
      ttsConfiguration: { enabled: true, mode: "external" },
      audio: "available",
      live2dLifecycle: "ready"
    });
    current = apply(current, offline);
    expect(current.connectivity).toBe("offline");
    expect(current.lifecycle).toBe("invalidated");
    expect(current.activity).toBe("idle");
  });
});
