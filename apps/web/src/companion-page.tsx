import { useEffect, useRef, useState } from "react";
import { apiClient } from "./api/client.js";
import { CompanionBus, type CompanionBusMessage } from "./companion-bus.js";
import {
  createCompanionBlinkScheduler,
  createInterruptedResetScheduler,
  getCompanionAnimation,
  reduceCompanionPresence,
  type CompanionPresenceState
} from "./companion-presence.js";
import { createGazeScheduler } from "./companion-gaze.js";
import { createCompanionSpeechBuffer } from "./companion-speech-buffer.js";
import { createCompanionReadyAnnouncer } from "./companion-voice-sync.js";
import { createSpeechSegmentDeduper } from "./speech-segment-dedup.js";
import { LumiCanvas } from "./lumi-canvas.js";
import type { LumiFraming } from "./lumi-cubism-model.js";
import type { LumiControllerHandle, PresenceState } from "./lumi-live2d.js";
import {
  createBrowserSpeechPlayer,
  SpeechPlaybackQueue,
  type SpeechQueueState
} from "./speech-queue.js";
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
  const [presence, setPresence] = useState<CompanionPresenceState>("idle");
  const [voiceStatus, setVoiceStatus] = useState<SpeechQueueState>("idle");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceEnabledRef = useRef(true);
  const [framing, setFraming] = useState<LumiFraming>("half");
  const presenceRef = useRef<CompanionPresenceState>(presence);
  const blinkSchedulerRef = useRef<ReturnType<typeof createCompanionBlinkScheduler> | null>(null);
  const gazeSchedulerRef = useRef<ReturnType<typeof createGazeScheduler> | null>(null);
  const interruptedResetRef = useRef<ReturnType<typeof createInterruptedResetScheduler> | null>(
    null
  );
  presenceRef.current = presence;

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
        String(segment.sequence)
      );
    }

    function startGeneration(requestId: string, sessionId: string): void {
      // A new turn replaces the previous speech session: old audio stops,
      // stale presence is reset and synthesis restarts from a fresh queue.
      recordSpeechLedger(requestId, null, "turn-start");
      const previous = sessionRef.current;
      previous?.queue.cancel();
      sessionRef.current = null;
      speechBuffer.setActiveTurn(requestId);
      setPresence((current) =>
        reduceCompanionPresence(current, { type: "generation", state: "thinking" })
      );
      if (!voiceEnabledRef.current) {
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
            setPresence((current) => reduceCompanionPresence(current, { type: "queue", state }));
            bus.post({ kind: "speech-status", requestId: session.requestId, state });
          },
          onItemState: (id, state) => {
            const requestIdForItem = sessionRef.current?.requestId ?? "unknown";
            const sequence = id === undefined ? null : Number(id);
            recordSpeechLedger(requestIdForItem, Number.isFinite(sequence) ? sequence : null, state);
            if (import.meta.env.DEV && id !== undefined) {
              const states = ((window as unknown as {
                __yuviSpeechStates?: Record<string, string>;
              }).__yuviSpeechStates ??= {});
              states[`${requestIdForItem}:${id}`] = state;
            }
          },
          onError: () => {
            const session = sessionRef.current;
            if (!session || session.queue !== queue) return;
            setVoiceStatus("error");
            setPresence((current) =>
              reduceCompanionPresence(current, { type: "queue", state: "error" })
            );
            bus.post({ kind: "speech-status", requestId: session.requestId, state: "error" });
          },
          onPlaybackEvent: (event) => {
            if (sessionRef.current?.queue !== queue) return;
            if (event.type === "playbackStarted") {
              recordSpeechLedger(requestId, event.sequence, "audio.play");
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
      if (!voiceEnabledRef.current) {
        recordSpeechLedger(message.requestId, message.sequence, "voice-disabled-drop");
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
      recordSpeechLedger(message.requestId, message.sequence, accepted ? "pre-ready-buffer" : "buffer-reject");
    }

    function handleMessage(message: CompanionBusMessage): void {
      switch (message.kind) {
        case "user-gesture":
          setPresence((current) =>
            reduceCompanionPresence(current, { type: "generation", state: "listening" })
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
            if (session) session.queue.cancel();
            speechBuffer.clear();
          }
          return;
        case "speak":
          handleSpeak(message);
          return;
        case "speech-end": {
          const session = sessionRef.current;
          if (session && session.requestId === message.requestId) {
            session.queue.finish();
          }
          return;
        }
        case "stop-speech": {
          const session = sessionRef.current;
          setPresence((current) =>
            reduceCompanionPresence(current, { type: "queue", state: "stopped" })
          );
          if (session && session.requestId === message.requestId) {
            session.queue.cancel();
          }
          speechBuffer.clear();
          recordSpeechLedger(message.requestId, null, "stop-speech");
          return;
        }
        case "generation-state":
          setPresence((current) =>
            reduceCompanionPresence(current, { type: "generation", state: message.state })
          );
          return;
        case "companion-ready":
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
      speechBuffer.clear();
      bus.close();
    };
  }, []);

  useEffect(() => {
    // Own the interrupted timer in this effect so React StrictMode remounts
    // get a live scheduler instead of a permanently disposed ref instance.
    const resetScheduler = createInterruptedResetScheduler(() => {
      setPresence((current) => (current === "interrupted" ? "idle" : current));
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
    if (presence === "interrupted") {
      interruptedResetRef.current?.schedule();
    } else {
      interruptedResetRef.current?.invalidate();
    }
  }, [presence]);

  useEffect(() => {
    // Schedulers MUST be created inside this effect. StrictMode mount → cleanup
    // → remount disposes the first pair; remount must allocate brand-new
    // instances and must never keep sampling a disposed ref.
    let blinkScheduler = createCompanionBlinkScheduler(Math.random, performance.now());
    let gazeScheduler = createGazeScheduler(Math.random, performance.now());
    blinkSchedulerRef.current = blinkScheduler;
    gazeSchedulerRef.current = gazeScheduler;

    let frame = 0;
    let alive = true;
    let previousNow = performance.now();
    // Generation token: any in-flight rAF from a previous StrictMode mount
    // must no-op even if cancelAnimationFrame races.
    const effectGeneration = Symbol("presence-raf");
    let activeGeneration: symbol | null = effectGeneration;

    const animate = (now: number) => {
      if (!alive || activeGeneration !== effectGeneration) {
        frame = 0;
        return;
      }
      // Re-check visibility every frame. Do not permanently kill the loop on a
      // single "hidden" event — Tauri multi-window can miss the matching show.
      const hidden =
        typeof document !== "undefined" && document.visibilityState === "hidden";
      if (hidden) {
        previousNow = now;
        frame = requestAnimationFrame(animate);
        return;
      }

      const frameDelta = Math.max(0, now - previousNow);
      previousNow = now;
      const currentPresence = presenceRef.current;
      const interrupted = currentPresence === "interrupted";

      // Self-heal: if a disposed scheduler was ever left in place, replace it.
      if (gazeScheduler.isDisposed()) {
        gazeScheduler = createGazeScheduler(Math.random, now);
        gazeSchedulerRef.current = gazeScheduler;
      }

      // Speaking continues to blink; only interrupted freezes eyes open.
      const blink = interrupted ? 0 : blinkScheduler.sample(now, currentPresence);
      const animation = getCompanionAnimation(currentPresence, now, blink);
      // Explicit (now, dt, interrupted) so hold clocks advance from frameDelta
      // even if wall-clock origins differ between rAF and performance.now().
      const gaze = gazeScheduler.sample(now, frameDelta, interrupted);

      // DEV force path only overrides the final output — the scheduler keeps
      // ticking underneath so natural motion resumes when force is cleared.
      const forceGaze =
        import.meta.env.DEV &&
        typeof window !== "undefined" &&
        (window as typeof window & { __yuviForceGaze?: boolean }).__yuviForceGaze === true;
      const presenceAnimation = forceGaze
        ? {
            blink: animation.blink,
            breath: animation.breath,
            eyeBallX: 1,
            eyeBallY: 0.5,
            headAngleX: 20,
            headAngleY: 10,
            headAngleZ: 8,
            bodyAngleX: 6,
            bodyAngleY: 3,
            bodyAngleZ: 4
          }
        : {
            blink: animation.blink,
            breath: animation.breath,
            eyeBallX: gaze.currentX,
            eyeBallY: gaze.currentY,
            headAngleX: gaze.headCurrentX,
            headAngleY: gaze.headCurrentY,
            headAngleZ: gaze.headCurrentZ,
            bodyAngleX: gaze.bodyCurrentX,
            bodyAngleY: gaze.bodyCurrentY,
            bodyAngleZ: gaze.bodyCurrentZ
          };
      lumiRef.current?.setPresenceAnimation(presenceAnimation);

      if (import.meta.env.DEV && typeof window !== "undefined") {
        const debugWindow = window as typeof window & {
          __yuviPresenceDiagnostics?: Record<string, unknown>;
        };
        const controller = lumiRef.current?.getDebugInfo();
        debugWindow.__yuviPresenceDiagnostics = {
          running: true,
          presence: currentPresence,
          interrupted,
          forceGaze: forceGaze === true,
          schedulerDisposed: gazeScheduler.isDisposed(),
          schedulerPaused: false,
          hiddenDocument: hidden,
          frameNow: now,
          frameDelta,
          nextBlinkAt: blinkScheduler.getNextBlinkAt(),
          blinkPhase: blinkScheduler.getPhase(now),
          eyeOpen: 1 - animation.blink,
          eyeLeft: 1 - animation.blink,
          eyeRight: 1 - animation.blink,
          blinkValue: animation.blink,
          breathValue: animation.breath,
          pendingEyeLeft: controller?.pendingEyeLeft ?? null,
          pendingEyeRight: controller?.pendingEyeRight ?? null,
          pendingBreath: controller?.pendingBreath ?? null,
          pendingEyeBallX: controller?.pendingEyeBallX ?? null,
          pendingEyeBallY: controller?.pendingEyeBallY ?? null,
          pendingAngleX: controller?.pendingHeadAngleX ?? null,
          pendingAngleY: controller?.pendingHeadAngleY ?? null,
          pendingAngleZ: controller?.pendingHeadAngleZ ?? null,
          preUpdateEyeBallX: controller?.preUpdateEyeBallX ?? null,
          preUpdateEyeBallY: controller?.preUpdateEyeBallY ?? null,
          preUpdateAngleX: controller?.preUpdateAngleX ?? null,
          preUpdateAngleY: controller?.preUpdateAngleY ?? null,
          preUpdateAngleZ: controller?.preUpdateAngleZ ?? null,
          preUpdateEyeBallPhysicsX: controller?.preUpdateEyeBallPhysicsX ?? null,
          preUpdateEyeBallPhysicsY: controller?.preUpdateEyeBallPhysicsY ?? null,
          ownedParameterIds: controller?.ownedParameterIds ?? null,
          controllerInstanceId: controller?.instanceId ?? null,
          controllerGeneration: controller?.generation ?? null,
          gazeSchedulerRunning: gaze.running,
          gazeElapsedMs: gaze.elapsedMs,
          gazeTargetX: gaze.targetX,
          gazeTargetY: gaze.targetY,
          gazeCurrentX: gaze.currentX,
          gazeCurrentY: gaze.currentY,
          gazeTargetRegion: gaze.targetRegion,
          holdUntil: gaze.holdUntil,
          nextTargetAt: gaze.nextTargetAt,
          headCurrentX: gaze.headCurrentX,
          headCurrentY: gaze.headCurrentY,
          headCurrentZ: gaze.headCurrentZ,
          headTargetX: gaze.headTargetX,
          headTargetY: gaze.headTargetY,
          headTargetZ: gaze.headTargetZ,
          bodyCurrentX: gaze.bodyCurrentX,
          bodyCurrentY: gaze.bodyCurrentY,
          bodyCurrentZ: gaze.bodyCurrentZ,
          bodyTargetX: gaze.bodyTargetX,
          bodyTargetY: gaze.bodyTargetY,
          bodyTargetZ: gaze.bodyTargetZ,
          pendingBodyAngleX: controller?.pendingBodyAngleX ?? null,
          pendingBodyAngleY: controller?.pendingBodyAngleY ?? null,
          pendingBodyAngleZ: controller?.pendingBodyAngleZ ?? null,
          appliedEyeBallX: presenceAnimation.eyeBallX,
          appliedEyeBallY: presenceAnimation.eyeBallY,
          appliedHeadAngleX: presenceAnimation.headAngleX,
          appliedHeadAngleY: presenceAnimation.headAngleY,
          appliedHeadAngleZ: presenceAnimation.headAngleZ,
          appliedBodyAngleX: presenceAnimation.bodyAngleX,
          appliedBodyAngleY: presenceAnimation.bodyAngleY,
          appliedBodyAngleZ: presenceAnimation.bodyAngleZ,
          activeRafCount: 1,
          now
        };
      }
      frame = requestAnimationFrame(animate);
    };

    frame = requestAnimationFrame(animate);
    return () => {
      alive = false;
      activeGeneration = null;
      cancelAnimationFrame(frame);
      frame = 0;
      blinkScheduler.dispose();
      gazeScheduler.dispose();
      if (blinkSchedulerRef.current === blinkScheduler) {
        blinkSchedulerRef.current = null;
      }
      if (gazeSchedulerRef.current === gazeScheduler) {
        gazeSchedulerRef.current = null;
      }
      lumiRef.current?.setPresenceAnimation({
        blink: 0,
        breath: 0,
        eyeBallX: 0,
        eyeBallY: 0,
        headAngleX: 0,
        headAngleY: 0,
        headAngleZ: 0,
        bodyAngleX: 0,
        bodyAngleY: 0,
        bodyAngleZ: 0
      });
      if (import.meta.env.DEV && typeof window !== "undefined") {
        const debugWindow = window as typeof window & {
          __yuviPresenceDiagnostics?: Record<string, unknown>;
        };
        if (debugWindow.__yuviPresenceDiagnostics) {
          debugWindow.__yuviPresenceDiagnostics = {
            ...debugWindow.__yuviPresenceDiagnostics,
            running: false,
            gazeSchedulerRunning: false,
            schedulerDisposed: true,
            activeRafCount: 0,
            presence: "idle",
            blinkPhase: "waiting",
            eyeOpen: 1,
            blinkValue: 0
          };
        }
      }
    };
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-transparent text-white">
      {isTauriRuntime() && (
        <div
          data-tauri-drag-region
          className="absolute inset-x-0 top-0 z-0 h-6 cursor-grab touch-none select-none border-b border-white/5 bg-white/5"
          aria-label="Drag window"
          title="Drag window"
        >
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/25" />
        </div>
      )}
      <LumiCanvas
        ref={lumiRef}
        requestedPresence={toLumiPresence(presence)}
        className="h-full w-full rounded-none"
        showFramingToggle={false}
      />
      <div
        className="pointer-events-none absolute left-2 top-2 rounded bg-black/40 px-2 py-1 text-xs"
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

function presenceLabel(state: CompanionPresenceState): string {
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

function toLumiPresence(state: CompanionPresenceState): PresenceState {
  return state === "listening" ? "idle" : state;
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
