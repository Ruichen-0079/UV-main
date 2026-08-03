import { useEffect, useRef, useState } from "react";
import { apiClient } from "./api/client.js";
import { CompanionBus, type CompanionBusMessage } from "./companion-bus.js";
import { reduceCompanionPresence } from "./companion-presence.js";
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
  const announcerRef = useRef<ReturnType<typeof createCompanionReadyAnnouncer> | null>(null);
  const [presence, setPresence] = useState<PresenceState>("idle");
  const [voiceStatus, setVoiceStatus] = useState<SpeechQueueState>("idle");
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const voiceEnabledRef = useRef(true);
  const [framing, setFraming] = useState<LumiFraming>("half");

  useEffect(() => {
    const bus = new CompanionBus("companion");
    const announcer = createCompanionReadyAnnouncer(bus);
    announcerRef.current = announcer;
    announcer.start();
    void preloadTauriWindowApi();

    function startGeneration(requestId: string, sessionId: string): void {
      // A new turn replaces the previous speech session: old audio stops,
      // stale presence is reset and synthesis restarts from a fresh queue.
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
            if (import.meta.env.DEV && id !== undefined) {
              const requestId = sessionRef.current?.requestId ?? "unknown";
              const states = ((window as unknown as {
                __yuviSpeechStates?: Record<string, string>;
              }).__yuviSpeechStates ??= {});
              states[`${requestId}:${id}`] = state;
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
            lumiRef.current?.handlePlaybackEvent(event);
          }
        }
      );
      const previous = sessionRef.current;
      sessionRef.current = { requestId, queue, deduper: createSpeechSegmentDeduper() };
      previous?.queue.cancel();
      setPresence((current) =>
        reduceCompanionPresence(current, { type: "generation", state: "thinking" })
      );
      setVoiceStatus("synthesizing");
    }

    function handleMessage(message: CompanionBusMessage): void {
      switch (message.kind) {
        case "user-gesture":
          lumiRef.current?.resumeAudio();
          return;
        case "start-generation":
          if (voiceEnabledRef.current) {
            startGeneration(message.requestId, message.sessionId);
          }
          return;
        case "voice-enabled":
          announcerRef.current?.markSynced();
          voiceEnabledRef.current = message.enabled;
          setVoiceEnabled(message.enabled);
          if (!message.enabled) {
            // The main window stops forwarding segments; cancel any speech
            // that is already queued or playing so mouth/audio settle now.
            const session = sessionRef.current;
            if (session) session.queue.cancel();
          }
          return;
        case "speak": {
          if (!voiceEnabledRef.current) return;
          const session = sessionRef.current;
          if (session && session.requestId === message.requestId) {
            if (!session.deduper.isNew(message.requestId, message.sequence)) return;
            session.queue.enqueue(
              { text: message.text, language: message.language },
              String(message.sequence)
            );
          }
          return;
        }
        case "speech-end": {
          const session = sessionRef.current;
          if (session && session.requestId === message.requestId) {
            session.queue.finish();
          }
          return;
        }
        case "stop-speech": {
          const session = sessionRef.current;
          if (session && session.requestId === message.requestId) {
            session.queue.cancel();
          }
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
      bus.close();
    };
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-ink-900 text-white">
      {isTauriRuntime() && (
        <div
          data-tauri-drag-region
          className="absolute inset-x-0 top-0 z-0 h-6 cursor-grab touch-none select-none border-b border-white/5 bg-white/5"
          aria-label="拖动窗口"
          title="拖动窗口"
        >
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/25" />
        </div>
      )}
      <LumiCanvas
        ref={lumiRef}
        requestedPresence={presence}
        className="h-full w-full rounded-none"
        showFramingToggle={false}
      />
      <div
        className="pointer-events-none absolute left-2 top-2 rounded bg-black/40 px-2 py-1 text-xs"
        aria-live="polite"
      >
        {presenceLabel(presence)} · {voiceStatusLabel(voiceStatus)} · 语音{voiceEnabled ? "开" : "关"}
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
        {framing === "half" ? "显示全身" : "显示半身"}
      </button>
      {isTauriRuntime() && (
        <button
          type="button"
          aria-label="调整窗口大小"
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

function presenceLabel(state: PresenceState): string {
  switch (state) {
    case "thinking":
      return "正在思考";
    case "speaking":
      return "正在说话";
    case "interrupted":
      return "已中断";
    case "unavailable":
      return "形象暂不可用";
    case "idle":
      return "待机";
  }
}

function voiceStatusLabel(state: SpeechQueueState): string {
  switch (state) {
    case "synthesizing":
      return "合成中";
    case "playing":
      return "播放中";
    case "stopped":
      return "已停止";
    case "error":
      return "出错";
    case "idle":
      return "空闲";
  }
}
