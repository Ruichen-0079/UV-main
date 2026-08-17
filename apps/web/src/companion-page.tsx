import { useEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "./api/client.js";
import {
  CompanionBus,
  type CompanionBusMessage,
  type CompanionTtsConfiguration
} from "./companion-bus.js";
import {
  applyCapabilityProjection,
  deriveCapabilityProjection,
  detectBrowserAudioCapability
} from "./capability-projection.js";
import {
  createCompanionPresenceEpochGuard,
  createInterruptedResetScheduler,
  createInitialCompanionPresence,
  canInterruptGeneration,
  getCompanionPresentationState,
  reduceCompanionPresence,
  type CompanionPresenceProjection
} from "./companion-presence.js";
import {
  createBehaviorPolicyController,
  type BehaviorPolicyController
} from "./behavior-policy-controller.js";
import { createCompanionSpeechBuffer } from "./companion-speech-buffer.js";
import { createCompanionReadyAnnouncer } from "./companion-voice-sync.js";
import { createSpeechSegmentDeduper } from "./speech-segment-dedup.js";
import {
  correlateSpeechPlayback,
  createSpeechPlaybackCorrelation,
  type SpeechPlaybackCorrelationState
} from "./speech-playback-correlation.js";
import { LumiCanvas } from "./lumi-canvas.js";
import type { LumiFraming } from "./lumi-cubism-model.js";
import type { LumiControllerHandle, LumiModelLifecycle } from "./lumi-live2d.js";
import { initialServiceStatusState, type ServiceStatusState } from "./service-status-state.js";
import {
  isServiceSupervisorAvailable,
  subscribeServiceStatusState
} from "./service-supervisor-client.js";
import {
  createBrowserSpeechPlayer,
  SpeechPlaybackQueue,
  type SpeechQueueState,
  type SpeechPlaybackEvent
} from "./speech-queue.js";
import type { SpeechSegmentIdentity } from "./speech-identity.js";
import {
  isTauriRuntime,
  preloadTauriWindowApi,
  startWindowResizeDragging
} from "./tauri-window.js";

/**
 * Desktop companion window surface: exclusively owns Lumi, the speech queue,
 * HTMLAudioElement playback, the AudioContext, the analyser and the mouth
 * envelope. The main window only forwards speech segments and stop commands.
 */
export function CompanionPage(): JSX.Element {
  const lumiRef = useRef<LumiControllerHandle>(null);
  const sessionRef = useRef<{
    requestId: string;
    queue: SpeechPlaybackQueue;
    deduper: ReturnType<typeof createSpeechSegmentDeduper>;
  } | null>(null);
  const speechBufferRef = useRef(createCompanionSpeechBuffer());
  const announcerRef = useRef<ReturnType<typeof createCompanionReadyAnnouncer> | null>(null);
  const [presence, setPresence] = useState<CompanionPresenceProjection>(() =>
    createInitialCompanionPresence()
  );
  const [voiceStatus, setVoiceStatus] = useState<SpeechQueueState>("idle");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceEnabledRef = useRef(true);
  const [ttsConfig, setTtsConfig] = useState<CompanionTtsConfiguration | null>(() =>
    isTauriRuntime() ? null : { enabled: true, mode: "external" }
  );
  const ttsConfigRef = useRef(ttsConfig);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusState>(initialServiceStatusState);
  const [modelLifecycle, setModelLifecycle] = useState<LumiModelLifecycle>("loading");
  const audioCapability = useMemo(() => detectBrowserAudioCapability(), []);
  const [framing, setFraming] = useState<LumiFraming>("half");
  const presenceProjectionRef = useRef<CompanionPresenceProjection | null>(null);
  const activeEpochRef = useRef<string | null>(null);
  const speechStoppedEpochRef = useRef<string | null>(null);
  const playbackCorrelationRef = useRef<SpeechPlaybackCorrelationState>(
    createSpeechPlaybackCorrelation()
  );
  const epochGuardRef = useRef(createCompanionPresenceEpochGuard());
  const interruptedResetRef = useRef<ReturnType<typeof createInterruptedResetScheduler> | null>(
    null
  );
  const behaviorControllerRef = useRef<BehaviorPolicyController | null>(null);
  const behaviorSessionIdRef = useRef("companion-page-session");
  presenceProjectionRef.current = presence;
  ttsConfigRef.current = ttsConfig;

  const capabilityProjection = useMemo(
    () =>
      deriveCapabilityProjection({
        serviceStatus,
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        ttsConfiguration: ttsConfig,
        audio: audioCapability,
        live2dLifecycle: modelLifecycle
      }),
    [audioCapability, modelLifecycle, serviceStatus, ttsConfig]
  );

  function updatePresence(
    update: (current: CompanionPresenceProjection) => CompanionPresenceProjection
  ): void {
    const current = presenceProjectionRef.current ?? presence;
    const next = update(current);
    if (next === current) return;
    presenceProjectionRef.current = next;
    // Feed the same normalized transition synchronously. React state remains
    // the render/configuration surface and is not the animation clock.
    behaviorControllerRef.current?.updatePresence(next);
    lumiRef.current?.setPresentationProjection(next);
    setPresence(next);
  }

  useEffect(() => {
    const controller = createBehaviorPolicyController({
      sessionId: behaviorSessionIdRef.current,
      controllerId: "companion-page",
      now: () => performance.now(),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      setGazeTarget: (target) => lumiRef.current?.setGazeTarget(target)
    });
    behaviorControllerRef.current = controller;
    const syncVisibility = (): void => {
      controller.updateVisibility(
        typeof document !== "undefined" && document.visibilityState === "visible"
      );
    };
    const handleVisibilityChange = (): void => {
      syncVisibility();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    syncVisibility();
    controller.updatePresence(presenceProjectionRef.current ?? presence);

    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      controller.dispose();
      if (behaviorControllerRef.current === controller) {
        behaviorControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() && !isServiceSupervisorAvailable()) return;
    return subscribeServiceStatusState(setServiceStatus);
  }, []);

  useEffect(() => {
    updatePresence((current) =>
      applyCapabilityProjection(current, capabilityProjection, (value, event) =>
        reduceCompanionPresence(value, event)
      )
    );
  }, [capabilityProjection]);

  useEffect(() => {
    const bus = new CompanionBus("companion");
    const announcer = createCompanionReadyAnnouncer(bus);
    announcerRef.current = announcer;
    announcer.start();
    void preloadTauriWindowApi();
    const speechBuffer = speechBufferRef.current;

    function recordSpeechLedger(
      requestId: string,
      sequence: number | null,
      stage: string,
      extra?: Record<string, unknown>
    ): void {
      if (!import.meta.env.DEV || typeof window === "undefined") return;
      const debugWindow = window as typeof window & {
        __yuviSpeechLedger?: Array<Record<string, unknown>>;
      };
      const ledger = (debugWindow.__yuviSpeechLedger ??= []);
      ledger.push({
        at: performance.now(),
        requestId,
        sequence,
        stage,
        ...extra
      });
      // Keep the ledger bounded for multi-turn sessions.
      if (ledger.length > 400) ledger.splice(0, ledger.length - 400);
    }

    function enqueueSpeak(
      session: NonNullable<typeof sessionRef.current>,
      segment: { sequence: number; text: string; language: string }
    ): void {
      if (!session.deduper.isNew(session.requestId, segment.sequence)) {
        recordSpeechLedger(session.requestId, segment.sequence, "dedup-drop");
        return;
      }
      recordSpeechLedger(session.requestId, segment.sequence, "queued", {
        text: segment.text,
        language: segment.language
      });
      session.queue.enqueue(
        { text: segment.text, language: segment.language },
        { requestId: session.requestId, sequence: segment.sequence }
      );
    }

    function acceptPlaybackEvent(event: SpeechPlaybackEvent): {
      accepted: boolean;
      segment: SpeechSegmentIdentity;
    } {
      const phase =
        event.type === "audioElementAttached"
          ? "attached"
          : event.type === "playbackStarted"
            ? "started"
            : event.type === "audioElementDetached"
              ? "detached"
              : "terminal";
      const result = correlateSpeechPlayback(playbackCorrelationRef.current, phase, event.segment);
      playbackCorrelationRef.current = result.state;
      return { accepted: result.accepted, segment: event.segment };
    }

    function startGeneration(requestId: string, sessionId: string): void {
      if (!epochGuardRef.current.accept(requestId)) return;
      // A new turn replaces the previous speech session: old audio stops,
      // stale presence is reset and synthesis restarts from a fresh queue.
      recordSpeechLedger(requestId, null, "turn-start");
      activeEpochRef.current = requestId;
      speechStoppedEpochRef.current = null;
      const previous = sessionRef.current;
      previous?.queue.cancel();
      sessionRef.current = null;
      playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
      speechBuffer.setActiveTurn(requestId);
      updatePresence((current) =>
        reduceCompanionPresence(current, { type: "turn-start", epoch: requestId })
      );
      if (!voiceEnabledRef.current) {
        setVoiceStatus("idle");
        speechBuffer.clear();
        return;
      }
      if (ttsConfigRef.current?.enabled !== true) {
        setVoiceStatus("idle");
        speechBuffer.clear();
        return;
      }
      const queue = new SpeechPlaybackQueue(
        (item, signal) =>
          apiClient.synthesizeSpeech({
            text: item.text,
            language: item.language,
            format: "wav",
            sessionId,
            signal
          }),
        createBrowserSpeechPlayer(),
        {
          onState: (state) => {
            const session = sessionRef.current;
            if (!session || session.queue !== queue) return;
            setVoiceStatus(state);
            updatePresence((current) =>
              reduceCompanionPresence(current, {
                type: "queue",
                epoch: session.requestId,
                state
              })
            );
            bus.post({ kind: "speech-status", requestId: session.requestId, state });
          },
          onItemState: (segment, state) => {
            recordSpeechLedger(segment.requestId, segment.sequence, state);
            if (import.meta.env.DEV) {
              const states = ((
                window as unknown as {
                  __yuviSpeechStates?: Record<string, string>;
                }
              ).__yuviSpeechStates ??= {});
              states[`${segment.requestId}:${segment.sequence}`] = state;
            }
          },
          onError: () => {
            const session = sessionRef.current;
            if (!session || session.queue !== queue) return;
            setVoiceStatus("error");
            updatePresence((current) =>
              reduceCompanionPresence(current, {
                type: "queue",
                epoch: session.requestId,
                state: "error"
              })
            );
            bus.post({ kind: "speech-status", requestId: session.requestId, state: "error" });
          },
          onPlaybackEvent: (event) => {
            const session = sessionRef.current;
            if (!session || session.queue !== queue || event.segment.requestId !== requestId)
              return;
            const accepted = acceptPlaybackEvent(event);
            if (!accepted.accepted) return;
            if (event.type === "playbackStarted") {
              recordSpeechLedger(requestId, event.segment.sequence, "audio.play", {
                queueSequence: event.sequence
              });
            }
            const playbackState =
              event.type === "playbackStarted"
                ? "started"
                : event.type === "playbackEnded"
                  ? "ended"
                  : event.type === "playbackStopped"
                    ? "stopped"
                    : event.type === "playbackError"
                      ? "error"
                      : null;
            if (playbackState !== null) {
              updatePresence((current) =>
                reduceCompanionPresence(current, {
                  type: "playback",
                  epoch: requestId,
                  state: playbackState
                })
              );
              bus.post({
                kind: "playback-status",
                requestId,
                segmentSequence: event.segment.sequence,
                state: playbackState
              });
            }
            lumiRef.current?.handlePlaybackEvent(event);
          }
        }
      );
      const session = { requestId, queue, deduper: createSpeechSegmentDeduper() };
      sessionRef.current = session;
      setVoiceStatus("synthesizing");

      // Flush any segments that arrived before the session existed. Buffer is
      // scoped to the active turn only — never replays old turns.
      for (const buffered of speechBuffer.drain(requestId)) {
        recordSpeechLedger(requestId, buffered.sequence, "pre-ready-flush");
        enqueueSpeak(session, buffered);
      }
    }

    function handleSpeak(message: Extract<CompanionBusMessage, { kind: "speak" }>): void {
      if (
        activeEpochRef.current !== message.requestId ||
        speechStoppedEpochRef.current === message.requestId
      ) {
        recordSpeechLedger(message.requestId, message.sequence, "stale-speak-drop");
        return;
      }
      if (!voiceEnabledRef.current) {
        recordSpeechLedger(message.requestId, message.sequence, "voice-disabled-drop");
        return;
      }
      if (ttsConfigRef.current?.enabled !== true) {
        recordSpeechLedger(message.requestId, message.sequence, "tts-disabled-drop");
        return;
      }
      recordSpeechLedger(message.requestId, message.sequence, "companion-receive", {
        text: message.text,
        language: message.language
      });
      const session = sessionRef.current;
      if (session && session.requestId === message.requestId) {
        enqueueSpeak(session, message);
        return;
      }
      // Session not ready yet: keep a bounded pre-ready buffer for this turn.
      // Do not silently discard sequence 0 while start-generation is in flight.
      const accepted = speechBuffer.push({
        requestId: message.requestId,
        sequence: message.sequence,
        text: message.text,
        language: message.language
      });
      recordSpeechLedger(
        message.requestId,
        message.sequence,
        accepted ? "pre-ready-buffer" : "buffer-reject"
      );
    }

    function handleMessage(message: CompanionBusMessage): void {
      switch (message.kind) {
        case "user-gesture":
          updatePresence((current) =>
            reduceCompanionPresence(current, { type: "interaction", state: "listening" })
          );
          lumiRef.current?.resumeAudio();
          return;
        case "start-generation":
          startGeneration(message.requestId, message.sessionId);
          return;
        case "voice-enabled":
          // Preference sync must never cancel an in-flight turn. Only an
          // explicit disable stops speech; enable is a no-op for the queue.
          announcerRef.current?.markSynced();
          voiceEnabledRef.current = message.enabled;
          setVoiceEnabled(message.enabled);
          recordSpeechLedger("sync", null, "voice-enabled", { enabled: message.enabled });
          if (!message.enabled) {
            const session = sessionRef.current;
            const epoch = activeEpochRef.current;
            if (epoch) {
              speechStoppedEpochRef.current = epoch;
              updatePresence((current) =>
                reduceCompanionPresence(current, { type: "speech-cancelled", epoch })
              );
            }
            if (session) session.queue.cancel();
            sessionRef.current = null;
            playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
            speechBuffer.clear();
          }
          return;
        case "tts-config":
          // This is configuration intent from MainPage, not service health.
          // A disabled persistent setting suppresses future synthesis but does
          // not cancel already-playing local audio.
          ttsConfigRef.current = message.config;
          setTtsConfig(message.config);
          return;
        case "speak":
          handleSpeak(message);
          return;
        case "speech-end": {
          const session = sessionRef.current;
          if (
            session &&
            session.requestId === message.requestId &&
            speechStoppedEpochRef.current !== message.requestId
          ) {
            session.queue.finish();
          }
          return;
        }
        case "stop-speech": {
          if (activeEpochRef.current !== message.requestId) return;
          const session = sessionRef.current;
          speechStoppedEpochRef.current = message.requestId;
          updatePresence((current) =>
            reduceCompanionPresence(current, {
              type: "speech-cancelled",
              epoch: message.requestId
            })
          );
          if (session && session.requestId === message.requestId) {
            session.queue.cancel();
          }
          sessionRef.current = null;
          playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
          speechBuffer.clear();
          recordSpeechLedger(message.requestId, null, "stop-speech");
          return;
        }
        case "generation-state":
          if (activeEpochRef.current !== message.requestId) return;
          if (
            message.state === "interrupted" &&
            !canInterruptGeneration(presenceProjectionRef.current ?? presence, message.requestId)
          ) {
            return;
          }
          updatePresence((current) =>
            reduceCompanionPresence(current, {
              type: "generation",
              epoch: message.requestId,
              state: message.state
            })
          );
          if (message.state === "interrupted") {
            speechStoppedEpochRef.current = message.requestId;
            sessionRef.current?.queue.cancel();
            sessionRef.current = null;
            playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
            speechBuffer.clear();
          }
          return;
        case "companion-ready":
        case "playback-status":
        case "speech-status":
          return;
      }
    }

    const unsubscribe = bus.subscribe(handleMessage);
    return () => {
      unsubscribe();
      announcer.stop();
      announcerRef.current = null;
      sessionRef.current?.queue.cancel();
      sessionRef.current = null;
      playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
      activeEpochRef.current = null;
      speechStoppedEpochRef.current = null;
      epochGuardRef.current.dispose();
      speechBuffer.clear();
      bus.close();
    };
  }, []);

  useEffect(() => {
    // Own the interrupted timer in this effect so React StrictMode remounts
    // get a live scheduler instead of a permanently disposed ref instance.
    const resetScheduler = createInterruptedResetScheduler(() => {
      updatePresence((current) =>
        current.epoch
          ? reduceCompanionPresence(current, {
              type: "transition-expired",
              epoch: current.epoch
            })
          : current
      );
    });
    interruptedResetRef.current = resetScheduler;
    return () => {
      resetScheduler.dispose();
      if (interruptedResetRef.current === resetScheduler) {
        interruptedResetRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (presence.transition === "interrupted" && presence.epoch) {
      interruptedResetRef.current?.schedule();
    } else {
      interruptedResetRef.current?.invalidate();
    }
  }, [presence.transition, presence.epoch]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent text-white">
      <LumiCanvas
        ref={lumiRef}
        requestedProjection={presence}
        onModelLifecycle={setModelLifecycle}
        className="h-full w-full rounded-none"
        showFramingToggle={false}
      />
      {/* Drag region above the canvas so WebView native drag is not stolen by WebGL. */}
      {isTauriRuntime() && (
        <div
          data-tauri-drag-region
          className="absolute inset-x-0 top-0 z-30 h-7 cursor-grab touch-none select-none border-b border-white/5 bg-white/5"
          aria-label="Drag window"
          title="Drag window"
        >
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/25" />
        </div>
      )}
      <div
        className="pointer-events-none absolute left-2 top-9 z-20 rounded bg-black/40 px-2 py-1 text-xs"
        aria-live="polite"
      >
        {presenceLabel(presence)} · {voiceStatusLabel(voiceStatus)} · voice{" "}
        {voiceEnabled ? "on" : "off"}
      </div>
      <button
        type="button"
        className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-ink-900/70 px-2 py-1 text-xs text-white"
        aria-pressed={framing === "full"}
        onClick={() =>
          setFraming((current) => {
            const next = current === "half" ? "full" : "half";
            lumiRef.current?.setFraming(next);
            return next;
          })
        }
      >
        {/* Label is the action target (not the current mode). Default is portrait/half. */}
        {framing === "half" ? "Full body" : "Portrait"}
      </button>
      {isTauriRuntime() && (
        <button
          type="button"
          aria-label="Resize window"
          className="absolute bottom-0 right-0 z-20 flex h-5 w-5 cursor-se-resize items-end justify-end rounded-tl-md bg-white/10 p-0.5 text-white/70 hover:bg-white/20 hover:text-white"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void startWindowResizeDragging("SouthEast");
          }}
        >
          <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" aria-hidden="true">
            <path
              d="M11 1v10H1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
      {import.meta.env.DEV && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/40 px-2 py-1 text-xs">
          companion window · open the main window to chat
        </div>
      )}
    </div>
  );
}

function presenceLabel(projection: CompanionPresenceProjection): string {
  const state = getCompanionPresentationState(projection);
  switch (state) {
    case "thinking":
      return "thinking";
    case "listening":
      return "listening";
    case "speaking":
      return "speaking";
    case "interrupted":
      return "interrupted";
    case "idle":
      return "idle";
  }
}

function voiceStatusLabel(state: SpeechQueueState): string {
  switch (state) {
    case "synthesizing":
      return "synthesizing";
    case "playing":
      return "playing";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    case "idle":
      return "idle";
  }
}
