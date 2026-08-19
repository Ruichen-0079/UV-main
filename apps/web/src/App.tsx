import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from "react";
import {
  ApiError,
  apiClient,
  type AcceptMemoryCandidateRequest,
  type CreateMemoryRequest,
  type DashboardWebSocketMessage,
  type HealthResponse,
  type LayeredSetting,
  type MemoryCandidateReview,
  type MemoryHealthSummary,
  type MemoryMaintenanceSchedulerStatus,
  type MemoryMaintenanceSummary,
  type MemoryRecord,
  type MemoryVectorIndexStatus,
  type ProviderCallMetadata,
  type ProviderCapability,
  type ProviderChainInspectionResponse,
  type ProviderHealth,
  type ProviderRouteHealth,
  type ProviderVerificationResponse,
  type PromptPreviewResponse,
  type ProvidersStatusResponse,
  type RetrievedMemoryDebug,
  type RuntimeEvent,
  type RuntimeSettingsReloadResponse,
  type RuntimeSettingsResponse,
  type UpdateMemoryRequest,
  type MessageStreamEvent
} from "./api/client.js";
import {
  cachedObservationDetail,
  providerAttemptLabel,
  providerObservationLabel,
  providerReadinessLabel,
  verificationModeExplanation,
  verificationModeLabel,
  verificationOutcomeLabel
} from "./provider-diagnostics.js";
import { promptPreviewPlaceholder } from "./data/mock.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { reduceChatMessages, shouldSubmitChatKey, type ChatMessage } from "./chat-state.js";
import { ChatMessageContent } from "./markdown-message.js";
import { SpeechSegmenter } from "./speech-segmenter.js";
import {
  applyCapabilityProjection,
  deriveCapabilityProjection,
  deriveEffectiveVoiceOutput,
  detectBrowserAudioCapability
} from "./capability-projection.js";
import {
  createBrowserSpeechPlayer,
  detectSpeechLanguage,
  SpeechPlaybackQueue,
  type SpeechQueueState,
  type SpeechPlaybackEvent
} from "./speech-queue.js";
import {
  correlateSpeechPlayback,
  createSpeechPlaybackCorrelation,
  type SpeechPlaybackCorrelationState
} from "./speech-playback-correlation.js";
import { LumiCanvas } from "./lumi-canvas.js";
import type { LumiControllerHandle, LumiModelLifecycle } from "./lumi-live2d.js";
import {
  canInterruptGeneration,
  createCompanionPresenceEpochGuard,
  createInitialCompanionPresence,
  createInterruptedResetScheduler,
  reduceCompanionPresence,
  type CompanionPresenceEvent,
  type CompanionPresenceProjection
} from "./companion-presence.js";
import type { CompanionTtsConfiguration } from "./companion-bus.js";
import {
  isServiceSupervisorAvailable,
  subscribeServiceStatusState
} from "./service-supervisor-client.js";
import { initialServiceStatusState, type ServiceStatusState } from "./service-status-state.js";
import { fetchUserSettings } from "./user-settings-client.js";
import { isTauriRuntime } from "./tauri-window.js";
import {
  compareSettingsForms,
  isCurrentSettingsOperation,
  normalizeRuntimeSettingForComparison,
  resolveSettingsOperationState,
  settingsDraftDiffers,
  settingsFingerprint,
  settingsStateLabels,
  shouldReplaceSettingsDraft,
  synchronizeSettingsDraftState,
  type SettingsApplyState,
  type SettingsOperationMode
} from "./settings-state.js";
import {
  normalizeVisionImageMimeType,
  toVisionFileInput,
  type VisionImageMimeType
} from "./vision-input.js";

type PageId =
  | "overview"
  | "chat"
  | "memory"
  | "providers"
  | "events"
  | "prompt"
  | "voice"
  | "vision"
  | "settings";

type WebSocketStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "paused"
  | "error";
type RequestStatus = "idle" | "sending" | "success" | "error";
type VoicePlaybackStatus = SpeechQueueState;
type ChatTimingMetrics = {
  userSendAt: number;
  firstTextDeltaAt?: number;
  firstSegmentSubmittedAt?: number;
  firstTtsCompletedAt?: number;
  firstAudioStartedAt?: number;
  presenceSpeakingAt?: number;
  stopRequestedAt?: number;
  audioPausedAt?: number;
  mouthZeroAt?: number;
  finalAudioEndedAt?: number;
  assistantCompletedAt?: number;
};
type MemoryResultSource = "/memory/recent" | "/memory/search" | "local fallback";

/** Dashboard chat uses the frozen P5-D selector without adding another policy. */
export function deriveDashboardTtsPolicy(
  input: Parameters<typeof deriveEffectiveVoiceOutput>[0]
): ReturnType<typeof deriveEffectiveVoiceOutput> {
  return deriveEffectiveVoiceOutput(input);
}

export function flushDashboardSpeechTail(
  tail: readonly string[],
  requestTts: boolean,
  enqueue: (text: string) => void,
  finish: () => void
): void {
  if (requestTts) {
    for (const text of tail) enqueue(text);
  }
  finish();
}

function recordChatTiming(
  timingRef: MutableRefObject<ChatTimingMetrics | null>,
  patch: Partial<ChatTimingMetrics>
): void {
  if (!timingRef.current) return;
  Object.assign(timingRef.current, patch);
  if (import.meta.env.DEV && typeof window !== "undefined") {
    document.documentElement.dataset["yuviLumiTiming"] = JSON.stringify(timingRef.current);
  }
}

const memoryTypes = ["working", "episodic", "semantic", "emotional", "procedural", "relationship"];

const memorySubtypes = [
  "preference",
  "fact",
  "project",
  "provider-choice",
  "path",
  "repo",
  "command",
  "troubleshooting",
  "config",
  "identity",
  "project-fact",
  "config-decision",
  "emotional-state",
  "emotional-pattern",
  "health-note",
  "schedule",
  "test",
  "workflow",
  "event",
  "milestone",
  "emotion",
  "relationship"
];

const memoryScopes = ["user", "project", "agent", "plugin", "session"];
const memoryLayers = ["core", "recall", "archival", "working"];
const memoryStatuses = ["active", "superseded", "archived", "forgotten", "expired"];
let chatMessageSequence = 0;

const pages: Array<{ id: PageId; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "chat", label: "对话" },
  { id: "memory", label: "记忆" },
  { id: "providers", label: "提供方" },
  { id: "events", label: "事件" },
  { id: "prompt", label: "提示词预览" },
  { id: "voice", label: "语音" },
  { id: "vision", label: "视觉" },
  { id: "settings", label: "设置" }
];

export function App(): JSX.Element {
  const [activePage, setActivePage] = useState<PageId>("overview");
  const health = useAsyncData((signal) => apiClient.getHealth(signal), []);
  const providerStatus = useAsyncData((signal) => apiClient.getProviderStatus(signal), []);
  const memories = useAsyncData((signal) => apiClient.listRecentMemories(20, signal), []);
  const eventState = useAsyncData((signal) => apiClient.listRecentEvents(50, signal), []);
  const [localEvents, setLocalEvents] = useState<RuntimeEvent[]>([]);
  const [liveEvents, setLiveEvents] = useState<RuntimeEvent[]>([]);
  const [eventsPaused, setEventsPaused] = useState(false);
  const wsStatus = useDashboardEventStream({
    paused: eventsPaused,
    onEvent: (event) => setLiveEvents((current) => [event, ...current].slice(0, 100))
  });

  const events = useMemo(
    () => mergeEvents(liveEvents, localEvents, eventState.data?.events ?? []),
    [eventState.data?.events, liveEvents, localEvents]
  );
  const recentEvents = useMemo(() => events.slice(0, 8), [events]);

  return (
    <div className="flex h-screen min-h-[720px] bg-ink-100">
      <aside className="flex w-60 shrink-0 flex-col border-r border-ink-200 bg-white">
        <div className="border-b border-ink-200 px-4 py-4">
          <div className="text-sm font-semibold text-ink-500">YUVI Runtime</div>
          <h1 className="mt-1 text-lg font-semibold text-ink-900">YUVI 开发控制台</h1>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {pages.map((page) => (
            <button
              key={page.id}
              className={`w-full rounded-md px-3 py-2 text-left text-sm font-medium transition ${
                activePage === page.id
                  ? "bg-cyan-50 text-cyan-800"
                  : "text-ink-700 hover:bg-ink-100 hover:text-ink-900"
              }`}
              onClick={() => setActivePage(page.id)}
            >
              {page.label}
            </button>
          ))}
        </nav>
        <div className="border-t border-ink-200 p-3 text-xs text-ink-500">
          Debug UI only. Live2D is intentionally not implemented here.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopStatusBar
          health={health.data}
          loading={health.loading}
          error={health.error}
          onRefresh={health.refresh}
        />
        <main className="min-h-0 flex-1 overflow-auto p-5">
          {activePage === "overview" && (
            <OverviewPage
              health={health}
              wsStatus={wsStatus}
              recentEvents={recentEvents}
              memories={memories.data?.memories ?? []}
            />
          )}
          {activePage === "chat" && <ChatPage />}
          {activePage === "memory" && <MemoryPage state={memories} health={health.data} />}
          {activePage === "providers" && <ProvidersPage state={providerStatus} />}
          {activePage === "events" && (
            <EventsPage
              events={events}
              paused={eventsPaused}
              onTogglePaused={() => setEventsPaused((value) => !value)}
              wsStatus={wsStatus}
            />
          )}
          {activePage === "prompt" && <PromptPreviewPage />}
          {activePage === "voice" && <VoicePage providerStatus={providerStatus.data} />}
          {activePage === "vision" && <VisionPage providerStatus={providerStatus.data} />}
          {activePage === "settings" && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}

function TopStatusBar(props: {
  health: HealthResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh(): Promise<unknown>;
}): JSX.Element {
  const status = props.loading
    ? "loading"
    : props.error
      ? "error"
      : props.health?.ok
        ? "healthy"
        : "degraded";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-ink-200 bg-white px-5">
      <div className="flex items-center gap-3">
        <StatusDot status={status} />
        <div>
          <div className="text-sm font-semibold">Runtime status: {status}</div>
          <div className="text-xs text-ink-500">Server target http://localhost:6121</div>
        </div>
      </div>
      <button className="button-secondary" onClick={() => void props.onRefresh()}>
        Refresh
      </button>
    </header>
  );
}

function OverviewPage(props: {
  health: ReturnType<typeof useAsyncData<HealthResponse>>;
  wsStatus: string;
  recentEvents: RuntimeEvent[];
  memories: MemoryRecord[];
}): JSX.Element {
  return (
    <PageShell title="Overview" subtitle="Operational snapshot for local runtime debugging.">
      {props.health.loading && (
        <Notice tone="info" title="Loading" message="Fetching runtime health from the backend." />
      )}
      {props.health.error && (
        <Notice tone="error" title="Backend error" message={props.health.error} />
      )}
      <div className="grid grid-cols-4 gap-4">
        <StatusCard
          title="Server"
          status={props.health.data?.server.status ?? "unknown"}
          detail={`Runtime mode: ${props.health.data?.runtimeMode ?? "unknown"}`}
        />
        <StatusCard title="WebSocket" status={props.wsStatus} detail="控制台运行时事件流" />
        <StatusCard
          title="Memory"
          status={memoryModeFromHealth(props.health.data)}
          detail={props.health.data?.database.message ?? "No memory health yet"}
        />
        <StatusCard
          title="Providers"
          status={`chat ${props.health.data?.providers.chat.readiness ?? "unknown"}`}
          detail={`Cached chat observation: ${providerObservationLabel(
            props.health.data?.providers.chat.observed
          )}`}
        />
      </div>
      <div className="grid grid-cols-[1.1fr_0.9fr] gap-4">
        <Panel title="Recent Events">
          <EventTable events={props.recentEvents} />
        </Panel>
        <Panel title="Recent Memories">
          {props.memories.length === 0 ? (
            <EmptyState
              title="No memories loaded"
              message="Create a memory or wait for runtime interactions."
            />
          ) : (
            <MemoryTable memories={props.memories.slice(0, 5)} compact />
          )}
        </Panel>
      </div>
    </PageShell>
  );
}

function ChatPage(): JSX.Element {
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState("dashboard");
  const [readMemory, setReadMemory] = useState(true);
  const [writeMemory, setWriteMemory] = useState(true);
  const [promptPreview, setPromptPreview] = useState(true);
  const [voiceOutput, setVoiceOutput] = useState(false);
  const [presence, setPresenceProjection] = useState<CompanionPresenceProjection>(() =>
    createInitialCompanionPresence()
  );
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusState>(initialServiceStatusState);
  const [ttsConfig, setTtsConfig] = useState<CompanionTtsConfiguration | null>(() =>
    isTauriRuntime() ? null : { enabled: true, mode: "external" }
  );
  const [modelLifecycle, setModelLifecycle] = useState<LumiModelLifecycle>("loading");
  const [messages, dispatchMessages] = useReducer(reduceChatMessages, [] as ChatMessage[]);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastTraceId, setLastTraceId] = useState<string | null>(null);
  const [voicePlaybackStatus, setVoicePlaybackStatus] = useState<VoicePlaybackStatus>("idle");
  const [actualPlaybackActive, setActualPlaybackActive] = useState(false);
  const mountedRef = useRef(true);
  const lumiRef = useRef<LumiControllerHandle>(null);
  const presenceProjectionRef = useRef(presence);
  const epochGuardRef = useRef(createCompanionPresenceEpochGuard());
  const interruptedResetRef = useRef<ReturnType<typeof createInterruptedResetScheduler> | null>(
    null
  );
  const effectiveVoiceOutputRef = useRef<ReturnType<typeof deriveEffectiveVoiceOutput>>({
    requestTts: false,
    reason: "settings-pending"
  });
  const timingRef = useRef<ChatTimingMetrics | null>(null);
  const speechSessionRef = useRef<{
    generation: string;
    segmenter: SpeechSegmenter;
    queue: SpeechPlaybackQueue;
    nextSegmentSequence: number;
  } | null>(null);
  const playbackCorrelationRef = useRef<SpeechPlaybackCorrelationState>(
    createSpeechPlaybackCorrelation()
  );
  const activeRequestRef = useRef<{
    id: string;
    assistantId: string;
    controller: AbortController;
    completedObserved: boolean;
  } | null>(null);

  presenceProjectionRef.current = presence;

  const capabilityProjection = useMemo(
    () =>
      deriveCapabilityProjection({
        serviceStatus,
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        ttsConfiguration: ttsConfig,
        audio: detectBrowserAudioCapability(),
        live2dLifecycle: modelLifecycle
      }),
    [modelLifecycle, serviceStatus, ttsConfig]
  );
  const effectiveVoiceOutput = useMemo(
    () =>
      deriveDashboardTtsPolicy({
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        perTurnVoiceOutput: voiceOutput,
        ttsCapability: capabilityProjection.capabilities.tts,
        ttsConfiguration: ttsConfig
      }),
    [capabilityProjection.capabilities.tts, ttsConfig?.enabled, ttsConfig?.mode, voiceOutput]
  );
  effectiveVoiceOutputRef.current = effectiveVoiceOutput;

  function updatePresence(
    update: (current: CompanionPresenceProjection) => CompanionPresenceProjection
  ): void {
    const current = presenceProjectionRef.current;
    const next = update(current);
    if (next === current) return;
    presenceProjectionRef.current = next;
    // Forward synchronously; React state is only the dashboard render surface.
    lumiRef.current?.setPresentationProjection(next);
    setPresenceProjection(next);
  }

  function applyPresenceEvent(event: CompanionPresenceEvent): void {
    updatePresence((current) => reduceCompanionPresence(current, event));
  }

  useEffect(() => {
    if (!isTauriRuntime() && !isServiceSupervisorAvailable()) return;
    return subscribeServiceStatusState(setServiceStatus);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void fetchUserSettings()
      .then((view) => {
        if (!cancelled) {
          setTtsConfig({ enabled: view.settings.tts.enabled, mode: view.settings.tts.mode });
        }
      })
      .catch(() => {
        // Keep persisted TTS configuration unknown when the authority cannot be read.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    updatePresence((current) =>
      applyCapabilityProjection(current, capabilityProjection, (value, event) =>
        reduceCompanionPresence(value, event)
      )
    );
  }, [capabilityProjection]);

  useEffect(() => {
    const resetScheduler = createInterruptedResetScheduler(() => {
      const epoch = presenceProjectionRef.current.epoch;
      if (epoch) applyPresenceEvent({ type: "transition-expired", epoch });
    });
    interruptedResetRef.current = resetScheduler;
    return () => {
      resetScheduler.dispose();
      if (interruptedResetRef.current === resetScheduler) interruptedResetRef.current = null;
      epochGuardRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    if (presence.transition === "interrupted" && presence.epoch) {
      interruptedResetRef.current?.schedule();
    } else {
      interruptedResetRef.current?.invalidate();
    }
  }, [presence.transition, presence.epoch]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      speechSessionRef.current?.queue.cancel();
      speechSessionRef.current = null;
      playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
    };
  }, []);

  const outgoingPayload = useMemo(
    () => ({
      text: input || "<message text>",
      options: {
        readMemory,
        writeMemory,
        promptPreview,
        voiceOutput: false,
        browserVoiceOutput: voiceOutput,
        effectiveTtsRequest: effectiveVoiceOutput.requestTts,
        effectiveTtsReason: effectiveVoiceOutput.reason
      }
    }),
    [effectiveVoiceOutput, input, promptPreview, readMemory, voiceOutput, writeMemory]
  );

  function enqueueDashboardSpeech(
    speech: NonNullable<typeof speechSessionRef.current>,
    text: string
  ): void {
    const segment = {
      requestId: speech.generation,
      sequence: speech.nextSegmentSequence++
    };
    speech.queue.enqueue({ text, language: detectSpeechLanguage(text) }, segment);
  }

  async function send(): Promise<void> {
    // Capture the draft once, clear the controlled textarea immediately, then
    // use only the captured payload for the rest of the turn.
    const submittedText = input.trim() ? input : null;
    if (submittedText === null || activeRequestRef.current) {
      return;
    }

    speechSessionRef.current?.queue.cancel();
    speechSessionRef.current = null;
    playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
    setActualPlaybackActive(false);
    const content = submittedText;
    setInput("");
    setError(null);
    const requestId = createChatMessageId("turn");
    const assistantId = createChatMessageId("assistant");
    const controller = new AbortController();
    if (!epochGuardRef.current.accept(requestId)) return;
    activeRequestRef.current = {
      id: requestId,
      assistantId,
      controller,
      completedObserved: false
    };
    timingRef.current = { userSendAt: performance.now() };
    recordChatTiming(timingRef, {});
    const shouldRequestTts = effectiveVoiceOutputRef.current.requestTts;
    applyPresenceEvent({ type: "turn-start", epoch: requestId });
    if (shouldRequestTts) {
      // Resume the shared Web Audio context while this send is still a user gesture.
      lumiRef.current?.resumeAudio();
      const generation = requestId;
      const segmenter = new SpeechSegmenter();
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
            if (mountedRef.current && speechSessionRef.current?.generation === generation) {
              setVoicePlaybackStatus(state);
              applyPresenceEvent({ type: "queue", epoch: generation, state });
              if (state === "idle" || state === "stopped" || state === "error") {
                speechSessionRef.current = null;
              }
            }
          },
          onError: () => {
            if (mountedRef.current && speechSessionRef.current?.generation === generation) {
              setVoicePlaybackStatus("error");
              applyPresenceEvent({ type: "queue", epoch: generation, state: "error" });
            }
          },
          onSynthesisCompleted: () => {
            const timing = timingRef.current;
            if (timing)
              recordChatTiming(timingRef, {
                firstTtsCompletedAt: timing.firstTtsCompletedAt ?? performance.now()
              });
          },
          onPlaybackEvent: (event: SpeechPlaybackEvent) => {
            if (mountedRef.current && speechSessionRef.current?.generation === generation) {
              const phase =
                event.type === "audioElementAttached"
                  ? "attached"
                  : event.type === "playbackStarted"
                    ? "started"
                    : event.type === "audioElementDetached"
                      ? "detached"
                      : "terminal";
              const result = correlateSpeechPlayback(
                playbackCorrelationRef.current,
                phase,
                event.segment
              );
              playbackCorrelationRef.current = result.state;
              if (!result.accepted) return;
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
                applyPresenceEvent({
                  type: "playback",
                  epoch: generation,
                  state: playbackState
                });
              }
              lumiRef.current?.handlePlaybackEvent(event);
              if (event.type === "playbackStarted") {
                setActualPlaybackActive(true);
                timingRef.current ??= { userSendAt: performance.now() };
                const now = performance.now();
                recordChatTiming(timingRef, {
                  firstAudioStartedAt: timingRef.current.firstAudioStartedAt ?? now,
                  presenceSpeakingAt: timingRef.current.presenceSpeakingAt ?? now
                });
              } else if (event.type === "playbackStopped") {
                setActualPlaybackActive(false);
                recordChatTiming(timingRef, {
                  audioPausedAt: performance.now(),
                  mouthZeroAt: performance.now()
                });
              } else if (event.type === "playbackEnded") {
                setActualPlaybackActive(false);
                recordChatTiming(timingRef, {
                  finalAudioEndedAt: performance.now(),
                  mouthZeroAt: performance.now()
                });
              } else if (event.type === "playbackError") {
                setActualPlaybackActive(false);
              }
            }
          }
        }
      );
      speechSessionRef.current = {
        generation,
        segmenter,
        queue,
        nextSegmentSequence: 0
      };
    }
    setRequestStatus("sending");
    dispatchMessages({
      type: "append-turn",
      user: {
        id: createChatMessageId("user"),
        requestId,
        role: "user",
        content,
        useMemory: readMemory && writeMemory,
        readMemory,
        writeMemory,
        voiceOutput,
        status: "completed"
      },
      assistant: {
        id: assistantId,
        requestId,
        role: "assistant",
        content: "",
        status: "streaming"
      }
    });

    try {
      const response = await apiClient.streamMessage(
        {
          sessionId,
          text: content,
          options: {
            readMemory,
            writeMemory,
            // Browser playback owns sentence-level TTS for this path. Avoid
            // asking Runtime to synthesize the complete reply a second time.
            voiceOutput: false,
            promptPreview
          }
        },
        {
          signal: controller.signal,
          onEvent: (event: MessageStreamEvent) => {
            if (!mountedRef.current || activeRequestRef.current?.id !== requestId) {
              return;
            }
            if (event.type === "text-delta") {
              if (timingRef.current && timingRef.current.firstTextDeltaAt === undefined) {
                recordChatTiming(timingRef, { firstTextDeltaAt: performance.now() });
              }
              setLastTraceId(event.traceId);
              dispatchMessages({
                type: "append-delta",
                assistantId,
                text: event.text,
                traceId: event.traceId
              });
              const speech = speechSessionRef.current;
              if (speech?.generation === requestId && effectiveVoiceOutputRef.current.requestTts) {
                for (const text of speech.segmenter.push(event.text)) {
                  if (
                    timingRef.current &&
                    timingRef.current.firstSegmentSubmittedAt === undefined
                  ) {
                    recordChatTiming(timingRef, { firstSegmentSubmittedAt: performance.now() });
                  }
                  enqueueDashboardSpeech(speech, text);
                }
              }
              return;
            }
            if (event.type === "error") {
              dispatchMessages({ type: "fail", assistantId, error: event.message });
              setError(event.message);
              applyPresenceEvent({ type: "generation", epoch: requestId, state: "idle" });
              const speech = speechSessionRef.current;
              if (speech?.generation === requestId) {
                for (const text of speech.segmenter.flush("failed")) {
                  if (effectiveVoiceOutputRef.current.requestTts)
                    enqueueDashboardSpeech(speech, text);
                }
                speech.queue.finish();
              }
              return;
            }
            activeRequestRef.current.completedObserved = true;
            setLastTraceId(event.traceId);
            dispatchMessages({
              type: "complete",
              assistantId,
              content: event.content,
              traceId: event.traceId,
              provider: event.provider
            });
            setRequestStatus("success");
            applyPresenceEvent({ type: "generation", epoch: requestId, state: "idle" });
            recordChatTiming(timingRef, { assistantCompletedAt: performance.now() });
            const speech = speechSessionRef.current;
            if (speech?.generation === requestId) {
              for (const text of speech.segmenter.flush("completed")) {
                if (effectiveVoiceOutputRef.current.requestTts)
                  enqueueDashboardSpeech(speech, text);
              }
              speech.queue.finish();
            }
          }
        }
      );

      if (!mountedRef.current || activeRequestRef.current?.id !== requestId) {
        return;
      }
      dispatchMessages({
        type: "complete",
        assistantId,
        content: response.content,
        traceId: response.traceId,
        provider: response.provider
      });
      setLastTraceId(response.traceId);
      setRequestStatus("success");
      applyPresenceEvent({ type: "generation", epoch: requestId, state: "idle" });
      recordChatTiming(timingRef, { assistantCompletedAt: performance.now() });
      const speech = speechSessionRef.current;
      if (speech?.generation === requestId) {
        for (const text of speech.segmenter.flush("completed")) {
          if (effectiveVoiceOutputRef.current.requestTts) enqueueDashboardSpeech(speech, text);
        }
        speech.queue.finish();
      }
    } catch (caught) {
      if (!mountedRef.current || activeRequestRef.current?.id !== requestId) {
        return;
      }
      if (controller.signal.aborted) {
        const speech = speechSessionRef.current;
        if (speech?.generation === requestId) {
          speech.queue.cancel();
          speech.segmenter.reset();
        }
        dispatchMessages({
          type: "cancel",
          assistantId,
          error: "生成已取消，以上内容可能不完整。"
        });
        setRequestStatus("idle");
        applyPresenceEvent({ type: "generation", epoch: requestId, state: "interrupted" });
        return;
      }
      const message = friendlyChatError(caught);
      const speech = speechSessionRef.current;
      if (speech?.generation === requestId) {
        flushDashboardSpeechTail(
          speech.segmenter.flush("failed"),
          effectiveVoiceOutputRef.current.requestTts,
          (text) => enqueueDashboardSpeech(speech, text),
          () => speech.queue.finish()
        );
      }
      dispatchMessages({ type: "fail", assistantId, error: message });
      setError(message);
      setRequestStatus("error");
      applyPresenceEvent({ type: "generation", epoch: requestId, state: "idle" });
    } finally {
      if (activeRequestRef.current?.id === requestId) {
        activeRequestRef.current = null;
      }
    }
  }

  function stopGeneration(): void {
    const active = activeRequestRef.current;
    if (!active || active.completedObserved) {
      return;
    }
    recordChatTiming(timingRef, { stopRequestedAt: performance.now() });
    if (canInterruptGeneration(presenceProjectionRef.current, active.id)) {
      applyPresenceEvent({ type: "generation", epoch: active.id, state: "interrupted" });
    }
    active.controller.abort();
    if (speechSessionRef.current?.generation === active.id) {
      speechSessionRef.current.queue.cancel();
      speechSessionRef.current = null;
    }
    activeRequestRef.current = null;
    if (!mountedRef.current) {
      return;
    }
    dispatchMessages({
      type: "cancel",
      assistantId: active.assistantId,
      error: "生成已取消，以上内容可能不完整。"
    });
    setRequestStatus("idle");
  }

  function stopSpeech(): void {
    recordChatTiming(timingRef, { stopRequestedAt: performance.now() });
    const epoch = speechSessionRef.current?.generation ?? presenceProjectionRef.current.epoch;
    if (epoch) applyPresenceEvent({ type: "speech-cancelled", epoch });
    speechSessionRef.current?.queue.cancel();
    speechSessionRef.current = null;
    if (mountedRef.current) setVoicePlaybackStatus("stopped");
  }

  return (
    <PageShell title="Chat" subtitle="Send text turns through the persistent Runtime stream.">
      <div className="grid grid-cols-[1fr_280px] gap-4">
        <Panel title="Chat History" actions={<Pill status={requestStatus} />}>
          <div className="h-[420px] overflow-auto rounded-md border border-ink-100 bg-ink-50 p-3">
            {messages.length === 0 ? (
              <EmptyState title="No chat yet" message="Send a message to exercise the runtime." />
            ) : (
              <div className="space-y-3">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-md border p-3 ${message.role === "user" ? "border-cyan-100 bg-white" : "border-ink-200 bg-white"}`}
                  >
                    <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase text-ink-500">
                      <span>{message.role}</span>
                      {message.role === "assistant" && message.status && (
                        <span aria-live="polite">{chatStatusLabel(message.status)}</span>
                      )}
                    </div>
                    <ChatMessageContent role={message.role} content={message.content} />
                    {message.error && (
                      <div className="mt-2 text-xs text-red-700" role="alert">
                        {message.error}
                      </div>
                    )}
                    {message.traceId && (
                      <div className="mt-2 font-mono text-xs text-ink-500">
                        traceId: {message.traceId}
                      </div>
                    )}
                    {message.role === "user" && message.useMemory !== undefined && (
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink-500">
                        <span>readMemory: {message.readMemory ? "true" : "false"}</span>
                        <span>writeMemory: {message.writeMemory ? "true" : "false"}</span>
                        <span>voice output: {message.voiceOutput ? "enabled" : "disabled"}</span>
                      </div>
                    )}
                    {message.role === "assistant" && (
                      <ProviderMetadataSummary provider={message.provider} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {error && <Notice tone="error" title="Send failed" message={error} />}
          {lastTraceId && (
            <Notice
              tone="info"
              title="Latest trace"
              message={`${lastTraceId}. Open Prompt Preview to inspect the generated prompt for the latest turn.`}
            />
          )}
          <div className="mt-3 flex gap-2">
            <textarea
              className="field min-h-20"
              placeholder="Type a runtime test message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (shouldSubmitChatKey(event)) {
                  event.preventDefault();
                  void send();
                }
              }}
              aria-label="Chat message"
            />
            {requestStatus === "sending" && activeRequestRef.current ? (
              <button
                type="button"
                className="button-secondary h-20 w-24"
                onClick={stopGeneration}
                aria-label="Stop generating"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="button-primary h-20 w-24"
                disabled={Boolean(activeRequestRef.current) || !input.trim()}
                onClick={() => void send()}
                aria-label="Send message"
              >
                Send
              </button>
            )}
            {(voicePlaybackStatus === "synthesizing" || voicePlaybackStatus === "playing") && (
              <button
                type="button"
                className="button-secondary h-20 w-24"
                onClick={stopSpeech}
                aria-label="Stop speech"
              >
                Stop speech
              </button>
            )}
          </div>
          {voiceOutput && voicePlaybackStatus !== "idle" && (
            <div className="mt-2 text-xs text-ink-500" aria-live="polite">
              {dashboardVoicePlaybackStatusLabel(voicePlaybackStatus, actualPlaybackActive)}
            </div>
          )}
        </Panel>
        <div className="space-y-4">
          <Panel title="Lumi">
            <LumiCanvas
              ref={lumiRef}
              requestedProjection={presence}
              onModelLifecycle={setModelLifecycle}
              className="h-[420px] rounded-md bg-ink-900"
            />
          </Panel>
          <Panel title="Turn Options">
            <div className="space-y-4">
              <Field label="Session ID">
                <input
                  className="field"
                  value={sessionId}
                  onChange={(event) => setSessionId(event.target.value)}
                />
              </Field>
              <Toggle
                label="Read Memory"
                checked={readMemory}
                onChange={setReadMemory}
                note="Controls retrieval and prompt injection."
              />
              <Toggle
                label="Write Memory"
                checked={writeMemory}
                onChange={setWriteMemory}
                note="Controls whether this turn can create runtime memory."
              />
              <Toggle
                label="Prompt Preview"
                checked={promptPreview}
                onChange={setPromptPreview}
                note="The latest prompt preview remains available in the Prompt page."
              />
              <Toggle
                label="TTS output"
                checked={voiceOutput}
                onChange={setVoiceOutput}
                note="Synthesizes sentence segments locally while the text stream is arriving."
              />
              <div className="rounded-md border border-ink-100 bg-ink-50 p-3">
                <div className="label mb-2">Outgoing Payload</div>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-700">
                  {JSON.stringify(outgoingPayload, null, 2)}
                </pre>
              </div>
              <p className="text-xs leading-5 text-ink-500">
                Chat uses the persistent SSE endpoint. Refreshing the page does not restore chat
                history yet because no session-history API is available.
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </PageShell>
  );
}

export function dashboardVoicePlaybackStatusLabel(
  status: SpeechQueueState,
  actualPlaybackActive: boolean
): string {
  if (actualPlaybackActive) return "Speaking…";
  switch (status) {
    case "synthesizing":
      return "Preparing speech…";
    case "playing":
      return "Speech queued…";
    case "stopped":
      return "Speech stopped; generated text is preserved.";
    case "error":
      return "Speech unavailable; text response is preserved.";
    default:
      return "";
  }
}

function createChatMessageId(prefix: string): string {
  chatMessageSequence += 1;
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? chatMessageSequence}`;
}

function chatStatusLabel(status: NonNullable<ChatMessage["status"]>): string {
  switch (status) {
    case "streaming":
      return "生成中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function friendlyChatError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message || "消息请求失败。";
  }
  if (error instanceof Error && error.name === "MessageStreamProtocolError") {
    return "消息流协议错误，回复未完成。";
  }
  if (error instanceof Error && error.name === "MessageStreamError") {
    return error.message || "消息流处理失败。";
  }
  return "网络连接中断，回复未完成。";
}

function MemoryPage(props: {
  state: ReturnType<typeof useAsyncData<{ memories: MemoryRecord[] }>>;
  health: HealthResponse | null;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [subtypeFilter, setSubtypeFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [tagsFilter, setTagsFilter] = useState("");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [scopeIdFilter, setScopeIdFilter] = useState("");
  const [layerFilter, setLayerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [embeddingFilter, setEmbeddingFilter] = useState("all");
  const [embeddingProviderFilter, setEmbeddingProviderFilter] = useState("all");
  const [embeddingModelFilter, setEmbeddingModelFilter] = useState("all");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [minImportance, setMinImportance] = useState("0");
  const [searchMemories, setSearchMemories] = useState<MemoryRecord[] | null>(null);
  const [searchDebug, setSearchDebug] = useState<RetrievedMemoryDebug[]>([]);
  const [searchRetrievalMode, setSearchRetrievalMode] = useState<string | null>(null);
  const [searchExclusions, setSearchExclusions] = useState<{
    status?: number;
    time?: number;
    scope?: number;
  }>({});
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [resultSource, setResultSource] = useState<MemoryResultSource>("/memory/recent");
  const [createForm, setCreateForm] = useState<MemoryForm>(() => emptyMemoryForm());
  const [selectedMemory, setSelectedMemory] = useState<MemoryRecord | null>(null);
  const [editingMemory, setEditingMemory] = useState<MemoryRecord | null>(null);
  const [editForm, setEditForm] = useState<MemoryForm>(() => emptyMemoryForm());
  const [deleteTarget, setDeleteTarget] = useState<MemoryRecord | null>(null);
  const [editingCandidate, setEditingCandidate] = useState<MemoryCandidateReview | null>(null);
  const [candidateEditForm, setCandidateEditForm] = useState<MemoryForm>(() => emptyMemoryForm());
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyMemoryId, setBusyMemoryId] = useState<string | null>(null);
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceResult, setMaintenanceResult] = useState<MemoryMaintenanceSummary | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const candidates = useAsyncData((signal) => apiClient.listRecentMemoryCandidates(20, signal), []);
  const maintenanceHealth = useAsyncData(
    (signal) => apiClient.getMemoryMaintenanceHealth(signal),
    []
  );
  const maintenanceStatus = useAsyncData(
    (signal) => apiClient.getMemoryMaintenanceStatus(signal),
    []
  );
  const vectorIndexStatus = useAsyncData(
    (signal) => apiClient.getMemoryVectorIndexStatus(signal),
    []
  );
  const memoryMode = memoryModeFromHealth(props.health);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchMemories(null);
      setSearchDebug([]);
      setSearchRetrievalMode(null);
      setSearchExclusions({});
      setSearchError(null);
      setSearchLoading(false);
      setResultSource("/memory/recent");
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      void apiClient
        .searchMemories(trimmed, {
          type: typeFilter,
          subtype: subtypeFilter,
          source: sourceFilter,
          scope: scopeFilter,
          scopeId: scopeIdFilter,
          memoryLayer: layerFilter,
          status: statusFilter,
          tags: tagsFilter,
          minImportance,
          includeArchived,
          includeSuperseded,
          includeExpired,
          limit: 50
        })
        .then((result) => {
          setSearchMemories(result.memories);
          setSearchDebug(result.debugMemories ?? []);
          setSearchRetrievalMode(result.retrievalMode ?? null);
          setSearchExclusions({
            status: result.excludedByStatus ?? 0,
            time: result.excludedByTime ?? 0,
            scope: result.excludedByScope ?? 0
          });
          setResultSource("/memory/search");
        })
        .catch((caught) => {
          if (!controller.signal.aborted) {
            setSearchError(caught instanceof Error ? caught.message : "Memory search failed");
            setSearchMemories(null);
            setSearchDebug([]);
            setSearchRetrievalMode(null);
            setSearchExclusions({});
            setResultSource("local fallback");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setSearchLoading(false);
          }
        });
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [
    query,
    typeFilter,
    subtypeFilter,
    sourceFilter,
    tagsFilter,
    scopeFilter,
    scopeIdFilter,
    layerFilter,
    statusFilter,
    embeddingFilter,
    embeddingProviderFilter,
    embeddingModelFilter,
    minImportance,
    includeArchived,
    includeSuperseded,
    includeExpired
  ]);

  const sourceMemories = searchMemories ?? props.state.data?.memories ?? [];
  const searchDebugById = useMemo(
    () => new Map(searchDebug.map((memory) => [memory.id, memory])),
    [searchDebug]
  );
  const memories = sourceMemories.filter((memory) => {
    const matchesType = typeFilter === "all" || memory.type === typeFilter;
    const matchesSubtype = subtypeFilter === "all" || memory.subtype === subtypeFilter;
    const matchesSource = sourceFilter === "all" || memory.source === sourceFilter;
    const matchesScope = scopeFilter === "all" || memory.scope === scopeFilter;
    const matchesScopeId = scopeIdFilter.trim() === "" || memory.scopeId === scopeIdFilter.trim();
    const requestedTags = tagsFilter
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    const matchesTags =
      requestedTags.length === 0 ||
      requestedTags.some((tag) =>
        memory.tags.some((memoryTag) => memoryTag.toLowerCase().includes(tag))
      );
    const matchesLayer = layerFilter === "all" || memory.memoryLayer === layerFilter;
    const matchesStatus = statusFilter === "all" || memory.status === statusFilter;
    const hasEmbedding = Boolean(memory.hasEmbedding ?? memory.embeddedAt);
    const matchesEmbedding =
      embeddingFilter === "all" ||
      (embeddingFilter === "embedded" && hasEmbedding) ||
      (embeddingFilter === "missing" && !hasEmbedding);
    const matchesEmbeddingProvider =
      embeddingProviderFilter === "all" || memory.embeddingProvider === embeddingProviderFilter;
    const matchesEmbeddingModel =
      embeddingModelFilter === "all" || memory.embeddingModel === embeddingModelFilter;
    const min = parseImportance(minImportance) ?? 0;
    const matchesImportance = memory.importance >= min;
    const matchesQuery =
      searchMemories !== null ||
      query === "" ||
      memory.content.toLowerCase().includes(query.toLowerCase());
    return (
      matchesType &&
      matchesSubtype &&
      matchesSource &&
      matchesScope &&
      matchesScopeId &&
      matchesTags &&
      matchesLayer &&
      matchesStatus &&
      matchesEmbedding &&
      matchesEmbeddingProvider &&
      matchesEmbeddingModel &&
      matchesImportance &&
      matchesQuery
    );
  });
  const sources = Array.from(new Set(sourceMemories.map((memory) => memory.source))).sort();
  const embeddingProviders = Array.from(
    new Set(
      sourceMemories
        .map((memory) => memory.embeddingProvider)
        .filter((value): value is string => Boolean(value))
    )
  ).sort();
  const embeddingModels = Array.from(
    new Set(
      sourceMemories
        .map((memory) => memory.embeddingModel)
        .filter((value): value is string => Boolean(value))
    )
  ).sort();

  async function createMemory(): Promise<void> {
    if (!createForm.content.trim()) {
      return;
    }

    setError(null);
    setSuccess(null);
    try {
      await apiClient.createMemory(toCreateMemoryRequest(createForm));
      setCreateForm(emptyMemoryForm());
      setSuccess("Memory created.");
      await refreshMemories();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Create memory failed");
    }
  }

  async function loadMemory(id: string, mode: "view" | "edit"): Promise<void> {
    setDetailLoading(true);
    setError(null);
    try {
      const memory = await apiClient.getMemory(id);
      if (mode === "view") {
        setSelectedMemory(memory);
      } else {
        setEditingMemory(memory);
        setEditForm(memoryFormFromRecord(memory));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Load memory failed");
    } finally {
      setDetailLoading(false);
    }
  }

  async function saveEdit(): Promise<void> {
    if (!editingMemory) {
      return;
    }

    setBusyMemoryId(editingMemory.id);
    setError(null);
    setSuccess(null);
    try {
      const updated = await apiClient.updateMemory(
        editingMemory.id,
        toUpdateMemoryRequest(editForm)
      );
      setEditingMemory(null);
      setSelectedMemory(updated);
      setSuccess("Memory updated.");
      await refreshMemories();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update memory failed");
    } finally {
      setBusyMemoryId(null);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) {
      return;
    }

    setBusyMemoryId(deleteTarget.id);
    setError(null);
    setSuccess(null);
    try {
      await apiClient.deleteMemory(deleteTarget.id);
      setDeleteTarget(null);
      setSelectedMemory((current) => (current?.id === deleteTarget.id ? null : current));
      setEditingMemory((current) => (current?.id === deleteTarget.id ? null : current));
      setSuccess("Memory deleted.");
      await refreshMemories();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Delete memory failed");
    } finally {
      setBusyMemoryId(null);
    }
  }

  async function updateMemoryLifecycle(
    memory: MemoryRecord,
    action: "archive" | "restore" | "forget"
  ): Promise<void> {
    setBusyMemoryId(memory.id);
    setError(null);
    setSuccess(null);
    try {
      const result =
        action === "archive"
          ? await apiClient.archiveMemory(memory.id)
          : action === "restore"
            ? await apiClient.restoreMemory(memory.id)
            : await apiClient.forgetMemory(memory.id);
      setSelectedMemory(result.memory);
      setSuccess(
        action === "archive"
          ? "Memory archived."
          : action === "restore"
            ? "Memory restored."
            : "Memory marked forgotten."
      );
      await refreshMemories();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Memory ${action} failed`);
    } finally {
      setBusyMemoryId(null);
    }
  }

  async function acceptCandidate(candidate: MemoryCandidateReview): Promise<void> {
    setBusyCandidateId(candidate.id);
    setError(null);
    setSuccess(null);
    try {
      const acceptInput: AcceptMemoryCandidateRequest = {
        type: candidate.type,
        subtype: candidate.subtype ?? null,
        scopeId: candidate.scopeId ?? null,
        content: candidate.content,
        summary: candidate.summary ?? null,
        importance: candidate.importance,
        tags: candidate.tags,
        observedAt: candidate.observedAt ?? null,
        eventTime: candidate.eventTime ?? null,
        validFrom: candidate.validFrom ?? null,
        validUntil: candidate.validUntil ?? null,
        expiresAt: candidate.expiresAt ?? null,
        ...(candidate.scope ? { scope: candidate.scope } : {}),
        ...(candidate.memoryLayer ? { memoryLayer: candidate.memoryLayer } : {}),
        ...(candidate.possibleSupersedes
          ? { possibleSupersedes: candidate.possibleSupersedes }
          : {}),
        ...(candidate.possibleContradictions
          ? { possibleContradictions: candidate.possibleContradictions }
          : {})
      };
      const result = await apiClient.acceptMemoryCandidate(candidate.id, acceptInput);
      setSuccess(result.message ?? "Memory candidate accepted and saved.");
      await Promise.all([refreshMemories(), candidates.refresh()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Accept candidate failed");
    } finally {
      setBusyCandidateId(null);
    }
  }

  async function rejectCandidate(candidate: MemoryCandidateReview): Promise<void> {
    const reason = window.prompt("Optional rejection reason", "Rejected from Memory page.");
    if (reason === null) {
      return;
    }
    setBusyCandidateId(candidate.id);
    setError(null);
    setSuccess(null);
    try {
      await apiClient.rejectMemoryCandidate(candidate.id, reason || undefined);
      setSuccess("Memory candidate rejected.");
      await candidates.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Reject candidate failed");
    } finally {
      setBusyCandidateId(null);
    }
  }

  function editCandidate(candidate: MemoryCandidateReview): void {
    setEditingCandidate(candidate);
    setCandidateEditForm({
      type: candidate.type,
      subtype: candidate.subtype ?? "",
      scope: candidate.scope ?? "user",
      scopeId: candidate.scopeId ?? "",
      memoryLayer: candidate.memoryLayer ?? "core",
      status: "active",
      content: candidate.content,
      summary: candidate.summary ?? "",
      importance: String(candidate.importance),
      emotionValence: "0",
      emotionArousal: "0",
      tags: candidate.tags.join(", "),
      source: "dashboard",
      observedAt: toDateTimeLocalValue(candidate.observedAt),
      eventTime: toDateTimeLocalValue(candidate.eventTime),
      validFrom: toDateTimeLocalValue(candidate.validFrom),
      validUntil: toDateTimeLocalValue(candidate.validUntil),
      expiresAt: toDateTimeLocalValue(candidate.expiresAt)
    });
  }

  async function saveCandidateEdit(): Promise<void> {
    if (!editingCandidate) {
      return;
    }
    setBusyCandidateId(editingCandidate.id);
    setError(null);
    setSuccess(null);
    try {
      const result = await apiClient.acceptMemoryCandidate(
        editingCandidate.id,
        toAcceptCandidateRequest(candidateEditForm)
      );
      setEditingCandidate(null);
      setSuccess(result.message ?? "Edited candidate saved as memory.");
      await Promise.all([refreshMemories(), candidates.refresh()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save candidate failed");
    } finally {
      setBusyCandidateId(null);
    }
  }

  async function refreshMemories(): Promise<void> {
    await props.state.refresh();
    await maintenanceHealth.refresh();
    await maintenanceStatus.refresh();
    await vectorIndexStatus.refresh();
    if (query.trim()) {
      const result = await apiClient.searchMemories(query.trim(), {
        type: typeFilter,
        subtype: subtypeFilter,
        source: sourceFilter,
        scope: scopeFilter,
        scopeId: scopeIdFilter,
        memoryLayer: layerFilter,
        status: statusFilter,
        tags: tagsFilter,
        minImportance,
        includeArchived,
        includeSuperseded,
        includeExpired,
        limit: 50
      });
      setSearchMemories(result.memories);
      setSearchDebug(result.debugMemories ?? []);
      setSearchRetrievalMode(result.retrievalMode ?? null);
      setSearchExclusions({
        status: result.excludedByStatus ?? 0,
        time: result.excludedByTime ?? 0,
        scope: result.excludedByScope ?? 0
      });
      setResultSource("/memory/search");
    }
  }

  function clearFilters(): void {
    setQuery("");
    setTypeFilter("all");
    setSubtypeFilter("all");
    setSourceFilter("all");
    setTagsFilter("");
    setScopeFilter("all");
    setScopeIdFilter("");
    setLayerFilter("all");
    setStatusFilter("all");
    setEmbeddingFilter("all");
    setEmbeddingProviderFilter("all");
    setEmbeddingModelFilter("all");
    setIncludeArchived(false);
    setIncludeSuperseded(false);
    setIncludeExpired(false);
    setMinImportance("0");
    setSearchMemories(null);
    setSearchDebug([]);
    setSearchRetrievalMode(null);
    setSearchExclusions({});
    setSearchError(null);
    setResultSource("/memory/recent");
  }

  async function runMaintenance(dryRun: boolean): Promise<void> {
    if (!dryRun && !window.confirm("Run memory maintenance and mark eligible records expired?")) {
      return;
    }
    setMaintenanceBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await apiClient.runMemoryMaintenance({
        dryRun,
        limit: 100,
        ...(scopeFilter !== "all" ? { scope: scopeFilter } : {}),
        ...(scopeIdFilter.trim() ? { scopeId: scopeIdFilter.trim() } : {})
      });
      setMaintenanceResult(result.summary);
      setSuccess(dryRun ? "Maintenance dry run completed." : "Maintenance completed.");
      await refreshMemories();
      await maintenanceStatus.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Memory maintenance failed");
    } finally {
      setMaintenanceBusy(false);
    }
  }

  return (
    <PageShell title="Memory" subtitle="Manual memory management console for development.">
      <div className="grid grid-cols-3 gap-4">
        <StatusCard title="Repository" status={memoryMode} detail={memoryModeDetail(memoryMode)} />
        <StatusCard
          title="Result Source"
          status={resultSource}
          detail={
            query.trim()
              ? `Search active · mode: ${searchRetrievalMode ?? "unknown"} · excluded status/time/scope: ${
                  searchExclusions.status ?? 0
                }/${searchExclusions.time ?? 0}/${searchExclusions.scope ?? 0}`
              : "Showing recent memories"
          }
        />
        <StatusCard
          title="Records Shown"
          status={String(memories.length)}
          detail={props.state.error ?? searchError ?? "Current filtered result count"}
        />
      </div>
      <Notice
        tone="info"
        title="Memory mode"
        message="in-memory resets on server restart. postgres persists after DATABASE_URL is configured and pnpm db:migrate has been applied. Do not store secrets in memory."
      />
      <Panel title="Memory Health" badge={maintenanceHealth.data?.repository ?? memoryMode}>
        <div className="grid grid-cols-8 gap-2 text-xs text-ink-600">
          {memoryHealthEntries(maintenanceHealth.data?.health).map((entry) => (
            <div key={entry.label} className="rounded-md bg-ink-50 p-2">
              <div className="label">{entry.label}</div>
              <div className="font-semibold text-ink-800">{entry.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2 text-xs text-ink-600">
          {memoryMaintenanceStatusEntries(maintenanceStatus.data?.scheduler).map((entry) => (
            <div key={entry.label} className="rounded-md border border-ink-100 bg-white p-2">
              <div className="label">{entry.label}</div>
              <div className="font-mono text-[11px] text-ink-700">{entry.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className="button-secondary"
            type="button"
            disabled={maintenanceBusy}
            onClick={() => void runMaintenance(true)}
          >
            Run Maintenance Dry Run
          </button>
          <button
            className="button-secondary"
            type="button"
            disabled={maintenanceBusy}
            onClick={() => void runMaintenance(false)}
          >
            Run Maintenance
          </button>
          <span className="font-mono text-xs text-ink-500">
            pnpm memory:maintenance -- --dry-run
          </span>
        </div>
        {maintenanceResult && (
          <div className="mt-3 rounded-md border border-ink-100 bg-ink-50 p-3 text-xs text-ink-600">
            {`scanned=${maintenanceResult.scanned} expired=${maintenanceResult.expired} stale=${maintenanceResult.stale} supersessionWarnings=${maintenanceResult.supersessionWarnings} skipped=${maintenanceResult.skipped} failed=${maintenanceResult.failed}`}
          </div>
        )}
      </Panel>
      <Panel
        title="ANN Vector Index"
        badge={vectorIndexStatus.data?.status.vectorIndexType ?? "unknown"}
      >
        <div className="grid grid-cols-6 gap-2 text-xs text-ink-600">
          {vectorIndexEntries(vectorIndexStatus.data?.status).map((entry) => (
            <div key={entry.label} className="rounded-md bg-ink-50 p-2">
              <div className="label">{entry.label}</div>
              <div className="font-mono text-[11px] text-ink-700">{entry.value}</div>
            </div>
          ))}
        </div>
        {vectorIndexStatus.data?.status.indexFallbackReason && (
          <Notice
            tone="info"
            title="ANN fallback"
            message={`${vectorIndexStatus.data.status.indexFallbackReason} Retrieval still works without ANN acceleration.`}
          />
        )}
      </Panel>
      <div className="grid grid-cols-[1fr_340px] gap-4">
        <Panel title="Memory Records">
          <div className="mb-3 grid grid-cols-[1fr_150px_170px_150px_150px_auto] gap-3">
            <input
              className="field"
              placeholder="Search memory content"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              className="field"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
            >
              <option value="all">All types</option>
              {memoryTypes.map((memoryType) => (
                <option key={memoryType} value={memoryType}>
                  {memoryType}
                </option>
              ))}
            </select>
            <select
              className="field"
              value={subtypeFilter}
              onChange={(event) => setSubtypeFilter(event.target.value)}
            >
              <option value="all">All subtypes</option>
              {memorySubtypes.map((memorySubtype) => (
                <option key={memorySubtype} value={memorySubtype}>
                  {memorySubtype}
                </option>
              ))}
            </select>
            <select
              className="field"
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
            >
              <option value="all">All sources</option>
              {sources.map((memorySource) => (
                <option key={memorySource} value={memorySource}>
                  {memorySource}
                </option>
              ))}
            </select>
            <input
              className="field"
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={minImportance}
              onChange={(event) => setMinImportance(event.target.value)}
              aria-label="Minimum importance"
            />
            <button className="button-secondary" type="button" onClick={clearFilters}>
              Clear
            </button>
          </div>
          <div className="mb-3 grid grid-cols-[140px_1fr_160px_140px_140px_100px_110px_90px] gap-3">
            <select
              className="field"
              value={scopeFilter}
              onChange={(event) => setScopeFilter(event.target.value)}
            >
              <option value="all">All scopes</option>
              {memoryScopes.map((scope) => (
                <option key={scope} value={scope}>
                  {scope}
                </option>
              ))}
            </select>
            <input
              className="field"
              placeholder="scopeId, e.g. yuvi-runtime"
              value={scopeIdFilter}
              onChange={(event) => setScopeIdFilter(event.target.value)}
            />
            <input
              className="field"
              placeholder="tags, comma-separated"
              value={tagsFilter}
              onChange={(event) => setTagsFilter(event.target.value)}
            />
            <select
              className="field"
              value={layerFilter}
              onChange={(event) => setLayerFilter(event.target.value)}
            >
              <option value="all">All layers</option>
              {memoryLayers.map((layer) => (
                <option key={layer} value={layer}>
                  {layer}
                </option>
              ))}
            </select>
            <select
              className="field"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              {memoryStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-2 text-xs text-ink-600">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => setIncludeArchived(event.target.checked)}
              />
              archived
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-ink-600">
              <input
                type="checkbox"
                checked={includeSuperseded}
                onChange={(event) => setIncludeSuperseded(event.target.checked)}
              />
              superseded
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-ink-600">
              <input
                type="checkbox"
                checked={includeExpired}
                onChange={(event) => setIncludeExpired(event.target.checked)}
              />
              expired
            </label>
          </div>
          <div className="mb-3 grid grid-cols-[150px_180px_180px_1fr] gap-3">
            <select
              className="field"
              value={embeddingFilter}
              onChange={(event) => setEmbeddingFilter(event.target.value)}
            >
              <option value="all">All embeddings</option>
              <option value="embedded">Embedded</option>
              <option value="missing">Missing embedding</option>
            </select>
            <select
              className="field"
              value={embeddingProviderFilter}
              onChange={(event) => setEmbeddingProviderFilter(event.target.value)}
            >
              <option value="all">All embedding providers</option>
              {embeddingProviders.map((provider) => (
                <option key={provider} value={provider ?? ""}>
                  {provider}
                </option>
              ))}
            </select>
            <select
              className="field"
              value={embeddingModelFilter}
              onChange={(event) => setEmbeddingModelFilter(event.target.value)}
            >
              <option value="all">All embedding models</option>
              {embeddingModels.map((model) => (
                <option key={model} value={model ?? ""}>
                  {model}
                </option>
              ))}
            </select>
            <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-2 text-xs text-ink-600">
              Re-embed existing Postgres memories with{" "}
              <span className="font-mono">pnpm memory:embed:backfill</span>.
            </div>
          </div>
          {(props.state.loading || searchLoading) && (
            <Notice
              tone="info"
              title="Loading"
              message={query.trim() ? "Searching memories." : "Fetching recent memories."}
            />
          )}
          {props.state.error && (
            <Notice tone="error" title="Memory load failed" message={props.state.error} />
          )}
          {searchError && (
            <Notice
              tone="error"
              title="Memory search failed"
              message={`${searchError}. Showing local recent-memory fallback if available.`}
            />
          )}
          {success && <Notice tone="info" title="Saved" message={success} />}
          {error && <Notice tone="error" title="Memory action failed" message={error} />}
          {!props.state.loading && memories.length === 0 ? (
            <EmptyState
              title="No matching memories"
              message="Create a memory or adjust the filter."
            />
          ) : (
            <MemoryTable
              memories={memories}
              debugById={searchDebugById}
              onView={(memory) => void loadMemory(memory.id, "view")}
              onEdit={(memory) => void loadMemory(memory.id, "edit")}
              onArchive={(memory) => void updateMemoryLifecycle(memory, "archive")}
              onRestore={(memory) => void updateMemoryLifecycle(memory, "restore")}
              onForget={(memory) => void updateMemoryLifecycle(memory, "forget")}
              onDelete={setDeleteTarget}
            />
          )}
        </Panel>
        <Panel title="Create Memory">
          <MemoryFormFields form={createForm} setForm={setCreateForm} includeSource />
          <button
            className="button-primary mt-3 w-full"
            onClick={() => void createMemory()}
            disabled={!createForm.content.trim()}
          >
            Create memory
          </button>
        </Panel>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Panel title="最近候选记忆" badge="调试">
          <div className="mb-3 grid grid-cols-4 gap-2 text-xs text-ink-600">
            <div className="rounded-md bg-ink-50 p-2">
              <div className="label">Total</div>
              <div className="font-semibold text-ink-800">{candidates.data?.count ?? 0}</div>
            </div>
            <div className="rounded-md bg-ink-50 p-2">
              <div className="label">Stored</div>
              <div className="font-semibold text-ink-800">{candidates.data?.storedCount ?? 0}</div>
            </div>
            <div className="rounded-md bg-ink-50 p-2">
              <div className="label">Rejected</div>
              <div className="font-semibold text-ink-800">
                {candidates.data?.rejectedCount ?? 0}
              </div>
            </div>
            <div className="rounded-md bg-ink-50 p-2">
              <div className="label">Fallback</div>
              <div className="font-semibold text-ink-800">
                {String(candidates.data?.fallbackUsed ?? false)}
              </div>
            </div>
          </div>
          {candidates.data?.volatile && (
            <Notice
              tone="info"
              title="Volatile history"
              message={
                candidates.data.message ??
                "Candidate history is in-memory and resets when the server restarts."
              }
            />
          )}
          {candidates.loading && (
            <Notice tone="info" title="Loading" message="Fetching recent extraction candidates." />
          )}
          {candidates.error && (
            <Notice tone="error" title="Candidate load failed" message={candidates.error} />
          )}
          {!candidates.loading && (candidates.data?.candidates.length ?? 0) === 0 ? (
            <EmptyState
              title="No recent candidates"
              message="Send a message with Write Memory enabled to see extractor suggestions."
            />
          ) : (
            <MemoryCandidateList
              candidates={candidates.data?.candidates ?? []}
              busyCandidateId={busyCandidateId}
              onAccept={(candidate) => void acceptCandidate(candidate)}
              onReject={(candidate) => void rejectCandidate(candidate)}
              onEdit={editCandidate}
            />
          )}
        </Panel>
        <Panel title="Memory Details">
          {detailLoading && (
            <Notice tone="info" title="Loading" message="Fetching memory detail." />
          )}
          {!selectedMemory && !detailLoading ? (
            <EmptyState title="No memory selected" message="Use View to inspect a memory." />
          ) : selectedMemory ? (
            <MemoryDetail memory={selectedMemory} />
          ) : null}
        </Panel>
        <Panel title="Edit / Delete">
          {editingCandidate ? (
            <div>
              <div className="mb-3 rounded-md border border-ink-100 bg-ink-50 p-3 text-xs text-ink-600">
                Editing candidate {shortTrace(editingCandidate.id)} from trace{" "}
                {shortTrace(editingCandidate.sourceTraceId ?? editingCandidate.traceId)}.
              </div>
              <MemoryFormFields form={candidateEditForm} setForm={setCandidateEditForm} />
              <div className="mt-3 flex gap-2">
                <button
                  className="button-primary"
                  disabled={
                    busyCandidateId === editingCandidate.id || !candidateEditForm.content.trim()
                  }
                  onClick={() => void saveCandidateEdit()}
                >
                  Save as memory
                </button>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => setEditingCandidate(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : editingMemory ? (
            <div>
              <MemoryFormFields form={editForm} setForm={setEditForm} />
              <div className="mt-3 flex gap-2">
                <button
                  className="button-primary"
                  disabled={busyMemoryId === editingMemory.id}
                  onClick={() => void saveEdit()}
                >
                  Save changes
                </button>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => setEditingMemory(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : deleteTarget ? (
            <div className="space-y-3">
              <Notice
                tone="error"
                title="Confirm delete"
                message="Deletion cannot be undone in this development console."
              />
              <p className="text-sm text-ink-600">{memoryPreview(deleteTarget)}</p>
              <div className="flex gap-2">
                <button
                  className="button-primary"
                  disabled={busyMemoryId === deleteTarget.id}
                  onClick={() => void confirmDelete()}
                >
                  Delete memory
                </button>
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => setDeleteTarget(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <EmptyState
              title="No edit active"
              message="Use Edit or Delete from the memory table."
            />
          )}
        </Panel>
      </div>
    </PageShell>
  );
}

function ProvidersPage(props: {
  state: ReturnType<typeof useAsyncData<ProvidersStatusResponse>>;
}): JSX.Element {
  const [verifying, setVerifying] = useState<ProviderCapability | null>(null);
  const [verification, setVerification] = useState<ProviderVerificationResponse | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [inspectingChain, setInspectingChain] = useState<ProviderCapability | null>(null);
  const [chainInspection, setChainInspection] = useState<ProviderChainInspectionResponse | null>(
    null
  );
  const [chainInspectionError, setChainInspectionError] = useState<string | null>(null);
  const rows: Array<{
    label: string;
    capability: ProviderCapability;
    health: ProviderHealth | undefined;
  }> = [
    {
      label: "DeepSeek Chat",
      capability: "chat",
      health: props.state.data?.providers.chat
    },
    {
      label: "DeepSeek Reasoning",
      capability: "reasoning",
      health: props.state.data?.providers.reasoning
    },
    {
      label: "xAI TTS",
      capability: "tts",
      health: props.state.data?.providers.tts
    },
    {
      label: "xAI Vision",
      capability: "vision",
      health: props.state.data?.providers.vision
    },
    {
      label: "Alibaba DashScope STT",
      capability: "stt",
      health: props.state.data?.providers.stt
    },
    {
      label: "Embedding provider",
      capability: "embedding",
      health: props.state.data?.providers.embedding
    }
  ];

  async function verify(capability: "chat" | "reasoning" | "embedding"): Promise<void> {
    setVerifying(capability);
    setVerification(null);
    setVerificationError(null);
    try {
      setVerification(await apiClient.verifyProvider(capability));
    } catch (caught) {
      setVerificationError(caught instanceof Error ? caught.message : "Provider verify failed");
    } finally {
      // A failed live verification is retained as cached observation metadata
      // by the server. Refresh the zero-I/O status projection so it is visible.
      await props.state.refresh();
      setVerifying(null);
    }
  }

  async function inspectChain(capability: ProviderCapability): Promise<void> {
    setInspectingChain(capability);
    setChainInspection(null);
    setChainInspectionError(null);
    try {
      setChainInspection(await apiClient.verifyProviderChain(capability));
    } catch (caught) {
      setChainInspectionError(
        caught instanceof Error ? caught.message : "Provider chain inspection failed"
      );
    } finally {
      setInspectingChain(null);
    }
  }

  return (
    <PageShell
      title="Providers"
      subtitle="Local readiness and cached observations without exposing keys or raw secret configuration."
    >
      {props.state.loading && (
        <Notice tone="info" title="Loading" message="Fetching provider status." />
      )}
      {props.state.error && (
        <Notice tone="error" title="Provider health failed" message={props.state.error} />
      )}
      <div className="grid grid-cols-3 gap-4">
        <StatusCard
          title="Chat diagnostics"
          status={props.state.data?.providers.chat.readiness ?? "unknown"}
          detail={cachedObservationDetail(props.state.data?.providers.chat ?? {})}
        />
        <StatusCard
          title="Reasoning diagnostics"
          status={props.state.data?.providers.reasoning.readiness ?? "unknown"}
          detail={cachedObservationDetail(props.state.data?.providers.reasoning ?? {})}
        />
        <StatusCard
          title="Optional media diagnostics"
          status={optionalProviderReadinessSummary(props.state.data)}
          detail={optionalProviderObservationSummary(props.state.data)}
        />
      </div>
      <Notice
        tone="info"
        title="Diagnostics meanings"
        message="Local readiness only reports whether YUVI can construct a configured route; it never proves remote reachability. Cached observation is recorded only after an explicit live verification. Legacy available and generic health status are not remote-reachability evidence."
      />
      {props.state.data?.routes && <ProviderPriorityPanel routes={props.state.data.routes} />}
      <Panel
        title="Live verification (explicit provider I/O)"
        actions={
          <div className="flex gap-2">
            <button
              className="button-secondary"
              disabled={verifying !== null}
              onClick={() => void verify("chat")}
            >
              {verifying === "chat" ? "Live verifying Chat" : "Live verify Chat"}
            </button>
            <button
              className="button-secondary"
              disabled={verifying !== null}
              onClick={() => void verify("reasoning")}
            >
              {verifying === "reasoning" ? "Live verifying Reasoning" : "Live verify Reasoning"}
            </button>
            <button
              className="button-secondary"
              disabled={verifying !== null}
              onClick={() => void verify("embedding")}
            >
              {verifying === "embedding" ? "Live verifying Embedding" : "Live verify Embedding"}
            </button>
          </div>
        }
      >
        <p className="mb-3 text-sm leading-6 text-ink-600">
          Chat, reasoning, and embedding verification explicitly call the selected provider and may
          be billable. Results show only safe metadata; API keys and Authorization headers are never
          displayed.
        </p>
        {verificationError && (
          <Notice tone="error" title="Verification failed" message={verificationError} />
        )}
        {verification && <ProviderVerificationResult result={verification} />}
      </Panel>
      <Panel
        title="Provider-chain inspection"
        badge="Config-only / no provider I/O"
        actions={
          <div className="flex flex-wrap gap-2">
            {(["chat", "reasoning", "embedding", "tts", "stt", "vision"] as const).map(
              (capability) => (
                <button
                  key={capability}
                  className="button-secondary"
                  disabled={inspectingChain !== null}
                  onClick={() => void inspectChain(capability)}
                >
                  {inspectingChain === capability
                    ? `Inspecting ${capability}`
                    : `Inspect ${capability} chain`}
                </button>
              )
            )}
          </div>
        }
      >
        <p className="mb-3 text-sm leading-6 text-ink-600">
          Chain inspection only evaluates local route configuration and readiness. It makes no
          provider call: ready routes and skipped attempts are not live provider successes.
        </p>
        {chainInspectionError && (
          <Notice tone="error" title="Chain inspection failed" message={chainInspectionError} />
        )}
        {chainInspection && <ProviderChainInspectionResult result={chainInspection} />}
      </Panel>
      <Panel title="Provider Status">
        <div className="overflow-auto rounded-md border border-ink-100">
          <table className="w-full border-collapse">
            <thead className="bg-ink-50">
              <tr>
                <th className="table-cell">Capability</th>
                <th className="table-cell">Requirement</th>
                <th className="table-cell">Provider</th>
                <th className="table-cell">Local readiness</th>
                <th className="table-cell">Cached observation</th>
                <th className="table-cell">Last live observation</th>
                <th className="table-cell">Configured</th>
                <th className="table-cell">Mode</th>
                <th className="table-cell">Base URL</th>
                <th className="table-cell">Model</th>
                <th className="table-cell">Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className="table-cell font-medium">{row.label}</td>
                  <td className="table-cell text-ink-500">
                    {providerRequirementLabel(row.capability, row.health)}
                  </td>
                  <td className="table-cell">{row.health?.provider ?? "unknown"}</td>
                  <td className="table-cell">
                    <Pill status={row.health?.readiness ?? "unknown"} />
                    <div className="mt-1 text-xs text-ink-500">Local configuration only</div>
                  </td>
                  <td className="table-cell">
                    <Pill status={row.health?.observed ?? "unknown"} />
                    <div className="mt-1 text-xs text-ink-500">
                      {providerObservationLabel(row.health?.observed)}
                    </div>
                  </td>
                  <td className="table-cell text-ink-500">
                    {row.health?.lastVerifiedAt ? (
                      <>
                        <div>{formatDate(row.health.lastVerifiedAt)}</div>
                        {row.health.lastErrorCode && (
                          <div className="mt-1 text-rose-700">
                            {row.health.lastErrorCode}
                            {row.health.lastError ? `: ${row.health.lastError}` : ""}
                          </div>
                        )}
                      </>
                    ) : (
                      "No live verification recorded"
                    )}
                  </td>
                  <td className="table-cell text-ink-500">
                    {row.health?.configured ? "configured" : "missing config"}
                  </td>
                  <td className="table-cell text-ink-500">{row.health?.mock ? "mock" : "real"}</td>
                  <td className="table-cell text-ink-500">
                    {row.health?.baseUrl ?? "Not exposed by status endpoint"}
                  </td>
                  <td className="table-cell text-ink-500">
                    {row.health?.model ?? "Not exposed by status endpoint"}
                  </td>
                  <td className="table-cell text-ink-500">
                    {row.health?.message ?? "No message"}
                    {row.health?.embeddingNote ? (
                      <div className="mt-1 text-xs text-amber-700">{row.health.embeddingNote}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </PageShell>
  );
}

function ProviderPriorityPanel(props: {
  routes: NonNullable<ProvidersStatusResponse["routes"]>;
}): JSX.Element {
  const capabilities = ["chat", "reasoning", "embedding", "tts", "stt", "vision"] as const;
  return (
    <Panel title="Provider Priority" badge="Read-only v1">
      <div className="grid grid-cols-2 gap-3">
        {capabilities.map((capability) => (
          <div key={capability} className="rounded-md border border-ink-100 bg-white p-3">
            <div className="mb-2 text-sm font-semibold capitalize text-ink-800">{capability}</div>
            <ol className="space-y-2">
              {(props.routes[capability] ?? []).map((route) => (
                <li
                  key={`${capability}-${route.provider}-${route.priority}`}
                  className="grid grid-cols-[28px_1fr_auto] items-center gap-2 text-xs"
                >
                  <span className="font-mono text-ink-500">{route.priority ?? "-"}</span>
                  <span>
                    <span className="font-medium text-ink-800">{route.provider}</span>
                    <span className="ml-2 text-ink-500">{route.model ?? "no model"}</span>
                    <div className="mt-1 text-ink-500">
                      Local readiness: {providerReadinessLabel(route.readiness)}
                    </div>
                    <div className="mt-1 text-ink-500">
                      Cached observation: {providerObservationLabel(route.observed)}
                    </div>
                    {route.missingFields?.length ? (
                      <div className="text-rose-700">Missing: {route.missingFields.join(", ")}</div>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="text-ink-500">{route.mock ? "mock" : "real"}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-5 text-ink-500">
        Priority is configured through *_PROVIDER_CHAIN values. Route readiness is local only;
        observation is cached only after live verification. Apply Now reloads supported runtime
        config; Deep Restart restarts the supervised local runtime and reloads env files.
      </p>
    </Panel>
  );
}

function ProviderChainInspectionResult(props: {
  result: ProviderChainInspectionResponse;
}): JSX.Element {
  const result = props.result;
  return (
    <div className="rounded-md border border-ink-100 bg-ink-50 p-3 text-sm">
      <div className="grid grid-cols-4 gap-3">
        <Definition label="Inspection mode" value="Config-only / no provider I/O" />
        <Definition label="Capability" value={result.capability} />
        <Definition label="Local ready routes" value={String(result.readyRouteCount)} />
        <Definition
          label="Result"
          value={result.ok ? "Local route readiness found" : "No locally ready route"}
        />
      </div>
      <p className="mb-3 text-xs leading-5 text-ink-600">
        {result.message ||
          "No provider route was called. This inspection does not prove remote reachability."}
      </p>
      <div className="label mb-2">Route inspection attempts</div>
      <ul className="space-y-1 text-xs text-ink-600">
        {result.attemptedProviders.map((attempt) => (
          <li key={`${attempt.provider}-${attempt.priority ?? "default"}`}>
            <span className="font-medium">{attempt.provider}</span>: {providerAttemptLabel(attempt)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventsPage(props: {
  events: RuntimeEvent[];
  paused: boolean;
  wsStatus: string;
  onTogglePaused(): void;
}): JSX.Element {
  const [filter, setFilter] = useState("all");
  const filtered =
    filter === "all" ? props.events : props.events.filter((event) => event.type === filter);
  const types = Array.from(new Set(props.events.map((event) => event.type)));

  return (
    <PageShell
      title="Events"
      subtitle="Recent runtime events from the server, with live WebSocket updates when connected."
    >
      <Panel
        title="Event Stream"
        actions={
          <button className="button-secondary" onClick={props.onTogglePaused}>
            {props.paused ? "Resume" : "Pause"}
          </button>
        }
      >
        <div className="mb-3 grid grid-cols-[220px_1fr] gap-3">
          <select
            className="field"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All event types</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <div className="rounded-md border border-ink-200 px-3 py-2 text-sm text-ink-500">
            WebSocket status: {props.wsStatus}
          </div>
        </div>
        <EventTable events={filtered} />
      </Panel>
    </PageShell>
  );
}

function useDashboardEventStream({
  paused,
  onEvent
}: {
  paused: boolean;
  onEvent(event: RuntimeEvent): void;
}): WebSocketStatus {
  const [status, setStatus] = useState<WebSocketStatus>("connecting");
  const pausedRef = useRef(paused);
  const onEventRef = useRef(onEvent);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      setStatus((current) => (current === "connected" ? "paused" : current));
    } else {
      setStatus((current) => (current === "paused" ? "connected" : current));
    }
  }, [paused]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let closedByEffect = false;
    let socket: WebSocket | null = null;

    function connect(): void {
      setStatus((current) =>
        current === "disconnected" || current === "error" ? "reconnecting" : "connecting"
      );
      socket = apiClient.createDashboardWebSocket();

      socket.addEventListener("open", () => {
        setStatus(pausedRef.current ? "paused" : "connected");
      });

      socket.addEventListener("message", (message) => {
        const parsed = parseDashboardMessage(message.data);
        if (!parsed || isDashboardConnectedMessage(parsed) || pausedRef.current) {
          return;
        }
        onEventRef.current(parsed);
      });

      socket.addEventListener("error", () => {
        setStatus("error");
      });

      socket.addEventListener("close", () => {
        if (closedByEffect) {
          return;
        }
        setStatus("disconnected");
        reconnectTimerRef.current = window.setTimeout(connect, 2000);
      });
    }

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      socket?.close();
    };
  }, []);

  return status;
}

function parseDashboardMessage(raw: string): DashboardWebSocketMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (isDashboardConnectedMessage(parsed)) {
      return parsed;
    }
    if (isRuntimeEvent(parsed)) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function isDashboardConnectedMessage(
  value: unknown
): value is Extract<DashboardWebSocketMessage, { kind: "dashboard.connected" }> {
  return Boolean(
    value && typeof value === "object" && "kind" in value && value.kind === "dashboard.connected"
  );
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      "type" in value &&
      "traceId" in value &&
      "payload" in value
  );
}

function mergeEvents(...groups: RuntimeEvent[][]): RuntimeEvent[] {
  const seen = new Set<string>();
  const events: RuntimeEvent[] = [];

  for (const group of groups) {
    for (const event of group) {
      if (seen.has(event.id)) {
        continue;
      }
      seen.add(event.id);
      events.push(event);
    }
  }

  return events.sort((left, right) => {
    const leftTime = new Date(left.timestamp ?? left.createdAt ?? "").getTime();
    const rightTime = new Date(right.timestamp ?? right.createdAt ?? "").getTime();
    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

function PromptPreviewPage(): JSX.Element {
  const preview = useAsyncData((signal) => apiClient.getLatestPromptPreview(signal), []);
  const promptPreview = preview.data?.promptPreview;

  return (
    <PageShell
      title="Prompt Preview"
      subtitle="Latest development prompt preview from the runtime."
    >
      {preview.loading && (
        <Notice tone="info" title="Loading" message="Fetching latest prompt preview." />
      )}
      {preview.error && (
        <Notice tone="error" title="Prompt preview failed" message={preview.error} />
      )}
      {preview.data?.mock && (
        <Notice
          tone="info"
          title="No prompt yet"
          message={preview.data.message ?? "Send a message first."}
        />
      )}
      {promptPreview && (
        <div className="grid grid-cols-6 gap-3">
          <StatusCard
            title="Trace"
            status={shortTrace(promptPreview.traceId ?? preview.data?.traceId)}
            detail={formatDate(promptPreview.timestamp ?? preview.data?.timestamp ?? "")}
          />
          <StatusCard
            title="Read / Write"
            status={`${String(promptPreview.readMemory ?? preview.data?.readMemory ?? false)} / ${String(promptPreview.writeMemory ?? preview.data?.writeMemory ?? false)}`}
            detail={`Legacy aggregate: ${String(promptPreview.legacyUseMemory ?? preview.data?.legacyUseMemory ?? "not sent")} · repo: ${promptPreview.memoryRepository ?? preview.data?.memoryRepository ?? "unknown"}`}
          />
          <StatusCard
            title="Retrieved"
            status={String(
              promptPreview.retrievedMemoryCount ?? preview.data?.retrievedMemoryCount ?? 0
            )}
            detail={`raw: ${promptPreview.retrievedMemoryCountRaw ?? preview.data?.retrievedMemoryCountRaw ?? 0} · mode: ${promptPreview.retrievalMode ?? preview.data?.retrievalMode ?? "unknown"} · scope: ${promptPreview.retrievalScope ?? preview.data?.retrievalScope ?? "unknown"}`}
          />
          <StatusCard
            title="Vector"
            status={
              (promptPreview.vectorUsed ?? preview.data?.vectorUsed)
                ? "used"
                : (promptPreview.vectorEnabled ?? preview.data?.vectorEnabled)
                  ? "enabled"
                  : "off"
            }
            detail={`provider: ${promptPreview.embeddingProvider ?? preview.data?.embeddingProvider ?? "n/a"} · model: ${promptPreview.embeddingModel ?? preview.data?.embeddingModel ?? "n/a"} · dims: ${promptPreview.embeddingDimensions ?? preview.data?.embeddingDimensions ?? "n/a"} · semantic: ${String(promptPreview.semanticEmbedding ?? preview.data?.semanticEmbedding ?? false)} · query: ${String(promptPreview.queryEmbeddingGenerated ?? preview.data?.queryEmbeddingGenerated ?? false)} · vector/keyword/hybrid: ${promptPreview.vectorResultCount ?? preview.data?.vectorResultCount ?? 0}/${promptPreview.keywordResultCount ?? preview.data?.keywordResultCount ?? 0}/${promptPreview.hybridResultCount ?? preview.data?.hybridResultCount ?? 0}${(promptPreview.retrievalFallbackReason ?? preview.data?.retrievalFallbackReason) ? ` · fallback: ${promptPreview.retrievalFallbackReason ?? preview.data?.retrievalFallbackReason}` : ""}`}
          />
          <StatusCard
            title="Extractor"
            status={
              promptPreview.memoryExtractorActive ??
              preview.data?.memoryExtractorActive ??
              "unknown"
            }
            detail={`mode: ${promptPreview.memoryExtractorMode ?? preview.data?.memoryExtractorMode ?? "unknown"} · provider: ${promptPreview.memoryExtractorProvider ?? preview.data?.memoryExtractorProvider ?? "n/a"} · candidates: ${promptPreview.memoryExtractionCandidateCount ?? preview.data?.memoryExtractionCandidateCount ?? 0} · stored: ${promptPreview.storedMemoryCount ?? preview.data?.storedMemoryCount ?? 0} · rejected: ${promptPreview.rejectedMemoryCount ?? preview.data?.rejectedMemoryCount ?? 0} · fallback: ${String(promptPreview.fallbackUsed ?? preview.data?.fallbackUsed ?? false)}${(promptPreview.llmExtractionError ?? preview.data?.llmExtractionError) ? ` · ${promptPreview.llmExtractionError ?? preview.data?.llmExtractionError}` : ""}${(promptPreview.validationIssues ?? preview.data?.validationIssues)?.length ? ` · validation: ${(promptPreview.validationIssues ?? preview.data?.validationIssues)?.join("; ")}` : ""}${(promptPreview.memoryExtractionSkippedReason ?? preview.data?.memoryExtractionSkippedReason) ? ` · ${promptPreview.memoryExtractionSkippedReason ?? preview.data?.memoryExtractionSkippedReason}` : ""}`}
          />
          <StatusCard
            title="Tokens"
            status={String(promptPreview.estimatedTokens)}
            detail={promptPreview.truncated ? "Prompt truncated" : "Within budget"}
          />
          <StatusCard
            title="Provider"
            status={promptPreview.providerName ?? preview.data?.providerName ?? "unknown"}
            detail={providerPreviewDetail(promptPreview, preview.data)}
          />
          <StatusCard
            title="Direct Context"
            status={
              (promptPreview.directContextEnabled ?? preview.data?.directContextEnabled)
                ? "enabled"
                : "disabled"
            }
            detail={`turns: ${promptPreview.directContextTurnCount ?? preview.data?.directContextTurnCount ?? 0} · chars: ${
              promptPreview.directContextCharCount ?? preview.data?.directContextCharCount ?? 0
            } · truncated: ${String(
              promptPreview.directContextTruncated ?? preview.data?.directContextTruncated ?? false
            )} · source: ${
              promptPreview.directContextSource ?? preview.data?.directContextSource ?? "unknown"
            }`}
          />
        </div>
      )}
      {promptPreview && (
        <Notice
          tone="info"
          title="Retrieval policy"
          message={`included: ${formatIncludedScopes(
            promptPreview.includedScopes ?? preview.data?.includedScopes ?? []
          )} · include archived/superseded/expired: ${String(
            promptPreview.includeArchived ?? preview.data?.includeArchived ?? false
          )}/${String(
            promptPreview.includeSuperseded ?? preview.data?.includeSuperseded ?? false
          )}/${String(
            promptPreview.includeExpired ?? preview.data?.includeExpired ?? false
          )} · excluded status/time/scope: ${
            promptPreview.excludedByStatus ?? preview.data?.excludedByStatus ?? 0
          }/${promptPreview.excludedByTime ?? preview.data?.excludedByTime ?? 0}/${
            promptPreview.excludedByScope ?? preview.data?.excludedByScope ?? 0
          } · currentTime: ${promptPreview.currentTime ?? preview.data?.currentTime ?? "unknown"}`}
        />
      )}
      {(promptPreview?.llmExtractionRawPreview ?? preview.data?.llmExtractionRawPreview) && (
        <Notice
          tone="info"
          title="LLM extractor raw preview"
          message={
            promptPreview?.llmExtractionRawPreview ?? preview.data?.llmExtractionRawPreview ?? ""
          }
        />
      )}
      <div className="grid grid-cols-3 gap-4">
        {promptSections(preview.data).map((section) => (
          <Panel
            key={section.title}
            title={section.title}
            {...(section.mock
              ? { badge: "Placeholder" }
              : section.title === "RelevantMemory"
                ? { badge: "Memory Context" }
                : {})}
          >
            <p
              className={`whitespace-pre-wrap text-sm leading-6 ${
                section.title === "RelevantMemory"
                  ? "rounded-md border border-cyan-200 bg-cyan-50 p-3 text-cyan-950"
                  : "text-ink-600"
              }`}
            >
              {section.content}
            </p>
          </Panel>
        ))}
      </div>
      {promptPreview?.retrievedMemories && promptPreview.retrievedMemories.length > 0 && (
        <Panel title="Retrieved Memory Debug">
          <div className="max-h-[280px] overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-ink-500">
                <tr>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Subtype</th>
                  <th className="px-2 py-2">Scope</th>
                  <th className="px-2 py-2">Layer</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Source</th>
                  <th className="px-2 py-2">Match</th>
                  <th className="px-2 py-2">Embedding</th>
                  <th className="px-2 py-2">Importance</th>
                  <th className="px-2 py-2">Score</th>
                  <th className="px-2 py-2">Trace</th>
                  <th className="px-2 py-2">Display Text</th>
                  <th className="px-2 py-2">Excluded</th>
                </tr>
              </thead>
              <tbody>
                {promptPreview.retrievedMemories.map((memory) => (
                  <tr key={memory.id} className="border-t border-ink-100">
                    <td className="px-2 py-2 font-mono">{memory.type}</td>
                    <td className="px-2 py-2">{memory.subtype ?? ""}</td>
                    <td className="px-2 py-2">
                      {memory.scope}
                      {memory.scopeId ? `:${memory.scopeId}` : ""}
                    </td>
                    <td className="px-2 py-2">{memory.memoryLayer ?? ""}</td>
                    <td className="px-2 py-2">{memory.status ?? ""}</td>
                    <td className="px-2 py-2">{memory.source}</td>
                    <td className="px-2 py-2">{memory.matchedBy ?? "unknown"}</td>
                    <td className="px-2 py-2">
                      {memory.hasEmbedding ? "embedded" : "missing"}
                      <span className="block text-[10px] text-ink-400">
                        {[memory.embeddingProvider, memory.embeddingModel, memory.embeddedAt]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {memory.semanticEmbedding === false ? (
                        <span className="block text-[10px] text-amber-700">non-semantic</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2">{memory.importance.toFixed(2)}</td>
                    <td className="px-2 py-2">
                      {memory.score?.toFixed(2) ?? ""}
                      {memory.rankComponents ? (
                        <span className="block text-[10px] text-ink-400">
                          {formatRankComponents(memory.rankComponents)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 font-mono">
                      {shortTrace(memory.sourceTraceId ?? undefined)}
                    </td>
                    <td className="px-2 py-2 text-ink-700">{memory.displayText}</td>
                    <td className="px-2 py-2 text-amber-700">{memory.excludedReason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      {promptPreview?.finalMessages && (
        <Panel title="Final Messages">
          <div className="max-h-[360px] space-y-3 overflow-auto">
            {promptPreview.finalMessages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className="rounded-md border border-ink-100 bg-ink-50 p-3"
              >
                <div className="mb-1 text-xs font-semibold uppercase text-ink-500">
                  {message.role}
                </div>
                <pre className="whitespace-pre-wrap text-xs leading-5 text-ink-700">
                  {message.content}
                </pre>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {promptPreview?.memoryCandidates && promptPreview.memoryCandidates.length > 0 && (
        <Panel title="本轮候选记忆" badge="审核">
          <MemoryCandidateList candidates={promptPreview.memoryCandidates} compact />
        </Panel>
      )}
    </PageShell>
  );
}

function VoicePage(props: { providerStatus: ProvidersStatusResponse | null }): JSX.Element {
  const [sessionId, setSessionId] = useState("dashboard-voice");
  const [language, setLanguage] = useState("zh");
  const [speakerId, setSpeakerId] = useState("");
  const [voiceProfileId, setVoiceProfileId] = useState("");
  const [subjectUserId, setSubjectUserId] = useState("");
  const [audioBase64, setAudioBase64] = useState("");
  const [mockText, setMockText] = useState("烦死了，这个报错我看不懂");
  const [readMemory, setReadMemory] = useState(true);
  const [writeMemory, setWriteMemory] = useState(false);
  const [transcriptionResult, setTranscriptionResult] = useState<unknown>(null);
  const [voiceMessageResult, setVoiceMessageResult] = useState<unknown>(null);
  const [ttsText, setTtsText] = useState("YUVI runtime is online.");
  const [ttsVoice, setTtsVoice] = useState("");
  const [ttsResult, setTtsResult] = useState<unknown>(null);
  const [busy, setBusy] = useState<"transcribe" | "voice" | "tts" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const basePayload = {
    sessionId,
    mimeType: "audio/wav",
    ...(language.trim() ? { language: language.trim() } : {}),
    ...(speakerId.trim() ? { speakerId: speakerId.trim() } : {}),
    ...(voiceProfileId.trim() ? { voiceProfileId: voiceProfileId.trim() } : {}),
    ...(subjectUserId.trim() ? { subjectUserId: subjectUserId.trim() } : {}),
    ...(subjectUserId.trim() ? { createdByUserId: subjectUserId.trim() } : {}),
    ...(audioBase64.trim() ? { audioBase64: audioBase64.trim() } : {}),
    ...(mockText.trim() ? { mockText: mockText.trim() } : {})
  };

  async function transcribe(): Promise<void> {
    setBusy("transcribe");
    setError(null);
    try {
      setTranscriptionResult(await apiClient.transcribeAudio(basePayload));
    } catch (caught) {
      setError(
        caught instanceof Error ? friendlyMediaError(caught.message) : "Transcription failed"
      );
    } finally {
      setBusy(null);
    }
  }

  async function sendVoiceMessage(): Promise<void> {
    setBusy("voice");
    setError(null);
    try {
      setVoiceMessageResult(
        await apiClient.sendVoiceMessage({
          ...basePayload,
          options: {
            readMemory,
            writeMemory,
            promptPreview: true,
            voiceOutput: false
          }
        })
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? friendlyMediaError(caught.message) : "Voice message failed"
      );
    } finally {
      setBusy(null);
    }
  }

  async function synthesize(): Promise<void> {
    setBusy("tts");
    setError(null);
    try {
      setTtsResult(
        await apiClient.synthesizeSpeech({
          sessionId,
          text: ttsText,
          format: "wav",
          ...(ttsVoice.trim() ? { voice: ttsVoice.trim() } : {})
        })
      );
    } catch (caught) {
      setError(caught instanceof Error ? friendlyMediaError(caught.message) : "TTS failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <PageShell title="Voice" subtitle="Developer controls for STT, voice message, and TTS routes.">
      {error && <Notice tone="error" title="Voice request failed" message={error} />}
      <div className="grid grid-cols-2 gap-4">
        <ProviderChainBlock title="STT chain" routes={props.providerStatus?.routes?.stt ?? []} />
        <ProviderChainBlock title="TTS chain" routes={props.providerStatus?.routes?.tts ?? []} />
      </div>
      <div className="grid grid-cols-[1fr_0.9fr] gap-4">
        <Panel title="Speech Input">
          <div className="grid grid-cols-2 gap-3">
            <Field label="sessionId">
              <input
                className="field"
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
              />
            </Field>
            <Field label="language">
              <input
                className="field"
                value={language}
                onChange={(event) => setLanguage(event.target.value)}
              />
            </Field>
            <Field label="speakerId">
              <input
                className="field"
                value={speakerId}
                onChange={(event) => setSpeakerId(event.target.value)}
              />
            </Field>
            <Field label="voiceProfileId">
              <input
                className="field"
                value={voiceProfileId}
                onChange={(event) => setVoiceProfileId(event.target.value)}
              />
            </Field>
            <Field label="subjectUserId">
              <input
                className="field"
                value={subjectUserId}
                onChange={(event) => setSubjectUserId(event.target.value)}
              />
            </Field>
          </div>
          <Field label="audio file">
            <input
              className="field"
              type="file"
              accept="audio/*"
              onChange={(event) =>
                void loadFileAsBase64(event.currentTarget.files?.[0], setAudioBase64)
              }
            />
          </Field>
          <Field label="audioBase64">
            <textarea
              className="field min-h-24"
              value={audioBase64}
              onChange={(event) => setAudioBase64(event.target.value)}
              placeholder="Paste base64 audio, or use mockText when mock mode is enabled."
            />
          </Field>
          <Field label="mockText">
            <input
              className="field"
              value={mockText}
              onChange={(event) => setMockText(event.target.value)}
            />
          </Field>
          <div className="flex items-center gap-4 text-sm text-ink-600">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={readMemory}
                onChange={(event) => setReadMemory(event.target.checked)}
              />
              Read memory
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={writeMemory}
                onChange={(event) => setWriteMemory(event.target.checked)}
              />
              Write memory
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <button
              className="button-secondary"
              disabled={busy !== null}
              onClick={() => void transcribe()}
            >
              {busy === "transcribe" ? "Transcribing" : "Transcribe"}
            </button>
            <button
              className="button-primary"
              disabled={busy !== null}
              onClick={() => void sendVoiceMessage()}
            >
              {busy === "voice" ? "Sending" : "Send Voice Message"}
            </button>
          </div>
        </Panel>
        <Panel title="Voice Results">
          <ResultBlock title="Transcription" value={transcriptionResult} />
          <ResultBlock title="Voice Message" value={voiceMessageResult} />
        </Panel>
      </div>
      <div className="grid grid-cols-[1fr_0.9fr] gap-4">
        <Panel title="Text to Speech">
          <Field label="text">
            <textarea
              className="field min-h-28"
              value={ttsText}
              onChange={(event) => setTtsText(event.target.value)}
            />
          </Field>
          <Field label="voice">
            <input
              className="field"
              value={ttsVoice}
              onChange={(event) => setTtsVoice(event.target.value)}
            />
          </Field>
          <button
            className="button-secondary"
            disabled={busy !== null || !ttsText.trim()}
            onClick={() => void synthesize()}
          >
            {busy === "tts" ? "Generating" : "Generate Speech"}
          </button>
        </Panel>
        <Panel title="TTS Output">
          <ResultBlock title="TTS Metadata" value={ttsResult} />
          {isTTSResult(ttsResult) && ttsResult.audioBase64 ? (
            <audio
              className="mt-3 w-full"
              controls
              autoPlay
              src={`data:${ttsResult.mimeType};base64,${ttsResult.audioBase64}`}
            />
          ) : null}
        </Panel>
      </div>
    </PageShell>
  );
}

function VisionPage(props: { providerStatus: ProvidersStatusResponse | null }): JSX.Element {
  const [sessionId, setSessionId] = useState("dashboard-vision");
  const [subjectUserId, setSubjectUserId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [imageBase64, setImageBase64] = useState("");
  const [imageMimeType, setImageMimeType] = useState<VisionImageMimeType>("image/png");
  const [imageUrl, setImageUrl] = useState("");
  const [prompt, setPrompt] = useState("Describe the image safely and concisely.");
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setResult(
        await apiClient.analyzeVision({
          sessionId,
          mimeType: imageMimeType,
          prompt,
          ...(subjectUserId.trim() ? { subjectUserId: subjectUserId.trim() } : {}),
          ...(subjectUserId.trim() ? { createdByUserId: subjectUserId.trim() } : {}),
          ...(speakerId.trim() ? { speakerId: speakerId.trim() } : {}),
          ...(imageBase64.trim() ? { imageBase64: imageBase64.trim() } : {}),
          ...(imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {})
        })
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? friendlyMediaError(caught.message) : "Vision analysis failed"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageShell
      title="Vision"
      subtitle="Developer image analysis controls using the vision provider chain."
    >
      {error && <Notice tone="error" title="Vision request failed" message={error} />}
      <ProviderChainBlock
        title="Vision chain"
        routes={props.providerStatus?.routes?.vision ?? []}
      />
      <div className="grid grid-cols-[1fr_0.9fr] gap-4">
        <Panel title="Image Input">
          <div className="grid grid-cols-3 gap-3">
            <Field label="sessionId">
              <input
                className="field"
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
              />
            </Field>
            <Field label="subjectUserId">
              <input
                className="field"
                value={subjectUserId}
                onChange={(event) => setSubjectUserId(event.target.value)}
              />
            </Field>
            <Field label="speakerId">
              <input
                className="field"
                value={speakerId}
                onChange={(event) => setSpeakerId(event.target.value)}
              />
            </Field>
          </div>
          <Field label="image file">
            <input
              className="field"
              type="file"
              accept="image/png,image/jpeg"
              onChange={(event) =>
                void loadFileAsBase64(
                  event.currentTarget.files?.[0],
                  setImageBase64,
                  setImageMimeType
                ).catch((caught) => {
                  setError(caught instanceof Error ? caught.message : "Image file read failed");
                })
              }
            />
          </Field>
          <Field label="imageUrl">
            <input
              className="field"
              value={imageUrl}
              onChange={(event) => setImageUrl(event.target.value)}
            />
          </Field>
          <Field label="imageBase64">
            <textarea
              className="field min-h-24"
              value={imageBase64}
              onChange={(event) => setImageBase64(event.target.value)}
            />
          </Field>
          <Field label="image MIME">
            <select
              className="field"
              value={imageMimeType}
              onChange={(event) => {
                const normalized = normalizeVisionImageMimeType(event.target.value);
                if (normalized) setImageMimeType(normalized);
              }}
            >
              <option value="image/png">image/png (PNG)</option>
              <option value="image/jpeg">image/jpeg (JPEG)</option>
            </select>
          </Field>
          <Field label="prompt">
            <textarea
              className="field min-h-24"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
          <button className="button-primary" disabled={busy} onClick={() => void analyze()}>
            {busy ? "Analyzing" : "Analyze"}
          </button>
        </Panel>
        <Panel title="Vision Result">
          <ResultBlock title="Analysis" value={result} />
        </Panel>
      </div>
    </PageShell>
  );
}

function ProviderChainBlock(props: { title: string; routes: ProviderRouteHealth[] }): JSX.Element {
  const routes = props.routes;
  return (
    <Panel title={props.title} badge="Fallback order">
      {routes.length === 0 ? (
        <EmptyState title="No route data" message="Provider status has not loaded yet." />
      ) : (
        <ol className="space-y-2">
          {routes.map((route) => (
            <li
              key={`${route.provider}-${route.priority}`}
              className="grid grid-cols-[28px_1fr_auto] items-center gap-2 text-xs"
            >
              <span className="font-mono text-ink-500">{route.priority ?? "-"}</span>
              <span>
                <span className="font-medium text-ink-800">{route.provider}</span>
                <span className="ml-2 text-ink-500">{route.model ?? "no model"}</span>
                {route.missingFields?.length ? (
                  <div className="text-rose-700">Missing: {route.missingFields.join(", ")}</div>
                ) : null}
              </span>
              <span className="text-right text-ink-500">
                <div>Local readiness: {providerReadinessLabel(route.readiness)}</div>
                <div className="mt-1">
                  Cached observation: {providerObservationLabel(route.observed)}
                </div>
                <div className="mt-1">{route.mock ? "mock" : "real"}</div>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

function ResultBlock(props: { title: string; value: unknown }): JSX.Element {
  return (
    <div className="mb-3 rounded-md border border-ink-100 bg-ink-50 p-3">
      <div className="mb-2 text-xs font-semibold uppercase text-ink-500">{props.title}</div>
      {props.value ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-700">
          {JSON.stringify(props.value, null, 2)}
        </pre>
      ) : (
        <div className="text-sm text-ink-500">No result yet.</div>
      )}
    </div>
  );
}

async function loadFileAsBase64(
  file: File | undefined,
  setValue: (value: string) => void,
  setMimeType?: (value: VisionImageMimeType) => void
): Promise<void> {
  if (!file) return;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
  if (setMimeType) {
    const imageInput = toVisionFileInput(dataUrl, file.type);
    setMimeType(imageInput.mimeType);
    setValue(imageInput.imageBase64);
    return;
  }
  setValue(dataUrl.split(",", 2)[1] ?? "");
}

function isTTSResult(value: unknown): value is { audioBase64: string; mimeType: string } {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { audioBase64?: unknown }).audioBase64 === "string" &&
      typeof (value as { mimeType?: unknown }).mimeType === "string"
  );
}

function friendlyMediaError(message: string): string {
  if (message.includes("401")) {
    return "Dashboard dev token required. Enter DASHBOARD_DEV_TOKEN in the dashboard token field.";
  }
  return message;
}

function deepRestartErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return "Deep restart requires supervisor mode. Start with: YUVI_DEV_SUPERVISOR=1 ./scripts/dev.sh";
    }
    if (error.status === 401) {
      return "Dashboard dev token required. Enter DASHBOARD_DEV_TOKEN in the dashboard token field.";
    }
    if (error.status === 403) {
      return "Deep restart is localhost-only.";
    }
    if (error.status === 404 || error.status === 405) {
      return "Deep restart is disabled in production.";
    }
  }
  return error instanceof Error ? error.message : "Deep restart failed";
}

function SettingsPage(): JSX.Element {
  const settings = useAsyncData((signal) => apiClient.getRuntimeSettings(signal), []);
  const [form, setForm] = useState<SettingsForm>(() => emptySettingsForm());
  const [loadedForm, setLoadedForm] = useState<SettingsForm | null>(null);
  const [settingsState, setSettingsState] = useState<SettingsApplyState>("clean");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    mode: SettingsOperationMode;
    changedKeys: string[];
    restartRequired: boolean;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<RuntimeSettingsReloadResponse | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<ProviderCapability | null>(null);
  const [verification, setVerification] = useState<ProviderVerificationResponse | null>(null);
  const [clearedSecrets, setClearedSecrets] = useState<Set<SettingsKey>>(() => new Set());
  const [dashboardDevToken, setDashboardDevTokenState] = useState("");
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartResult, setRestartResult] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const operationSeqRef = useRef(0);
  const seededRef = useRef(false);
  const draftTouchedBeforeLoadRef = useRef(false);
  const formRef = useRef(form);
  const clearedSecretsRef = useRef(clearedSecrets);
  formRef.current = form;
  clearedSecretsRef.current = clearedSecrets;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!seededRef.current && !settings.data) {
      draftTouchedBeforeLoadRef.current =
        settingsFingerprint(form, clearedSecrets) !==
        settingsFingerprint(emptySettingsForm(), new Set());
    }
  }, [form, clearedSecrets, settings.data]);

  useEffect(() => {
    if (settings.data) {
      const next = settingsFormFromResponse(settings.data);
      setLoadedForm((current) => current ?? next);
      if (!seededRef.current) {
        const replaceDraft = shouldReplaceSettingsDraft(
          seededRef.current,
          draftTouchedBeforeLoadRef.current
        );
        seededRef.current = true;
        if (replaceDraft) setForm(next);
        else setSettingsState("dirty");
      }
    }
  }, [settings.data]);

  const draftDirty = settingsDraftDiffers(form, loadedForm, clearedSecrets);
  const operationBusy = saving || applying;

  useEffect(() => {
    const nextState = synchronizeSettingsDraftState(settingsState, draftDirty, operationBusy);
    if (nextState !== settingsState) setSettingsState(nextState);
  }, [draftDirty, operationBusy, settingsState]);

  function beginOperation(): number {
    const operation = ++operationSeqRef.current;
    setSaveError(null);
    setApplyError(null);
    setSaveResult(null);
    setApplyResult(null);
    return operation;
  }

  function operationIsCurrent(operation: number): boolean {
    return isCurrentSettingsOperation(mountedRef.current, operation, operationSeqRef.current);
  }

  function localValidation(snapshot: SettingsForm): string | null {
    const port = Number(snapshot.SERVER_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return "SERVER_PORT 必须是 1 到 65535 之间的整数。";
    }
    if (!snapshot.MEMORY_REPOSITORY.trim()) return "MEMORY_REPOSITORY 不能为空。";
    return null;
  }

  function updateBaselineAfterSave(snapshot: SettingsForm, refreshed: SettingsForm): void {
    setLoadedForm((current) => {
      const baseline = { ...(current ?? refreshed) };
      for (const key of Object.keys(refreshed) as SettingsKey[]) {
        baseline[key] = isSecretSettingsKey(key) ? snapshot[key] : refreshed[key];
      }
      return baseline;
    });
  }

  async function saveAndApply(): Promise<void> {
    if (operationBusy) return;
    const snapshot = { ...form };
    const snapshotClearedSecrets = new Set(clearedSecrets);
    const validationError = localValidation(snapshot);
    if (validationError) {
      setSettingsState("failed");
      setSaveError(validationError);
      return;
    }
    const operation = beginOperation();
    const fingerprint = settingsFingerprint(snapshot, snapshotClearedSecrets);
    let stage: "save" | "reload" | "refresh" = "save";
    setSaving(true);
    setSettingsState("saving");
    try {
      const response = await apiClient.updateRuntimeSettings({
        values: buildSettingsUpdate(snapshot, snapshotClearedSecrets)
      });
      if (!operationIsCurrent(operation)) return;
      setSaveResult({
        mode: "save-and-apply",
        changedKeys: response.changedKeys,
        restartRequired: response.restartRequired
      });
      setSettingsState("reloading");
      setApplying(true);
      stage = "reload";
      const reloadResponse = await apiClient.reloadRuntimeSettings();
      if (!operationIsCurrent(operation)) return;
      setApplyResult(reloadResponse);
      setSettingsState("refreshing");
      stage = "refresh";
      const refreshedResponse = await settings.refresh();
      if (!operationIsCurrent(operation)) return;
      if (!refreshedResponse) {
        setSettingsState(
          resolveSettingsOperationState("save-and-apply", {
            saveSucceeded: true,
            refreshSucceeded: false
          })
        );
        setApplyError("配置已保存，但重新读取生效值失败。");
        return;
      }
      const refreshedForm = settingsFormFromResponse(refreshedResponse);
      const comparison = compareSettingsForms(snapshot, refreshedForm, new Set(settingsSecretKeys));
      const activeRuntimeMismatch =
        refreshedResponse.runtime.serverHost !== refreshedResponse.activeRuntimeConfig.serverHost ||
        refreshedResponse.runtime.serverPort !== refreshedResponse.activeRuntimeConfig.serverPort ||
        normalizeRuntimeSettingForComparison("EVENT_BUS", refreshedResponse.runtime.eventBus) !==
          normalizeRuntimeSettingForComparison(
            "EVENT_BUS",
            refreshedResponse.activeRuntimeConfig.eventBus
          ) ||
        normalizeRuntimeSettingForComparison(
          "MEMORY_REPOSITORY",
          refreshedResponse.memory.memoryRepository
        ) !==
          normalizeRuntimeSettingForComparison(
            "MEMORY_REPOSITORY",
            refreshedResponse.activeRuntimeConfig.memoryRepository
          ) ||
        (refreshedResponse.memory.memoryExtractor !== undefined &&
          refreshedResponse.activeRuntimeConfig.memoryExtractor !== undefined &&
          refreshedResponse.memory.memoryExtractor !==
            refreshedResponse.activeRuntimeConfig.memoryExtractor);
      updateBaselineAfterSave(snapshot, refreshedForm);
      const currentFingerprint = settingsFingerprint(formRef.current, clearedSecretsRef.current);
      const draftChangedDuringSave = currentFingerprint !== fingerprint;
      if (!draftChangedDuringSave) {
        setClearedSecrets(new Set());
      }
      const restartRequired =
        response.restartRequired ||
        reloadResponse.restartRequired ||
        refreshedResponse.restartRequired ||
        refreshedResponse.runtime.pendingRestart ||
        reloadResponse.notHotReloaded.length > 0;
      const applyConfirmed =
        reloadResponse.applied && !restartRequired && comparison.mismatchedKeys.length === 0;
      const confirmedActiveRuntime = applyConfirmed && !activeRuntimeMismatch;
      const resolvedState = resolveSettingsOperationState("save-and-apply", {
        saveSucceeded: true,
        refreshSucceeded: true,
        applyConfirmed: confirmedActiveRuntime,
        restartRequired,
        draftChangedDuringOperation: draftChangedDuringSave
      });
      setSettingsState(resolvedState);
      if (resolvedState === "restart-required") {
        setApplyError(
          reloadResponse.notHotReloaded.length > 0
            ? `配置已保存，需要重启后生效：${reloadResponse.notHotReloaded.join(", ")}`
            : "配置已保存，需要重启后生效。"
        );
      } else if (resolvedState === "failed") {
        let applyFailureMessage = "配置已保存，但 Runtime 应用或刷新确认未完成。";
        if (comparison.mismatchedKeys.length > 0) {
          applyFailureMessage = `配置已保存，但实际生效值不一致：${comparison.mismatchedKeys.join(", ")}`;
        } else if (activeRuntimeMismatch) {
          applyFailureMessage =
            "配置已保存，但 refreshed activeRuntimeConfig 仍与 saved / effective configuration 不一致。";
        }
        setApplyError(applyFailureMessage);
      }
    } catch (caught) {
      if (!operationIsCurrent(operation)) return;
      setSettingsState("failed");
      const message = caught instanceof Error ? caught.message : "保存或应用配置失败";
      if (stage === "save") setSaveError(message);
      else setApplyError(message);
    } finally {
      if (operationIsCurrent(operation)) {
        setSaving(false);
        setApplying(false);
      }
    }
  }

  async function saveOnly(): Promise<void> {
    if (operationBusy) return;
    const snapshot = { ...form };
    const snapshotClearedSecrets = new Set(clearedSecrets);
    const validationError = localValidation(snapshot);
    if (validationError) {
      setSettingsState("failed");
      setSaveError(validationError);
      return;
    }
    const operation = beginOperation();
    setSaving(true);
    setSettingsState("saving");
    try {
      const response = await apiClient.updateRuntimeSettings({
        values: buildSettingsUpdate(snapshot, snapshotClearedSecrets)
      });
      if (!operationIsCurrent(operation)) return;
      setSaveResult({
        mode: "save-only",
        changedKeys: response.changedKeys,
        restartRequired: response.restartRequired
      });
      const refreshed = await settings.refresh();
      if (!operationIsCurrent(operation)) return;
      if (!refreshed) {
        setSettingsState(
          resolveSettingsOperationState("save-only", {
            saveSucceeded: true,
            refreshSucceeded: false
          })
        );
        setApplyError("配置已保存，但重新读取配置失败。");
        return;
      }
      const refreshedForm = settingsFormFromResponse(refreshed);
      updateBaselineAfterSave(snapshot, refreshedForm);
      const draftChangedDuringSave =
        settingsFingerprint(formRef.current, clearedSecretsRef.current) !==
        settingsFingerprint(snapshot, snapshotClearedSecrets);
      const restartRequired =
        response.restartRequired || refreshed.restartRequired || refreshed.runtime.pendingRestart;
      setSettingsState(
        resolveSettingsOperationState("save-only", {
          saveSucceeded: true,
          refreshSucceeded: true,
          restartRequired,
          draftChangedDuringOperation: draftChangedDuringSave
        })
      );
      if (!draftChangedDuringSave) {
        setClearedSecrets(new Set());
      }
    } catch (caught) {
      if (!operationIsCurrent(operation)) return;
      setSettingsState("failed");
      setSaveError(caught instanceof Error ? caught.message : "保存配置失败");
    } finally {
      if (operationIsCurrent(operation)) setSaving(false);
    }
  }

  async function reloadCurrentConfig(): Promise<void> {
    if (operationBusy) return;
    if (draftDirty && !window.confirm("当前有未保存更改，重新载入会丢弃草稿。继续吗？")) return;
    const operation = beginOperation();
    setApplying(true);
    setSettingsState("refreshing");
    try {
      const refreshed = await settings.refresh();
      if (!operationIsCurrent(operation)) return;
      if (!refreshed) {
        setSettingsState("failed");
        setApplyError("重新载入配置失败。");
        return;
      }
      const next = settingsFormFromResponse(refreshed);
      setForm(next);
      setLoadedForm(next);
      setClearedSecrets(new Set());
      setSettingsState("clean");
    } catch (caught) {
      if (!operationIsCurrent(operation)) return;
      setSettingsState("failed");
      setApplyError(caught instanceof Error ? caught.message : "重新载入配置失败");
    } finally {
      if (operationIsCurrent(operation)) setApplying(false);
    }
  }

  async function verify(capability: ProviderCapability): Promise<void> {
    setVerifying(capability);
    setVerification(null);
    const configOnly = capability === "tts" || capability === "stt" || capability === "vision";
    try {
      const result = await apiClient.verifyProvider(capability);
      if (mountedRef.current) setVerification(result);
    } catch (caught) {
      if (mountedRef.current) {
        setVerification({
          ok: false,
          provider: "unknown",
          capability,
          mock: false,
          ...(configOnly ? { configOnly: true as const } : {}),
          verificationMode: configOnly ? "config_only" : "live",
          error: caught instanceof Error ? caught.message : "Provider 验证失败"
        });
      }
    } finally {
      // Status reads are local/cache-only and let the settings summaries show
      // any observation recorded by an explicit live verification.
      void settings.refresh();
      if (mountedRef.current) setVerifying(null);
    }
  }

  async function deepRestart(): Promise<void> {
    if (
      !window.confirm(
        "Restart the local runtime, reload env files, and possibly run db:migrate? This is dev-only."
      )
    ) {
      return;
    }
    setRestartBusy(true);
    setRestartResult(null);
    setRestartError(null);
    try {
      const response = await apiClient.deepRestartRuntime();
      if (mountedRef.current) setRestartResult(response.message);
    } catch (caught) {
      if (mountedRef.current) setRestartError(deepRestartErrorMessage(caught));
    } finally {
      if (mountedRef.current) setRestartBusy(false);
    }
  }

  const activeChat = settings.data?.providers.deepseek.status?.chat;
  const activeReasoning = settings.data?.providers.deepseek.status?.reasoning;
  const savedDeepSeekButRuntimeMock =
    Boolean(settings.data?.providers.deepseek.apiKeyConfigured) && activeChat?.mock === true;
  const savedConfigDiffersFromActive =
    savedDeepSeekButRuntimeMock ||
    Boolean(
      settings.data &&
        (settings.data.runtime.serverHost !== settings.data.activeRuntimeConfig.serverHost ||
          settings.data.runtime.serverPort !== settings.data.activeRuntimeConfig.serverPort ||
          normalizeRuntimeSettingForComparison("EVENT_BUS", settings.data.runtime.eventBus) !==
            normalizeRuntimeSettingForComparison(
              "EVENT_BUS",
              settings.data.activeRuntimeConfig.eventBus
            ) ||
          normalizeRuntimeSettingForComparison(
            "MEMORY_REPOSITORY",
            settings.data.memory.memoryRepository
          ) !==
            normalizeRuntimeSettingForComparison(
              "MEMORY_REPOSITORY",
              settings.data.activeRuntimeConfig.memoryRepository
            ) ||
          (settings.data.memory.memoryExtractor !== undefined &&
            settings.data.activeRuntimeConfig.memoryExtractor !== undefined &&
            settings.data.memory.memoryExtractor !==
              settings.data.activeRuntimeConfig.memoryExtractor))
    );
  const configLayerKeys = [
    "SERVER_HOST",
    "SERVER_PORT",
    "EVENT_BUS",
    "PROVIDER_ALLOW_MOCKS",
    "MEMORY_REPOSITORY",
    "DATABASE_URL",
    "MEMORY_EXTRACTOR",
    "DEEPSEEK_API_BASEURL",
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_CHAT_MODEL",
    "DEEPSEEK_REASONING_MODEL",
    "XAI_API_KEY",
    "DASHSCOPE_API_KEY",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_API_KEY"
  ];
  const restartStatus = settings.data?.runtime.devSupervisor;
  const restartSupported = restartStatus?.restartSupported;
  const deepRestartDisabled =
    restartBusy ||
    settings.data?.runtime.runtimeMode === "production" ||
    restartSupported === false;
  const savedEffectiveRuntimeSummary = settings.data
    ? `${settings.data.runtime.serverHost}:${settings.data.runtime.serverPort} · event bus ${settings.data.runtime.eventBus} · memory ${settings.data.memory.memoryRepository}`
    : "unknown";
  const activeRuntimeSummary = settings.data
    ? `${settings.data.activeRuntimeConfig.serverHost}:${settings.data.activeRuntimeConfig.serverPort} · event bus ${settings.data.activeRuntimeConfig.eventBus} · memory ${settings.data.activeRuntimeConfig.memoryRepository}`
    : "unknown";
  const effectiveConfigKeyCount = Object.keys(settings.data?.effectiveConfig ?? {}).length;
  const pendingRestart = settings.data?.runtime.pendingRestart ?? false;

  function updateDashboardDevToken(value: string): void {
    setDashboardDevTokenState(value);
    apiClient.setDashboardDevToken(value.trim());
  }

  return (
    <PageShell title="Settings" subtitle="Local development runtime configuration.">
      {settings.loading && (
        <Notice tone="info" title="Loading" message="Fetching safe runtime settings." />
      )}
      {settings.error && (
        <Notice tone="error" title="Settings load failed" message={settings.error} />
      )}
      <Panel title="Settings truth">
        <div className="grid grid-cols-3 gap-3">
          <Definition
            label="Draft (editor only)"
            value={draftDirty ? "Unsaved changes" : "No unsaved changes"}
          />
          <Definition
            label="Saved / effective configuration"
            value={
              settings.data ? `effectiveConfig · ${effectiveConfigKeyCount} safe keys` : "unknown"
            }
          />
          <Definition label="Active Runtime" value="activeRuntimeConfig" />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-3 text-sm leading-6 text-ink-600">
          <p>
            Saved / effective:{" "}
            <span className="font-mono text-ink-700">{savedEffectiveRuntimeSummary}</span>
          </p>
          <p>
            Active Runtime: <span className="font-mono text-ink-700">{activeRuntimeSummary}</span>
          </p>
        </div>
        <p className="mt-2 text-xs leading-5 text-ink-500">
          Draft values exist only in this editor. Saved / effective values come from the layered
          .env and .env.local configuration; Active Runtime values come from the running Runtime
          snapshot. They can differ until Save &amp; Apply or Deep Restart completes.
        </p>
        {pendingRestart && (
          <Notice
            tone="info"
            title="Restart evidence"
            message="Saved / effective configuration contains a pending restart difference; Active Runtime has not converged for those settings."
          />
        )}
      </Panel>
      {draftDirty && (
        <Notice
          tone="info"
          title={settingsStateLabels.dirty}
          message="草稿尚未保存到 .env.local。"
        />
      )}
      {settingsState === "saving" && (
        <Notice tone="info" title={settingsStateLabels.saving} message="正在保存配置草稿。" />
      )}
      {settingsState === "reloading" && (
        <Notice
          tone="info"
          title={settingsStateLabels.reloading}
          message="正在将配置应用到 Runtime。"
        />
      )}
      {settingsState === "refreshing" && (
        <Notice
          tone="info"
          title={settingsStateLabels.refreshing}
          message="正在重新读取配置以确认生效。"
        />
      )}
      {settingsState === "saved-not-applied" && (
        <Notice
          tone="info"
          title={settingsStateLabels["saved-not-applied"]}
          message="配置已写入 .env.local，并在 saved / effective configuration 中确认；本次“仅保存”没有重新加载 Active Runtime。使用“保存并应用”或 Deep Restart 才会尝试让 Active Runtime 收敛。"
        />
      )}
      {settingsState === "applied" && (
        <Notice
          tone="info"
          title={settingsStateLabels.applied}
          message="保存、Runtime reload 和刷新确认均成功；本次保存快照已确认在 Active Runtime 中生效。"
        />
      )}
      {settingsState === "restart-required" && !applyError && (
        <Notice
          tone="info"
          title={settingsStateLabels["restart-required"]}
          message="Saved / effective configuration 已更新，但 Active Runtime 尚未应用需要重启的设置。请执行 Deep Restart。"
        />
      )}
      {saveError && <Notice tone="error" title="保存失败" message={saveError} />}
      {applyError && (
        <Notice
          tone="error"
          title={settingsState === "restart-required" ? "已保存，需要重启" : "应用失败"}
          message={applyError}
        />
      )}
      {restartError && <Notice tone="error" title="Deep restart failed" message={restartError} />}
      {restartResult && (
        <Notice tone="info" title="Deep restart requested" message={restartResult} />
      )}
      {saveResult && (
        <Notice
          tone="info"
          title={saveResult.mode === "save-only" ? "已保存（saved / effective）" : "保存阶段完成"}
          message={`${saveResult.changedKeys.length || 0} 项发生变化。${saveResult.mode === "save-only" ? "本次 Save Only 未应用到 Active Runtime。" : "Save & Apply 的 Active Runtime 结果以 Runtime 应用和刷新确认状态为准。"}${saveResult.restartRequired ? "部分配置需要重启。" : ""}`}
        />
      )}
      {applyResult && (
        <Notice
          tone="info"
          title="Runtime 应用结果"
          message={`${applyResult.message}${applyResult.notHotReloaded.length ? `；需要重启：${applyResult.notHotReloaded.join(", ")}` : ""}`}
        />
      )}
      {savedDeepSeekButRuntimeMock && (
        <Notice
          tone="info"
          title="已保存但尚未生效"
          message="DeepSeek 配置已保存，但当前 Runtime 仍是 mock。请点击“保存并应用”或重启服务。"
        />
      )}
      {savedConfigDiffersFromActive && (
        <Notice
          tone="info"
          title="Saved / effective 与 Active Runtime 不一致"
          message="配置已写入 .env.local，但 activeRuntimeConfig 仍显示不同值。请点击“保存并应用”重新加载可热更新配置；记忆或服务边界变更需要 Deep Restart。"
        />
      )}
      <div className="grid grid-cols-2 gap-4">
        <Panel title="Runtime">
          <SettingsInput form={form} name="SERVER_HOST" setForm={setForm} />
          <SettingsInput form={form} name="SERVER_PORT" setForm={setForm} />
          <SettingsInput form={form} name="EVENT_BUS" setForm={setForm} />
          <SettingsInput form={form} name="PROVIDER_ALLOW_MOCKS" setForm={setForm} />
          <Definition
            label="Runtime mode"
            value={settings.data?.runtime.runtimeMode ?? "unknown"}
          />
          <Definition
            label="Mock fallback allowed"
            value={settings.data?.runtime.providerAllowMocks ? "true" : "false"}
          />
          <Field label="X-YUVI-Dev-Token">
            <input
              className="field"
              type="password"
              value={dashboardDevToken}
              autoComplete="off"
              onChange={(event) => updateDashboardDevToken(event.target.value)}
              placeholder="Local dashboard token"
            />
          </Field>
          <p className="text-xs leading-5 text-ink-500">
            Stored only in this browser session and sent as a header for protected local POST,
            PATCH, and DELETE requests.
          </p>
          <p className="text-xs leading-5 text-ink-500">
            Active Runtime (activeRuntimeConfig):{" "}
            {settings.data?.runtime.activeServerHost ?? "unknown"}:
            {settings.data?.runtime.activeServerPort ?? "unknown"} · event bus{" "}
            {settings.data?.runtime.activeEventBus ?? "unknown"}
          </p>
          <div className="mt-4 rounded-md border border-ink-100 bg-ink-50 p-3">
            <div className="grid grid-cols-2 gap-3">
              <Definition
                label="Supervisor active"
                value={settings.data?.runtime.devSupervisor?.active ? "true" : "false"}
              />
              <Definition
                label="Auto migrate"
                value={settings.data?.runtime.devSupervisor?.autoMigrate ? "true" : "false"}
              />
              <Definition
                label="Restart supported"
                value={settings.data?.runtime.devSupervisor?.restartSupported ? "true" : "false"}
              />
              <Definition
                label="Env dir"
                value={settings.data?.runtime.devSupervisor?.runtimeEnvDir ?? "unknown"}
              />
            </div>
          </div>
          {settings.data?.runtime.pendingRestart && (
            <Notice
              tone="info"
              title="Restart required"
              message=".env.local contains pending overrides. Restart the dev server for active runtime values to match."
            />
          )}
        </Panel>
        <Panel title="Memory">
          <Field label="MEMORY_REPOSITORY">
            <select
              className="field"
              value={form.MEMORY_REPOSITORY}
              onChange={(event) => setFormValue(setForm, "MEMORY_REPOSITORY", event.target.value)}
            >
              <option value="in-memory">in-memory</option>
              <option value="postgres">postgres</option>
            </select>
          </Field>
          <p className="mt-3 text-sm leading-6 text-ink-600">
            Active mode: {settings.data?.memory.activeMemoryRepository ?? "unknown"}. in-memory
            resets on server restart. postgres requires DATABASE_URL and pnpm db:migrate.
          </p>
          {form.MEMORY_REPOSITORY === "postgres" && (
            <Notice
              tone="info"
              title="Postgres reminder"
              message="This change is config-only for now. Restart the server after ensuring DATABASE_URL is set and migrations have been applied."
            />
          )}
          <SecretInput
            label="DATABASE_URL"
            configured={settings.data?.memory.databaseUrlConfigured}
            preview={undefined}
            value={form.DATABASE_URL}
            onChange={(value) => setFormValue(setForm, "DATABASE_URL", value)}
            onClear={() => clearSecret(setForm, setClearedSecrets, "DATABASE_URL")}
          />
          <div className="mt-4 border-t border-ink-100 pt-4">
            <Field label="MEMORY_EXTRACTOR">
              <select
                className="field"
                value={form.MEMORY_EXTRACTOR}
                onChange={(event) => setFormValue(setForm, "MEMORY_EXTRACTOR", event.target.value)}
              >
                <option value="llm">llm - recommended/default</option>
                <option value="rule-based">rule-based - no token usage</option>
              </select>
            </Field>
            <p className="mt-2 text-sm leading-6 text-ink-600">
              llm uses DeepSeek Reasoning for higher-quality memory candidates and may consume
              tokens only when Write Memory is ON. rule-based is simpler and never consumes model
              tokens.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Definition
                label="Saved extractor"
                value={settings.data?.memory.memoryExtractor ?? "llm"}
              />
              <Definition
                label="Active extractor"
                value={`${settings.data?.memory.activeMemoryExtractor ?? "unknown"} / ${settings.data?.memory.memoryExtractorActive ?? "unknown"}`}
              />
              <Definition
                label="Reasoning configured"
                value={settings.data?.memory.reasoningProviderConfigured ? "yes" : "no"}
              />
              <Definition
                label="Fallback used"
                value={settings.data?.memory.memoryExtractorFallbackUsed ? "true" : "false"}
              />
            </div>
            {form.MEMORY_EXTRACTOR === "llm" &&
              settings.data?.memory.reasoningProviderConfigured === false && (
                <Notice
                  tone="info"
                  title="Reasoning provider not configured"
                  message="LLM extractor is selected, but DeepSeek Reasoning is not configured. YUVI will fall back to rule-based extraction without crashing normal chat."
                />
              )}
            {settings.data?.memory.memoryExtractorSkippedReason && (
              <Notice
                tone="info"
                title="Extractor note"
                message={settings.data.memory.memoryExtractorSkippedReason}
              />
            )}
            {(settings.data?.memory.memoryExtractorFallbackUsed ||
              (settings.data?.memory.memoryExtractorValidationIssues?.length ?? 0) > 0) && (
              <div className="mt-3 rounded-md border border-ink-100 bg-ink-50 p-3">
                <h4 className="text-sm font-semibold text-ink-800">Extractor diagnostics</h4>
                <div className="mt-2 grid grid-cols-2 gap-3">
                  {settings.data?.memory.memoryExtractorFailureStage && (
                    <Definition
                      label="Failure stage"
                      value={settings.data.memory.memoryExtractorFailureStage}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorFinishReason && (
                    <Definition
                      label="Finish reason"
                      value={settings.data.memory.memoryExtractorFinishReason}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorSelectedOutputSource && (
                    <Definition
                      label="Selected output"
                      value={settings.data.memory.memoryExtractorSelectedOutputSource}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorAnswerLength !== undefined && (
                    <Definition
                      label="Answer length"
                      value={String(settings.data.memory.memoryExtractorAnswerLength)}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorReasoningLength !== undefined && (
                    <Definition
                      label="Reasoning length"
                      value={String(settings.data.memory.memoryExtractorReasoningLength)}
                    />
                  )}
                  {settings.data?.memory.memoryExtractorLastAttemptAt && (
                    <Definition
                      label="Last attempt"
                      value={settings.data.memory.memoryExtractorLastAttemptAt}
                    />
                  )}
                </div>
                {settings.data?.memory.memoryExtractorValidationIssues &&
                  settings.data.memory.memoryExtractorValidationIssues.length > 0 && (
                    <p className="mt-2 text-sm leading-6 text-ink-600">
                      Validation issues:{" "}
                      {settings.data.memory.memoryExtractorValidationIssues.join("; ")}
                    </p>
                  )}
                {settings.data?.memory.memoryExtractorRawPreview && (
                  <p className="mt-2 break-all text-sm leading-6 text-ink-600">
                    Raw preview: {settings.data.memory.memoryExtractorRawPreview}
                  </p>
                )}
              </div>
            )}
          </div>
        </Panel>
      </div>
      <Panel title="Active Runtime" badge="activeRuntimeConfig">
        <p className="mb-3 text-sm leading-6 text-ink-600">
          These values describe the running Runtime, not the editor draft or saved / effective
          configuration.
        </p>
        <div className="grid grid-cols-5 gap-3">
          <Definition label="Chat Provider" value={activeChat?.provider ?? "unknown"} />
          <Definition label="Chat Model" value={activeChat?.model ?? "unknown"} />
          <Definition
            label="Chat Mode"
            value={activeChat ? (activeChat.mock ? "mock" : "real") : "unknown"}
          />
          <Definition
            label="Reasoning"
            value={
              activeReasoning
                ? `${activeReasoning.provider} / ${activeReasoning.mock ? "mock" : "real"}`
                : "unknown"
            }
          />
          <Definition
            label="Memory Repository"
            value={settings.data?.activeRuntimeConfig.memoryRepository ?? "unknown"}
          />
          <Definition
            label="Memory Extractor"
            value={`${settings.data?.activeRuntimeConfig.memoryExtractor ?? "unknown"} / ${settings.data?.activeRuntimeConfig.memoryExtractorActive ?? "unknown"}`}
          />
        </div>
      </Panel>
      <Panel title="Developer Tools / Deep Restart" badge="Development only">
        <div className="grid grid-cols-[1fr_1fr] gap-4">
          <div className="rounded-md border border-ink-100 bg-ink-50 p-3">
            <h3 className="mb-2 text-sm font-semibold text-ink-800">Save &amp; Apply / 保存并应用</h3>
            <ul className="space-y-1 text-sm leading-6 text-ink-600">
              <li>Save Only / 仅保存 updates saved / effective configuration only.</li>
              <li>Reloads supported runtime config in-process.</li>
              <li>Does not restart the server.</li>
              <li>Does not run migrations.</li>
            </ul>
          </div>
          <div className="rounded-md border border-ink-100 bg-ink-50 p-3">
            <h3 className="mb-2 text-sm font-semibold text-ink-800">Deep Restart</h3>
            <ul className="space-y-1 text-sm leading-6 text-ink-600">
              <li>Fully restarts the supervised local runtime.</li>
              <li>Reloads .env and .env.local.</li>
              <li>May run pnpm db:migrate when Postgres mode is active.</li>
              <li>Requires YUVI_DEV_SUPERVISOR=1.</li>
            </ul>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Definition label="Supervisor active" value={restartStatus?.active ? "true" : "false"} />
          <Definition label="Auto migrate" value={restartStatus?.autoMigrate ? "true" : "false"} />
          <Definition
            label="Restart supported"
            value={restartSupported === undefined ? "unknown" : restartSupported ? "true" : "false"}
          />
          <Definition label="Runtime env dir" value={restartStatus?.runtimeEnvDir ?? "unknown"} />
          <Definition
            label="Memory repository"
            value={settings.data?.memory.activeMemoryRepository ?? "unknown"}
          />
          <Definition
            label="Database configured"
            value={settings.data?.memory.databaseUrlConfigured ? "true" : "false"}
          />
        </div>
        <Notice
          tone="info"
          title="Deep Restart Runtime"
          message="Deep Restart reloads .env/.env.local, may run pnpm db:migrate, and restarts the local supervised runtime. Development only."
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            className="button-primary"
            type="button"
            disabled={deepRestartDisabled}
            onClick={() => void deepRestart()}
          >
            {restartBusy ? "Requesting Restart" : "Deep Restart Runtime"}
          </button>
          {restartSupported === false && (
            <span className="text-sm text-ink-500">
              Start with: YUVI_DEV_SUPERVISOR=1 ./scripts/dev.sh
            </span>
          )}
        </div>
      </Panel>
      <Panel title="Saved / Effective Configuration" badge="layered settings">
        <Notice
          tone="info"
          title="Saved / effective source"
          message=".env.local overrides .env. Dashboard writes to .env.local for safety and does not modify .env automatically. The effective column is the saved configuration source; it is separate from Active Runtime."
        />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Definition
            label="Base .env"
            value={
              settings.data?.configFiles[".env"].exists
                ? "exists / git ignored"
                : "missing / git ignored"
            }
          />
          <Definition
            label="Local override .env.local"
            value={
              settings.data?.configFiles[".env.local"].exists
                ? "exists / git ignored"
                : "missing / git ignored"
            }
          />
        </div>
        <div className="mt-4 max-h-[340px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-500">
              <tr>
                <th className="px-2 py-2">Key</th>
                <th className="px-2 py-2">Base .env</th>
                <th className="px-2 py-2">Local override .env.local</th>
                <th className="px-2 py-2">Effective value</th>
                <th className="px-2 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {configLayerKeys.map((key) => (
                <ConfigLayerRow key={key} name={key} setting={settings.data?.settings[key]} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Model Priority Chains" badge="Provider fallback">
        <div className="grid grid-cols-3 gap-3">
          <SettingsInput form={form} name="CHAT_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="REASONING_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="EMBEDDING_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="TTS_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="STT_PROVIDER_CHAIN" setForm={setForm} />
          <SettingsInput form={form} name="VISION_PROVIDER_CHAIN" setForm={setForm} />
        </div>
        <p className="mt-3 text-sm leading-6 text-ink-600">
          Provider chains are tried left to right. Mock is ignored unless PROVIDER_ALLOW_MOCKS=true.
          保存并应用会重新加载可热更新的 Runtime 配置；Deep Restart 会重启受监管的 Runtime。
        </p>
      </Panel>
      <Notice
        tone="info"
        title="Provider diagnostics"
        message="Local readiness is a configuration check, not proof that a provider is reachable. Cached observation comes only from an explicit live check. Chat, reasoning, and embedding controls below perform provider I/O and may be billable; TTS, STT, and Vision controls are config-only and make no provider call."
      />
      <div className="grid grid-cols-3 gap-4">
        <Panel
          title="DeepSeek"
          actions={
            <div className="flex gap-2">
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("chat")}
              >
                {verifying === "chat" ? "Live verifying Chat" : "Live verify Chat"}
              </button>
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("reasoning")}
              >
                {verifying === "reasoning" ? "Live verifying Reasoning" : "Live verify Reasoning"}
              </button>
            </div>
          }
        >
          <SettingsInput form={form} name="DEEPSEEK_API_BASEURL" setForm={setForm} />
          <SecretInput
            label="DEEPSEEK_API_KEY"
            configured={settings.data?.providers.deepseek.apiKeyConfigured}
            preview={settings.data?.providers.deepseek.apiKeyPreview}
            value={form.DEEPSEEK_API_KEY}
            onChange={(value) => setFormValue(setForm, "DEEPSEEK_API_KEY", value)}
            onClear={() => clearSecret(setForm, setClearedSecrets, "DEEPSEEK_API_KEY")}
          />
          <SettingsInput form={form} name="DEEPSEEK_CHAT_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="DEEPSEEK_REASONING_MODEL" setForm={setForm} />
          <ProviderDiagnosticsSummary
            label="Chat"
            health={settings.data?.activeRuntimeConfig.providers.chat}
          />
          <ProviderDiagnosticsSummary
            label="Reasoning"
            health={settings.data?.activeRuntimeConfig.providers.reasoning}
          />
        </Panel>
        <Panel title="xAI" badge="Optional · TTS and Vision implemented">
          <SettingsInput form={form} name="XAI_API_BASEURL" setForm={setForm} />
          <SecretInput
            label="XAI_API_KEY"
            configured={settings.data?.providers.xai.apiKeyConfigured}
            preview={settings.data?.providers.xai.apiKeyPreview}
            value={form.XAI_API_KEY}
            onChange={(value) => setFormValue(setForm, "XAI_API_KEY", value)}
            onClear={() => clearSecret(setForm, setClearedSecrets, "XAI_API_KEY")}
          />
          <SettingsInput form={form} name="XAI_TTS_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="XAI_TTS_VOICE" setForm={setForm} />
          <SettingsInput form={form} name="XAI_VISION_MODEL" setForm={setForm} />
          <ProviderDiagnosticsSummary
            label="TTS (optional)"
            health={settings.data?.activeRuntimeConfig.providers.tts}
          />
          <ProviderDiagnosticsSummary
            label="Vision (optional)"
            health={settings.data?.activeRuntimeConfig.providers.vision}
          />
        </Panel>
        <Panel title="NVIDIA API" badge="OpenAI-compatible v1">
          <SettingsInput form={form} name="NVIDIA_API_BASEURL" setForm={setForm} />
          <SecretInput
            label="NVIDIA_API_KEY"
            configured={secretSettingConfigured(settings.data, "NVIDIA_API_KEY")}
            preview={secretSettingPreview(settings.data, "NVIDIA_API_KEY")}
            value={form.NVIDIA_API_KEY}
            onChange={(value) => setFormValue(setForm, "NVIDIA_API_KEY", value)}
            onClear={() => clearSecret(setForm, setClearedSecrets, "NVIDIA_API_KEY")}
          />
          <SettingsInput form={form} name="NVIDIA_CHAT_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="NVIDIA_REASONING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="NVIDIA_EMBEDDING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="NVIDIA_EMBEDDING_DIMENSIONS" setForm={setForm} />
          <SettingsInput form={form} name="NVIDIA_VISION_MODEL" setForm={setForm} />
        </Panel>
        <Panel title="Local Models" badge="OpenAI-compatible">
          <SettingsInput form={form} name="LOCAL_MODEL_BASEURL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_CHAT_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_REASONING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_EMBEDDING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_EMBEDDING_DIMENSIONS" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_TTS_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_STT_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="LOCAL_VISION_MODEL" setForm={setForm} />
        </Panel>
        <Panel
          title="DashScope / Embedding"
          badge="DashScope STT optional · implemented"
          actions={
            <div className="flex flex-wrap gap-2">
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("embedding")}
              >
                {verifying === "embedding" ? "Live verifying Embedding" : "Live verify Embedding"}
              </button>
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("stt")}
              >
                {verifying === "stt" ? "Inspecting STT config" : "Inspect STT config"}
              </button>
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("tts")}
              >
                {verifying === "tts" ? "Inspecting TTS config" : "Inspect TTS config"}
              </button>
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("vision")}
              >
                {verifying === "vision" ? "Inspecting Vision config" : "Inspect Vision config"}
              </button>
            </div>
          }
        >
          <SettingsInput form={form} name="DASHSCOPE_API_BASEURL" setForm={setForm} />
          <SecretInput
            label="DASHSCOPE_API_KEY"
            configured={settings.data?.providers.dashscope.apiKeyConfigured}
            preview={settings.data?.providers.dashscope.apiKeyPreview}
            value={form.DASHSCOPE_API_KEY}
            onChange={(value) => setFormValue(setForm, "DASHSCOPE_API_KEY", value)}
            onClear={() => clearSecret(setForm, setClearedSecrets, "DASHSCOPE_API_KEY")}
          />
          <SettingsInput form={form} name="DASHSCOPE_STT_MODEL" setForm={setForm} />
          <ProviderDiagnosticsSummary
            label="STT (optional)"
            health={settings.data?.activeRuntimeConfig.providers.stt}
          />
          <SettingsInput form={form} name="EMBEDDING_PROVIDER" setForm={setForm} />
          <div className="rounded-md border border-ink-100 bg-ink-50 p-2 text-xs text-ink-600">
            Local readiness:{" "}
            {providerReadinessLabel(settings.data?.providers.embedding.status?.readiness)} · Cached
            observation:{" "}
            {providerObservationLabel(settings.data?.providers.embedding.status?.observed)} · mode:{" "}
            {settings.data?.providers.embedding.status?.mode ?? "unknown"} · mock:{" "}
            {String(settings.data?.providers.embedding.status?.mock ?? false)} · dimensions:{" "}
            {settings.data?.providers.embedding.status?.dimensions ??
              (settings.data?.providers.embedding.dimensions || "unknown")}
            {" · semantic: "}
            {String(settings.data?.providers.embedding.status?.semanticEmbedding ?? false)}
            {settings.data?.providers.embedding.status?.semanticEmbedding === false && (
              <div className="mt-1 text-amber-700">
                {settings.data.providers.embedding.status.embeddingNote ??
                  "Mock embeddings validate the pipeline but do not provide real semantic similarity."}
              </div>
            )}
            {settings.data?.providers.embedding.status?.missingFields?.length ? (
              <div className="mt-1 text-rose-700">
                Missing: {settings.data.providers.embedding.status.missingFields.join(", ")}
              </div>
            ) : null}
            {embeddingSettingsHint(settings.data?.providers.embedding.status)}
          </div>
          <SettingsInput form={form} name="EMBEDDING_API_BASEURL" setForm={setForm} />
          <SettingsInput form={form} name="EMBEDDING_MODEL" setForm={setForm} />
          <SettingsInput form={form} name="EMBEDDING_DIMENSIONS" setForm={setForm} />
          <SecretInput
            label="EMBEDDING_API_KEY"
            configured={settings.data?.providers.embedding.apiKeyConfigured}
            preview={settings.data?.providers.embedding.apiKeyPreview}
            value={form.EMBEDDING_API_KEY}
            onChange={(value) => setFormValue(setForm, "EMBEDDING_API_KEY", value)}
            onClear={() => clearSecret(setForm, setClearedSecrets, "EMBEDDING_API_KEY")}
          />
        </Panel>
      </div>
      {verification && <ProviderVerificationResult result={verification} />}
      <div className="flex justify-end gap-3">
        <button
          className="button-secondary"
          disabled={operationBusy}
          onClick={() => void reloadCurrentConfig()}
        >
          {applying ? "正在重新载入" : "重新载入当前配置"}
        </button>
        <button
          className="button-secondary"
          disabled={operationBusy || !draftDirty}
          onClick={() => {
            if (loadedForm) {
              setForm(loadedForm);
              setClearedSecrets(new Set());
              setSettingsState("clean");
            }
          }}
        >
          重置草稿
        </button>
        <button
          className="button-secondary"
          disabled={operationBusy}
          onClick={() => void saveOnly()}
        >
          {saving ? "正在保存" : "仅保存"}
        </button>
        <button
          className="button-primary"
          disabled={operationBusy}
          onClick={() => void saveAndApply()}
        >
          {saving ? "正在保存" : applying ? "正在应用" : "保存并应用"}
        </button>
      </div>
    </PageShell>
  );
}

type SettingsForm = Record<SettingsKey, string>;

type SettingsKey =
  | "SERVER_HOST"
  | "SERVER_PORT"
  | "EVENT_BUS"
  | "PROVIDER_ALLOW_MOCKS"
  | "MEMORY_REPOSITORY"
  | "DATABASE_URL"
  | "MEMORY_EXTRACTOR"
  | "CHAT_PROVIDER_CHAIN"
  | "REASONING_PROVIDER_CHAIN"
  | "EMBEDDING_PROVIDER_CHAIN"
  | "TTS_PROVIDER_CHAIN"
  | "STT_PROVIDER_CHAIN"
  | "VISION_PROVIDER_CHAIN"
  | "DEEPSEEK_API_BASEURL"
  | "DEEPSEEK_API_KEY"
  | "DEEPSEEK_CHAT_MODEL"
  | "DEEPSEEK_REASONING_MODEL"
  | "NVIDIA_API_BASEURL"
  | "NVIDIA_API_KEY"
  | "NVIDIA_CHAT_MODEL"
  | "NVIDIA_REASONING_MODEL"
  | "NVIDIA_EMBEDDING_MODEL"
  | "NVIDIA_EMBEDDING_DIMENSIONS"
  | "NVIDIA_VISION_MODEL"
  | "LOCAL_MODEL_BASEURL"
  | "LOCAL_CHAT_MODEL"
  | "LOCAL_REASONING_MODEL"
  | "LOCAL_EMBEDDING_MODEL"
  | "LOCAL_EMBEDDING_DIMENSIONS"
  | "LOCAL_TTS_MODEL"
  | "LOCAL_STT_MODEL"
  | "LOCAL_VISION_MODEL"
  | "XAI_API_BASEURL"
  | "XAI_API_KEY"
  | "XAI_TTS_MODEL"
  | "XAI_TTS_VOICE"
  | "XAI_VISION_MODEL"
  | "DASHSCOPE_API_BASEURL"
  | "DASHSCOPE_API_KEY"
  | "DASHSCOPE_STT_MODEL"
  | "EMBEDDING_PROVIDER"
  | "EMBEDDING_API_BASEURL"
  | "EMBEDDING_API_KEY"
  | "EMBEDDING_MODEL"
  | "EMBEDDING_DIMENSIONS";

const settingsSecretKeys: SettingsKey[] = [
  "DATABASE_URL",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "XAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "EMBEDDING_API_KEY"
];

function emptySettingsForm(): SettingsForm {
  return {
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: "6121",
    EVENT_BUS: "in-memory",
    PROVIDER_ALLOW_MOCKS: "false",
    MEMORY_REPOSITORY: "in-memory",
    DATABASE_URL: "",
    MEMORY_EXTRACTOR: "llm",
    CHAT_PROVIDER_CHAIN: "deepseek,nvidia,local,mock",
    REASONING_PROVIDER_CHAIN: "deepseek,nvidia,local,mock",
    EMBEDDING_PROVIDER_CHAIN: "openai-compatible,nvidia,local,mock",
    TTS_PROVIDER_CHAIN: "xai,local,mock",
    STT_PROVIDER_CHAIN: "dashscope,local,mock",
    VISION_PROVIDER_CHAIN: "xai,nvidia,local,mock",
    DEEPSEEK_API_BASEURL: "",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_CHAT_MODEL: "",
    DEEPSEEK_REASONING_MODEL: "",
    NVIDIA_API_BASEURL: "https://integrate.api.nvidia.com/v1",
    NVIDIA_API_KEY: "",
    NVIDIA_CHAT_MODEL: "",
    NVIDIA_REASONING_MODEL: "",
    NVIDIA_EMBEDDING_MODEL: "",
    NVIDIA_EMBEDDING_DIMENSIONS: "1536",
    NVIDIA_VISION_MODEL: "",
    LOCAL_MODEL_BASEURL: "",
    LOCAL_CHAT_MODEL: "",
    LOCAL_REASONING_MODEL: "",
    LOCAL_EMBEDDING_MODEL: "",
    LOCAL_EMBEDDING_DIMENSIONS: "1536",
    LOCAL_TTS_MODEL: "",
    LOCAL_STT_MODEL: "",
    LOCAL_VISION_MODEL: "",
    XAI_API_BASEURL: "",
    XAI_API_KEY: "",
    XAI_TTS_MODEL: "",
    XAI_TTS_VOICE: "",
    XAI_VISION_MODEL: "",
    DASHSCOPE_API_BASEURL: "",
    DASHSCOPE_API_KEY: "",
    DASHSCOPE_STT_MODEL: "",
    EMBEDDING_PROVIDER: "openai-compatible",
    EMBEDDING_API_BASEURL: "",
    EMBEDDING_API_KEY: "",
    EMBEDDING_MODEL: "",
    EMBEDDING_DIMENSIONS: "1536"
  };
}

function settingsFormFromResponse(settings: RuntimeSettingsResponse): SettingsForm {
  return {
    SERVER_HOST: settings.runtime.serverHost,
    SERVER_PORT: String(settings.runtime.serverPort),
    EVENT_BUS: settings.runtime.eventBus,
    PROVIDER_ALLOW_MOCKS: settings.runtime.providerAllowMocks ? "true" : "false",
    MEMORY_REPOSITORY: settings.memory.memoryRepository,
    DATABASE_URL: "",
    MEMORY_EXTRACTOR: settings.memory.memoryExtractor ?? "llm",
    CHAT_PROVIDER_CHAIN: runtimeSetting(settings, "CHAT_PROVIDER_CHAIN"),
    REASONING_PROVIDER_CHAIN: runtimeSetting(settings, "REASONING_PROVIDER_CHAIN"),
    EMBEDDING_PROVIDER_CHAIN: runtimeSetting(settings, "EMBEDDING_PROVIDER_CHAIN"),
    TTS_PROVIDER_CHAIN: runtimeSetting(settings, "TTS_PROVIDER_CHAIN"),
    STT_PROVIDER_CHAIN: runtimeSetting(settings, "STT_PROVIDER_CHAIN"),
    VISION_PROVIDER_CHAIN: runtimeSetting(settings, "VISION_PROVIDER_CHAIN"),
    DEEPSEEK_API_BASEURL: settings.providers.deepseek.baseUrl,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_CHAT_MODEL: settings.providers.deepseek.chatModel,
    DEEPSEEK_REASONING_MODEL: settings.providers.deepseek.reasoningModel,
    NVIDIA_API_BASEURL: runtimeSetting(settings, "NVIDIA_API_BASEURL"),
    NVIDIA_API_KEY: "",
    NVIDIA_CHAT_MODEL: runtimeSetting(settings, "NVIDIA_CHAT_MODEL"),
    NVIDIA_REASONING_MODEL: runtimeSetting(settings, "NVIDIA_REASONING_MODEL"),
    NVIDIA_EMBEDDING_MODEL: runtimeSetting(settings, "NVIDIA_EMBEDDING_MODEL"),
    NVIDIA_EMBEDDING_DIMENSIONS: runtimeSetting(settings, "NVIDIA_EMBEDDING_DIMENSIONS"),
    NVIDIA_VISION_MODEL: runtimeSetting(settings, "NVIDIA_VISION_MODEL"),
    LOCAL_MODEL_BASEURL: runtimeSetting(settings, "LOCAL_MODEL_BASEURL"),
    LOCAL_CHAT_MODEL: runtimeSetting(settings, "LOCAL_CHAT_MODEL"),
    LOCAL_REASONING_MODEL: runtimeSetting(settings, "LOCAL_REASONING_MODEL"),
    LOCAL_EMBEDDING_MODEL: runtimeSetting(settings, "LOCAL_EMBEDDING_MODEL"),
    LOCAL_EMBEDDING_DIMENSIONS: runtimeSetting(settings, "LOCAL_EMBEDDING_DIMENSIONS"),
    LOCAL_TTS_MODEL: runtimeSetting(settings, "LOCAL_TTS_MODEL"),
    LOCAL_STT_MODEL: runtimeSetting(settings, "LOCAL_STT_MODEL"),
    LOCAL_VISION_MODEL: runtimeSetting(settings, "LOCAL_VISION_MODEL"),
    XAI_API_BASEURL: settings.providers.xai.baseUrl,
    XAI_API_KEY: "",
    XAI_TTS_MODEL: settings.providers.xai.ttsModel,
    XAI_TTS_VOICE: settings.providers.xai.ttsVoice,
    XAI_VISION_MODEL: settings.providers.xai.visionModel,
    DASHSCOPE_API_BASEURL: settings.providers.dashscope.baseUrl,
    DASHSCOPE_API_KEY: "",
    DASHSCOPE_STT_MODEL: settings.providers.dashscope.sttModel,
    EMBEDDING_PROVIDER: settings.providers.embedding.provider,
    EMBEDDING_API_BASEURL: settings.providers.embedding.baseUrl,
    EMBEDDING_API_KEY: "",
    EMBEDDING_MODEL: settings.providers.embedding.model,
    EMBEDDING_DIMENSIONS: settings.providers.embedding.dimensions
  };
}

function runtimeSetting(settings: RuntimeSettingsResponse, key: string): string {
  const setting = settings.settings[key];
  const value = setting && "effective" in setting ? setting.effective : "";
  return typeof value === "string" ? value : "";
}

function secretSettingConfigured(
  settings: RuntimeSettingsResponse | null | undefined,
  key: string
): boolean {
  const setting = settings?.settings[key];
  return Boolean(setting && "effectiveConfigured" in setting && setting.effectiveConfigured);
}

function secretSettingPreview(
  settings: RuntimeSettingsResponse | null | undefined,
  key: string
): string | undefined {
  const setting = settings?.settings[key];
  return setting && "maskedValue" in setting ? setting.maskedValue : undefined;
}

function setFormValue(
  setForm: Dispatch<SetStateAction<SettingsForm>>,
  key: SettingsKey,
  value: string
): void {
  setForm((current) => ({ ...current, [key]: value }));
}

function clearSecret(
  setForm: Dispatch<SetStateAction<SettingsForm>>,
  setClearedSecrets: Dispatch<SetStateAction<Set<SettingsKey>>>,
  key: SettingsKey
): void {
  setFormValue(setForm, key, "");
  setClearedSecrets((current) => new Set([...current, key]));
}

function buildSettingsUpdate(
  form: SettingsForm,
  clearedSecrets: Set<SettingsKey>
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(form) as Array<[SettingsKey, string]>) {
    if (isSecretSettingsKey(key) && value === "" && !clearedSecrets.has(key)) {
      continue;
    }
    values[key] = value;
  }
  return values;
}

function isSecretSettingsKey(key: SettingsKey): boolean {
  return (
    key === "DEEPSEEK_API_KEY" ||
    key === "DATABASE_URL" ||
    key === "NVIDIA_API_KEY" ||
    key === "XAI_API_KEY" ||
    key === "DASHSCOPE_API_KEY" ||
    key === "EMBEDDING_API_KEY"
  );
}

function SettingsInput(props: {
  form: SettingsForm;
  name: SettingsKey;
  setForm: Dispatch<SetStateAction<SettingsForm>>;
}): JSX.Element {
  return (
    <Field label={props.name}>
      <input
        className="field"
        value={props.form[props.name]}
        onChange={(event) => setFormValue(props.setForm, props.name, event.target.value)}
      />
    </Field>
  );
}

function SecretInput(props: {
  label: SettingsKey;
  configured: boolean | undefined;
  preview: string | undefined;
  value: string;
  onChange(value: string): void;
  onClear(): void;
}): JSX.Element {
  return (
    <Field label={props.label}>
      <div className="space-y-2">
        <div className="rounded-md border border-ink-100 bg-ink-50 px-3 py-2 text-xs text-ink-600">
          {props.configured ? (
            <span>
              Configured:{" "}
              <span className="font-mono text-ink-800">{props.preview ?? "••••••••••••"}</span>
            </span>
          ) : (
            "Not configured / 未配置"
          )}
        </div>
        <input
          className="field"
          type="password"
          placeholder={props.configured ? "Enter a new value to replace saved key" : "Enter key"}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
        {props.configured && (
          <button className="button-secondary w-full" type="button" onClick={props.onClear}>
            Clear saved key on next save
          </button>
        )}
      </div>
    </Field>
  );
}

function ConfigLayerRow(props: { name: string; setting: LayeredSetting | undefined }): JSX.Element {
  const setting = props.setting;
  const isSecret = Boolean(setting && "effectiveConfigured" in setting);

  return (
    <tr className="border-t border-ink-100">
      <td className="px-2 py-2 font-mono text-ink-700">{props.name}</td>
      <td className="px-2 py-2">{setting ? formatLayerValue(setting, "base") : "unknown"}</td>
      <td className="px-2 py-2">
        {setting ? formatLayerValue(setting, "localOverride") : "unknown"}
      </td>
      <td className="px-2 py-2 font-medium text-ink-700">
        {setting ? formatLayerValue(setting, "effective") : "unknown"}
      </td>
      <td className="px-2 py-2">
        <span
          className={`rounded-full px-2 py-0.5 ${
            setting?.source === ".env.local"
              ? "bg-cyan-50 text-cyan-700"
              : "bg-ink-100 text-ink-600"
          }`}
        >
          {isSecret
            ? `${setting?.source ?? "unknown"} / secret masked`
            : (setting?.source ?? "unknown")}
        </span>
      </td>
    </tr>
  );
}

function formatLayerValue(
  setting: LayeredSetting,
  layer: "base" | "localOverride" | "effective"
): string {
  if ("effectiveConfigured" in setting) {
    const configured =
      layer === "base"
        ? setting.baseConfigured
        : layer === "localOverride"
          ? setting.localOverrideConfigured
          : setting.effectiveConfigured;
    if (!configured) {
      return "Not configured";
    }
    return layer === "effective" ? (setting.maskedValue ?? "Configured") : "Configured";
  }

  const value =
    layer === "base"
      ? setting.base
      : layer === "localOverride"
        ? setting.localOverride
        : setting.effective;
  return value || "Not set";
}

function PageShell(props: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-normal">{props.title}</h2>
        <p className="mt-1 text-sm text-ink-500">{props.subtitle}</p>
      </div>
      {props.children}
    </section>
  );
}

function Panel(props: {
  title: string;
  children: React.ReactNode;
  badge?: string;
  actions?: React.ReactNode;
}): JSX.Element {
  return (
    <section className="panel">
      <div className="flex min-h-12 items-center justify-between border-b border-ink-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{props.title}</h3>
          {props.badge && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
              {props.badge}
            </span>
          )}
        </div>
        {props.actions}
      </div>
      <div className="p-4">{props.children}</div>
    </section>
  );
}

function StatusCard(props: {
  title: string;
  status: string;
  detail: string;
  mock?: boolean;
}): JSX.Element {
  return (
    <div className="panel p-4">
      <div className="label">{props.title}</div>
      <div className="mt-3 flex items-center gap-2">
        <StatusDot status={props.status} />
        <div className="text-lg font-semibold">{props.status}</div>
      </div>
      <div className="mt-2 text-sm text-ink-500">{props.detail}</div>
      {props.mock && <div className="mt-3 text-xs font-medium text-amber-700">Mock mode</div>}
    </div>
  );
}

function StatusDot(props: { status: string }): JSX.Element {
  const color =
    props.status === "healthy"
      ? "bg-emerald-500"
      : props.status === "loading"
        ? "bg-cyan-500"
        : props.status === "error" || props.status === "unavailable"
          ? "bg-rose-500"
          : "bg-amber-500";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function Pill(props: { status: string }): JSX.Element {
  return (
    <span className="inline-flex rounded-full bg-ink-100 px-2 py-1 text-xs font-semibold text-ink-700">
      {props.status}
    </span>
  );
}

function Notice(props: { tone: "info" | "error"; title: string; message: string }): JSX.Element {
  const styles =
    props.tone === "error"
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : "border-cyan-200 bg-cyan-50 text-cyan-800";
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${styles}`}>
      <strong>{props.title}:</strong> {props.message}
    </div>
  );
}

function ProviderMetadataSummary(props: {
  provider?: ProviderCallMetadata | string | undefined;
}): JSX.Element {
  const provider = props.provider;
  if (!provider) {
    return <></>;
  }

  if (typeof provider === "string") {
    return <div className="mt-2 text-xs text-ink-500">provider: {provider}</div>;
  }

  return (
    <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink-500">
      <span
        className={`rounded-full px-2 py-0.5 font-semibold ${
          provider.mock ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
        }`}
      >
        {provider.mock ? "MOCK MODE" : `REAL PROVIDER / ${provider.name}`}
      </span>
      {provider.name && <span>provider: {provider.name}</span>}
      {provider.model && <span>model: {provider.model}</span>}
      {provider.latencyMs !== undefined && (
        <span>latency: {formatLatency(provider.latencyMs)}</span>
      )}
      {provider.healthStatus && <span>health: {provider.healthStatus}</span>}
      {provider.tokenUsage && <span>tokens: {formatTokenUsage(provider.tokenUsage)}</span>}
      {provider.mock && (
        <span className="basis-full text-amber-700">
          Use Settings → Apply Now after saving a DeepSeek API key, or restart the server.
        </span>
      )}
    </div>
  );
}

function formatIncludedScopes(scopes: Array<{ scope: string; scopeId?: string | null }>): string {
  if (scopes.length === 0) {
    return "none";
  }

  return scopes
    .map((entry) => `${entry.scope}${entry.scopeId ? `:${entry.scopeId}` : ""}`)
    .join(", ");
}

function formatRankComponents(rank: NonNullable<RetrievedMemoryDebug["rankComponents"]>): string {
  return Object.entries(rank)
    .filter(([, value]) => typeof value === "number" && value > 0)
    .map(([key, value]) => `${key.replace(/Score$/, "")}:${Number(value).toFixed(1)}`)
    .join(" · ");
}

function ProviderVerificationResult(props: { result: ProviderVerificationResponse }): JSX.Element {
  const result = props.result;
  return (
    <div className="grid grid-cols-6 gap-3 rounded-md border border-ink-100 bg-ink-50 p-3 text-sm">
      <div className="col-span-6 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs text-ink-700">
        <div className="font-semibold">{verificationModeLabel(result)}</div>
        <div className="mt-1 text-ink-600">{verificationModeExplanation(result)}</div>
      </div>
      <Definition label="Result" value={verificationOutcomeLabel(result)} />
      <Definition label="Capability" value={result.capability} />
      <Definition label="Provider" value={result.provider} />
      <Definition label="Mode" value={result.mock ? "mock" : "real"} />
      <Definition label="Model" value={result.model ?? "unknown"} />
      <Definition label="Latency" value={formatLatency(result.latencyMs)} />
      <Definition label="Local readiness" value={providerReadinessLabel(result.readiness)} />
      <Definition label="Cached observation" value={providerObservationLabel(result.observed)} />
      <div className="col-span-4">
        <Definition label="Cached observation metadata" value={cachedObservationDetail(result)} />
      </div>
      {result.capability === "embedding" && (
        <>
          <Definition
            label="Expected Dims"
            value={String(
              result.expectedDimensions ??
                result.configuredDimensions ??
                result.dimensions ??
                "unknown"
            )}
          />
          <Definition
            label="Actual Dims"
            value={String(result.actualDimensions ?? result.dimensions ?? "unknown")}
          />
          <Definition label="Semantic" value={String(result.semanticEmbedding ?? false)} />
          {result.mock && (
            <div className="col-span-6 text-amber-700">
              Mock embeddings validate the pipeline but do not provide real semantic similarity.
            </div>
          )}
          {result.expectedDimensions &&
            result.actualDimensions &&
            result.expectedDimensions !== result.actualDimensions && (
              <div className="col-span-6 text-rose-700">
                Provider returned {result.actualDimensions} dimensions while YUVI expected{" "}
                {result.expectedDimensions}. Check EMBEDDING_DIMENSIONS and model/provider
                compatibility.
              </div>
            )}
        </>
      )}
      {result.tokenUsage && (
        <div className="col-span-3">
          <Definition label="Token Usage" value={formatTokenUsage(result.tokenUsage)} />
        </div>
      )}
      {result.message && (
        <div className="col-span-6 text-ink-600">
          <span className="font-semibold">Inspection note:</span> {result.message}
        </div>
      )}
      {result.errorCode && (
        <div className="col-span-6 text-rose-700">
          <span className="font-semibold">Error code:</span> {result.errorCode}
        </div>
      )}
      {result.error && (
        <div className="col-span-6 text-rose-700">
          <span className="font-semibold">Error:</span> {result.error}
        </div>
      )}
    </div>
  );
}

function ProviderDiagnosticsSummary(props: {
  label: string;
  health: ProviderHealth | undefined;
}): JSX.Element {
  return (
    <div className="mt-3 rounded-md border border-ink-100 bg-ink-50 p-2 text-xs text-ink-600">
      <div className="font-semibold text-ink-800">{props.label}</div>
      <div className="mt-1">Local readiness: {providerReadinessLabel(props.health?.readiness)}</div>
      <div className="mt-1">Cached observation: {cachedObservationDetail(props.health ?? {})}</div>
    </div>
  );
}

function EmptyState(props: { title: string; message: string }): JSX.Element {
  return (
    <div className="rounded-md border border-dashed border-ink-200 bg-ink-50 px-4 py-8 text-center">
      <div className="font-semibold">{props.title}</div>
      <div className="mt-1 text-sm text-ink-500">{props.message}</div>
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="label">{props.label}</span>
      {props.children}
    </label>
  );
}

function Toggle(props: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
  note: string;
}): JSX.Element {
  return (
    <label className="flex items-start gap-3 rounded-md border border-ink-100 p-3">
      <input
        className="mt-1 h-4 w-4"
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm font-semibold">{props.label}</span>
        <span className="block text-xs leading-5 text-ink-500">{props.note}</span>
      </span>
    </label>
  );
}

function Definition(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="mb-3">
      <div className="label">{props.label}</div>
      <div className="mt-1 font-mono text-sm text-ink-700">{props.value}</div>
    </div>
  );
}

function memoryModeFromHealth(health: HealthResponse | null): string {
  const message = health?.database.message?.toLowerCase() ?? "";
  if (message.includes("in-memory")) {
    return "in-memory";
  }
  if (health?.database.status === "healthy" && !message.includes("in-memory")) {
    return "postgres";
  }
  return "unknown";
}

function memoryHealthEntries(
  health: MemoryHealthSummary | undefined
): Array<{ label: string; value: number }> {
  return [
    { label: "active", value: health?.active ?? 0 },
    { label: "expired", value: health?.expired ?? 0 },
    { label: "archived", value: health?.archived ?? 0 },
    { label: "superseded", value: health?.superseded ?? 0 },
    { label: "forgotten", value: health?.forgotten ?? 0 },
    { label: "stale", value: health?.staleEpisodic ?? 0 },
    { label: "missing emb", value: health?.missingEmbedding ?? 0 },
    { label: "scanned", value: health?.scanned ?? 0 }
  ];
}

function memoryMaintenanceStatusEntries(
  status: MemoryMaintenanceSchedulerStatus | null | undefined
): Array<{ label: string; value: string }> {
  return [
    { label: "scheduler", value: status?.enabled ? "enabled" : "disabled" },
    { label: "startup", value: status?.runOnStartup ? "enabled" : "disabled" },
    { label: "interval", value: status ? `${status.intervalMinutes} min` : "0 min" },
    { label: "limit", value: String(status?.limit ?? 0) },
    { label: "running", value: status?.running ? "yes" : "no" },
    { label: "last run", value: formatDate(status?.lastRunAt ?? "") },
    { label: "next run", value: formatDate(status?.nextRunAt ?? "") },
    {
      label: "last summary",
      value: status?.lastSummary
        ? `expired=${status.lastSummary.expired} stale=${status.lastSummary.stale} failed=${status.lastSummary.failed}`
        : status?.lastError
          ? `error=${status.lastError}`
          : "none"
    }
  ];
}

function vectorIndexEntries(
  status: MemoryVectorIndexStatus | undefined
): Array<{ label: string; value: string }> {
  return [
    { label: "ANN", value: status?.annAccelerationActive ? "active" : "inactive" },
    { label: "enabled", value: status?.vectorIndexEnabled ? "true" : "false" },
    { label: "type", value: status?.vectorIndexType ?? "unknown" },
    { label: "distance", value: status?.vectorDistance ?? "cosine" },
    { label: "dimensions", value: String(status?.embeddingDimensions ?? "unknown") },
    { label: "embedded", value: String(status?.embeddedCount ?? 0) },
    { label: "missing", value: String(status?.missingEmbeddingCount ?? 0) },
    { label: "created", value: status?.indexCreated ? "yes" : "no" }
  ];
}

function memoryModeDetail(mode: string): string {
  if (mode === "in-memory") {
    return "Temporary storage; resets when the server restarts.";
  }
  if (mode === "postgres") {
    return "Persistent development storage after migrations are applied.";
  }
  return "Mode is inferred from /health and may need a server response update.";
}

function optionalProviderReadinessSummary(status: ProvidersStatusResponse | null): string {
  if (!status) {
    return "unknown";
  }
  const optional = [status.providers.tts, status.providers.stt, status.providers.vision];
  const ready = optional.filter((provider) => provider.readiness === "ready").length;
  return `${ready}/${optional.length} locally ready`;
}

function optionalProviderObservationSummary(status: ProvidersStatusResponse | null): string {
  if (!status) {
    return "No provider diagnostics loaded";
  }
  return [
    `TTS: ${providerObservationLabel(status.providers.tts.observed)}`,
    `STT: ${providerObservationLabel(status.providers.stt.observed)}`,
    `Vision: ${providerObservationLabel(status.providers.vision.observed)}`
  ].join(" · ");
}

function providerRequirementLabel(
  capability: ProviderCapability,
  health: ProviderHealth | undefined
): string {
  if (!health) {
    return "Loading";
  }
  if (health.required) {
    return "Required";
  }
  if (capability === "embedding") {
    return "Optional until vector memory is enabled";
  }
  return "Optional";
}

function embeddingSettingsHint(
  health: ProvidersStatusResponse["providers"]["embedding"] | undefined
): JSX.Element | null {
  if (!health) {
    return null;
  }
  if (health.mock) {
    return (
      <div className="mt-1 text-amber-700">
        Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity.
      </div>
    );
  }
  if (health.readiness === "not_ready") {
    return (
      <div className="mt-1 text-rose-700">
        OpenAI-compatible embedding provider is selected but not configured or unavailable. Fill
        EMBEDDING_API_BASEURL, EMBEDDING_API_KEY, EMBEDDING_MODEL, and EMBEDDING_DIMENSIONS, then
        Save and Apply Now.
      </div>
    );
  }
  if (health.configured && health.semanticEmbedding) {
    return (
      <div className="mt-1 text-emerald-700">
        Real embedding provider is locally configured. Run Live verify Embedding to record remote
        reachability, then run pnpm memory:embed:backfill for existing memories.
      </div>
    );
  }
  return null;
}

type MemoryForm = {
  type: string;
  subtype: string;
  scope: string;
  scopeId: string;
  memoryLayer: string;
  status: string;
  content: string;
  summary: string;
  importance: string;
  emotionValence: string;
  emotionArousal: string;
  source: string;
  tags: string;
  observedAt: string;
  eventTime: string;
  validFrom: string;
  validUntil: string;
  expiresAt: string;
};

function emptyMemoryForm(): MemoryForm {
  return {
    type: "semantic",
    subtype: "",
    scope: "user",
    scopeId: "",
    memoryLayer: "core",
    status: "active",
    content: "",
    summary: "",
    importance: "0.5",
    emotionValence: "0",
    emotionArousal: "0",
    source: "dashboard",
    tags: "",
    observedAt: "",
    eventTime: "",
    validFrom: "",
    validUntil: "",
    expiresAt: ""
  };
}

function memoryFormFromRecord(memory: MemoryRecord): MemoryForm {
  return {
    type: memory.type,
    subtype: memory.subtype ?? "",
    scope: memory.scope ?? "user",
    scopeId: memory.scopeId ?? "",
    memoryLayer: memory.memoryLayer ?? "core",
    status: memory.status ?? "active",
    content: memory.content,
    summary: memory.summary ?? "",
    importance: String(memory.importance),
    emotionValence: String(memory.emotionValence ?? 0),
    emotionArousal: String(memory.emotionArousal ?? 0),
    source: memory.source,
    tags: memory.tags.join(", "),
    observedAt: toDateTimeLocalValue(memory.observedAt),
    eventTime: toDateTimeLocalValue(memory.eventTime),
    validFrom: toDateTimeLocalValue(memory.validFrom),
    validUntil: toDateTimeLocalValue(memory.validUntil),
    expiresAt: toDateTimeLocalValue(memory.expiresAt)
  };
}

function toCreateMemoryRequest(form: MemoryForm): CreateMemoryRequest {
  const input: CreateMemoryRequest = {
    type: form.type,
    subtype: form.subtype.trim() ? form.subtype.trim() : null,
    scope: form.scope,
    scopeId: form.scopeId.trim() ? form.scopeId.trim() : null,
    memoryLayer: form.memoryLayer,
    status: form.status,
    content: form.content.trim(),
    importance: parseImportance(form.importance) ?? 0.5,
    source: form.source.trim() || "dashboard",
    tags: parseTags(form.tags)
  };
  const summary = form.summary.trim();
  if (summary) {
    input.summary = summary;
  }
  assignMemoryFormDates(input, form);
  return input;
}

function toUpdateMemoryRequest(form: MemoryForm): UpdateMemoryRequest {
  const input: UpdateMemoryRequest = {
    type: form.type,
    subtype: form.subtype.trim() ? form.subtype.trim() : null,
    scope: form.scope,
    scopeId: form.scopeId.trim() ? form.scopeId.trim() : null,
    memoryLayer: form.memoryLayer,
    status: form.status,
    content: form.content.trim(),
    summary: form.summary.trim() || null,
    importance: parseImportance(form.importance) ?? 0.5,
    emotionValence: parseEmotionValue(form.emotionValence),
    emotionArousal: parseImportance(form.emotionArousal) ?? 0,
    tags: parseTags(form.tags)
  };
  assignMemoryFormDates(input, form);
  return input;
}

function toAcceptCandidateRequest(form: MemoryForm): AcceptMemoryCandidateRequest {
  const input: AcceptMemoryCandidateRequest = {
    type: form.type,
    subtype: form.subtype.trim() ? form.subtype.trim() : null,
    scope: form.scope,
    scopeId: form.scopeId.trim() ? form.scopeId.trim() : null,
    memoryLayer: form.memoryLayer,
    content: form.content.trim(),
    summary: form.summary.trim() || null,
    importance: parseImportance(form.importance) ?? 0.5,
    tags: parseTags(form.tags)
  };
  assignMemoryFormDates(input, form);
  return input;
}

function assignMemoryFormDates(
  input: CreateMemoryRequest | UpdateMemoryRequest | AcceptMemoryCandidateRequest,
  form: MemoryForm
): void {
  if (form.observedAt) input.observedAt = fromDateTimeLocalValue(form.observedAt);
  if (form.eventTime) input.eventTime = fromDateTimeLocalValue(form.eventTime);
  if (form.validFrom) input.validFrom = fromDateTimeLocalValue(form.validFrom);
  if (form.validUntil) input.validUntil = fromDateTimeLocalValue(form.validUntil);
  if (form.expiresAt) input.expiresAt = fromDateTimeLocalValue(form.expiresAt);
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function memoryPreview(memory: MemoryRecord): string {
  const text = (memory.summary || memory.content).replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function relationshipPreviews(
  candidate: MemoryCandidateReview
): Array<{ id: string; relation: string; contentPreview: string }> {
  const value = candidate.metadata?.["relationshipMemoryPreviews"];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      if (
        typeof record["id"] !== "string" ||
        typeof record["relation"] !== "string" ||
        typeof record["contentPreview"] !== "string"
      ) {
        return null;
      }
      return {
        id: record["id"],
        relation: record["relation"],
        contentPreview: record["contentPreview"]
      };
    })
    .filter((entry): entry is { id: string; relation: string; contentPreview: string } =>
      Boolean(entry)
    );
}

function temporalWarningForText(text: string): string | null {
  const match = text.match(
    /今早|今天|昨天|前天|刚才|刚刚|早上|中午|晚上|上周|这周|最近|\btoday\b|\byesterday\b|\bthis morning\b|\blast night\b|\brecently\b/iu
  );
  if (!match) {
    return null;
  }
  const date = new Date().toISOString().slice(0, 10);
  const phrase = /今早|早上|this morning/iu.test(match[0])
    ? `在 ${date} 早上`
    : /中午/iu.test(match[0])
      ? `在 ${date} 中午`
      : /晚上|last night/iu.test(match[0])
        ? `在 ${date} 晚上`
        : `在 ${date}`;
  return text.replace(match[0], phrase).replace(/^我/u, "用户").trim();
}

function formatScope(memory: MemoryRecord): string {
  return `${memory.scope ?? "user"}${memory.scopeId ? `/${memory.scopeId}` : ""}`;
}

function toDateTimeLocalValue(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 16);
}

function fromDateTimeLocalValue(value: string): string {
  return new Date(value).toISOString();
}

function safeMetadataText(metadata: Record<string, unknown> | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return "{}";
  }
  return JSON.stringify(metadata, null, 2);
}

function parseImportance(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, parsed));
}

function parseEmotionValue(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.min(1, Math.max(-1, parsed));
}

function formatLatency(latencyMs: number | undefined): string {
  return typeof latencyMs === "number" ? `${latencyMs}ms` : "unknown";
}

function formatTokenUsage(tokenUsage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): string {
  if (typeof tokenUsage.totalTokens === "number") {
    return String(tokenUsage.totalTokens);
  }
  const input = tokenUsage.inputTokens ?? 0;
  const output = tokenUsage.outputTokens ?? 0;
  return String(input + output);
}

function providerPreviewDetail(
  promptPreview: NonNullable<PromptPreviewResponse["promptPreview"]>,
  response: PromptPreviewResponse | null | undefined
): string {
  const model = promptPreview.providerModel ?? response?.providerModel ?? "unknown model";
  const mock = promptPreview.providerMock ?? response?.providerMock;
  const latency = promptPreview.providerLatencyMs ?? response?.providerLatencyMs;
  return `${mock ? "mock" : "real/unverified"} · ${model} · ${formatLatency(latency)}`;
}

function EventTable(props: { events: RuntimeEvent[] }): JSX.Element {
  if (props.events.length === 0) {
    return <EmptyState title="No events" message="Runtime events will appear here." />;
  }

  return (
    <div className="max-h-[360px] overflow-auto rounded-md border border-ink-100">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-ink-50">
          <tr>
            <th className="table-cell">Type</th>
            <th className="table-cell">Trace ID</th>
            <th className="table-cell">Created</th>
          </tr>
        </thead>
        <tbody>
          {props.events.map((event) => (
            <tr key={event.id}>
              <td className="table-cell font-medium">{event.type}</td>
              <td className="table-cell font-mono text-xs">{event.traceId}</td>
              <td className="table-cell text-ink-500">
                {formatDate(event.createdAt ?? event.timestamp ?? "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemoryFormFields(props: {
  form: MemoryForm;
  setForm: Dispatch<SetStateAction<MemoryForm>>;
  includeSource?: boolean;
}): JSX.Element {
  const update = (key: keyof MemoryForm, value: string): void => {
    props.setForm((current) => ({ ...current, [key]: value }));
  };
  const temporalWarning = temporalWarningForText(props.form.content);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <select
            className="field"
            value={props.form.type}
            onChange={(event) => update("type", event.target.value)}
          >
            {memoryTypes.map((memoryType) => (
              <option key={memoryType} value={memoryType}>
                {memoryType}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subtype">
          <select
            className="field"
            value={props.form.subtype}
            onChange={(event) => update("subtype", event.target.value)}
          >
            <option value="">none</option>
            {memorySubtypes.map((memorySubtype) => (
              <option key={memorySubtype} value={memorySubtype}>
                {memorySubtype}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Scope">
          <select
            className="field"
            value={props.form.scope}
            onChange={(event) => update("scope", event.target.value)}
          >
            {memoryScopes.map((scope) => (
              <option key={scope} value={scope}>
                {scope}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scope ID">
          <input
            className="field"
            placeholder="yuvi-runtime"
            value={props.form.scopeId}
            onChange={(event) => update("scopeId", event.target.value)}
          />
        </Field>
        <Field label="Layer">
          <select
            className="field"
            value={props.form.memoryLayer}
            onChange={(event) => update("memoryLayer", event.target.value)}
          >
            {memoryLayers.map((layer) => (
              <option key={layer} value={layer}>
                {layer}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Status">
        <select
          className="field"
          value={props.form.status}
          onChange={(event) => update("status", event.target.value)}
        >
          {memoryStatuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Content">
        <textarea
          className="field min-h-28"
          value={props.form.content}
          onChange={(event) => update("content", event.target.value)}
        />
      </Field>
      {temporalWarning && (
        <Notice
          tone="info"
          title="Relative time detected"
          message={`Relative time detected. Consider resolving it to an absolute date before saving.${temporalWarning ? ` Suggested: ${temporalWarning}` : ""}`}
        />
      )}
      <Field label="Summary">
        <textarea
          className="field min-h-20"
          value={props.form.summary}
          onChange={(event) => update("summary", event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Importance">
          <input
            className="field"
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={props.form.importance}
            onChange={(event) => update("importance", event.target.value)}
          />
        </Field>
        <Field label="Emotion Valence">
          <input
            className="field"
            type="number"
            min="-1"
            max="1"
            step="0.1"
            value={props.form.emotionValence}
            onChange={(event) => update("emotionValence", event.target.value)}
          />
        </Field>
        <Field label="Emotion Arousal">
          <input
            className="field"
            type="number"
            min="0"
            max="1"
            step="0.1"
            value={props.form.emotionArousal}
            onChange={(event) => update("emotionArousal", event.target.value)}
          />
        </Field>
      </div>
      {props.includeSource && (
        <Field label="Source">
          <input
            className="field"
            value={props.form.source}
            onChange={(event) => update("source", event.target.value)}
          />
        </Field>
      )}
      <Field label="Tags">
        <input
          className="field"
          placeholder="comma,separated"
          value={props.form.tags}
          onChange={(event) => update("tags", event.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Observed At">
          <input
            className="field"
            type="datetime-local"
            value={props.form.observedAt}
            onChange={(event) => update("observedAt", event.target.value)}
          />
        </Field>
        <Field label="Event Time">
          <input
            className="field"
            type="datetime-local"
            value={props.form.eventTime}
            onChange={(event) => update("eventTime", event.target.value)}
          />
        </Field>
        <Field label="Valid From">
          <input
            className="field"
            type="datetime-local"
            value={props.form.validFrom}
            onChange={(event) => update("validFrom", event.target.value)}
          />
        </Field>
        <Field label="Valid Until">
          <input
            className="field"
            type="datetime-local"
            value={props.form.validUntil}
            onChange={(event) => update("validUntil", event.target.value)}
          />
        </Field>
        <Field label="Expires At">
          <input
            className="field"
            type="datetime-local"
            value={props.form.expiresAt}
            onChange={(event) => update("expiresAt", event.target.value)}
          />
        </Field>
      </div>
    </div>
  );
}

function MemoryDetail(props: { memory: MemoryRecord }): JSX.Element {
  const metadata = safeMetadataText(props.memory.metadata);
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-3 gap-3">
        <Definition label="Type" value={props.memory.type} />
        <Definition label="Subtype" value={props.memory.subtype ?? "none"} />
        <Definition label="Scope" value={formatScope(props.memory)} />
        <Definition label="Layer" value={props.memory.memoryLayer ?? "unknown"} />
        <Definition label="Status" value={props.memory.status ?? "active"} />
        <Definition label="Importance" value={props.memory.importance.toFixed(2)} />
        <Definition label="Source" value={props.memory.source} />
        <Definition label="Source Trace" value={props.memory.sourceTraceId ?? "none"} />
        <Definition label="Persona" value={props.memory.personaId ?? "default-persona"} />
        <Definition label="Subject User" value={props.memory.subjectUserId ?? "default-user"} />
        <Definition label="Speaker" value={props.memory.speakerId ?? "none"} />
        <Definition label="Retention" value={props.memory.retentionClass ?? "unspecified"} />
        <Definition label="Retention Reason" value={props.memory.retentionReason ?? "none"} />
        <Definition label="Created" value={formatDate(props.memory.createdAt)} />
        <Definition label="Updated" value={formatDate(props.memory.updatedAt ?? "")} />
        <Definition label="Observed" value={formatDate(props.memory.observedAt ?? "")} />
        <Definition label="Valid From" value={formatDate(props.memory.validFrom ?? "")} />
        <Definition label="Valid Until" value={formatDate(props.memory.validUntil ?? "")} />
        <Definition label="Expires" value={formatDate(props.memory.expiresAt ?? "")} />
        <Definition label="Last Accessed" value={formatDate(props.memory.lastAccessedAt ?? "")} />
        <Definition label="Superseded" value={formatDate(props.memory.supersededAt ?? "")} />
        <Definition
          label="Emotion"
          value={`${props.memory.emotionValence ?? 0} / ${props.memory.emotionArousal ?? 0}`}
        />
      </div>
      <div>
        <div className="label">Content</div>
        <p className="mt-1 whitespace-pre-wrap rounded-md border border-ink-100 bg-ink-50 p-3 text-ink-700">
          {props.memory.content}
        </p>
      </div>
      <div>
        <div className="label">Summary</div>
        <p className="mt-1 whitespace-pre-wrap rounded-md border border-ink-100 bg-ink-50 p-3 text-ink-700">
          {props.memory.summary || "none"}
        </p>
      </div>
      <Definition label="Tags" value={props.memory.tags.join(", ") || "none"} />
      <div>
        <div className="label">Safe Metadata</div>
        <pre className="mt-1 max-h-52 overflow-auto rounded-md border border-ink-100 bg-ink-950 p-3 text-xs text-ink-50">
          {metadata}
        </pre>
      </div>
    </div>
  );
}

function MemoryTable(props: {
  memories: MemoryRecord[];
  debugById?: Map<string, RetrievedMemoryDebug>;
  compact?: boolean;
  onView?(memory: MemoryRecord): void;
  onEdit?(memory: MemoryRecord): void;
  onArchive?(memory: MemoryRecord): void;
  onRestore?(memory: MemoryRecord): void;
  onForget?(memory: MemoryRecord): void;
  onDelete?(memory: MemoryRecord): void;
}): JSX.Element {
  return (
    <div className="max-h-[420px] overflow-auto rounded-md border border-ink-100">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-ink-50">
          <tr>
            <th className="table-cell">Type</th>
            {!props.compact && <th className="table-cell">Subtype</th>}
            {!props.compact && <th className="table-cell">Layer</th>}
            {!props.compact && <th className="table-cell">Status</th>}
            {!props.compact && <th className="table-cell">Scope</th>}
            <th className="table-cell">Content</th>
            {!props.compact && <th className="table-cell">Importance</th>}
            {!props.compact && <th className="table-cell">Tags</th>}
            {!props.compact && <th className="table-cell">Source</th>}
            {!props.compact && <th className="table-cell">Embedding</th>}
            {!props.compact && <th className="table-cell">Matched</th>}
            {!props.compact && <th className="table-cell">Trace</th>}
            <th className="table-cell">Created</th>
            {!props.compact && <th className="table-cell">Updated</th>}
            {(props.onView ||
              props.onEdit ||
              props.onArchive ||
              props.onRestore ||
              props.onForget ||
              props.onDelete) && <th className="table-cell">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {props.memories.map((memory) => {
            const debug = props.debugById?.get(memory.id);
            return (
              <tr key={memory.id}>
                <td className="table-cell">{memory.type}</td>
                {!props.compact && <td className="table-cell">{memory.subtype ?? "none"}</td>}
                {!props.compact && (
                  <td className="table-cell text-ink-500">{memory.memoryLayer ?? "unknown"}</td>
                )}
                {!props.compact && (
                  <td className="table-cell text-ink-500">{memory.status ?? "active"}</td>
                )}
                {!props.compact && (
                  <td className="table-cell text-ink-500">{formatScope(memory)}</td>
                )}
                <td className="table-cell">{memoryPreview(memory)}</td>
                {!props.compact && (
                  <td className="table-cell text-ink-500">{memory.importance.toFixed(2)}</td>
                )}
                {!props.compact && (
                  <td className="table-cell text-ink-500">{memory.tags.join(", ") || "none"}</td>
                )}
                {!props.compact && <td className="table-cell text-ink-500">{memory.source}</td>}
                {!props.compact && (
                  <td className="table-cell text-ink-500">
                    <span
                      className={`rounded px-2 py-1 text-[10px] font-semibold ${
                        (memory.hasEmbedding ?? memory.embeddedAt)
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {(memory.hasEmbedding ?? memory.embeddedAt) ? "Embedded" : "Missing"}
                    </span>
                    {memory.embeddingProvider ? (
                      <span className="block text-[10px] text-ink-400">
                        {memory.embeddingProvider}
                        {memory.embeddingModel ? ` · ${memory.embeddingModel}` : ""}
                        {memory.embeddingDimensions ? ` · ${memory.embeddingDimensions}d` : ""}
                      </span>
                    ) : null}
                    {memory.embeddedAt ? (
                      <span className="block text-[10px] text-ink-400">
                        {formatDate(memory.embeddedAt)}
                      </span>
                    ) : null}
                    {memory.semanticEmbedding === false ? (
                      <span className="block text-[10px] text-amber-700">non-semantic mock</span>
                    ) : null}
                    {memory.embeddingError ? (
                      <span className="block text-[10px] text-rose-700">
                        {memory.embeddingError}
                      </span>
                    ) : null}
                  </td>
                )}
                {!props.compact && (
                  <td className="table-cell text-ink-500">
                    {debug?.matchedBy ?? "n/a"}
                    {debug?.retrievalMode ? (
                      <span className="block text-[10px] text-ink-400">{debug.retrievalMode}</span>
                    ) : null}
                    {debug?.score !== undefined ? ` · ${debug.score.toFixed(2)}` : ""}
                    {debug?.rankComponents ? (
                      <span className="block text-[10px] text-ink-400">
                        {formatRankComponents(debug.rankComponents)}
                      </span>
                    ) : null}
                  </td>
                )}
                {!props.compact && (
                  <td className="table-cell font-mono text-xs text-ink-500">
                    {shortTrace(memory.sourceTraceId ?? undefined)}
                  </td>
                )}
                <td className="table-cell text-ink-500">{formatDate(memory.createdAt)}</td>
                {!props.compact && (
                  <td className="table-cell text-ink-500">{formatDate(memory.updatedAt ?? "")}</td>
                )}
                {(props.onView ||
                  props.onEdit ||
                  props.onArchive ||
                  props.onRestore ||
                  props.onForget ||
                  props.onDelete) && (
                  <td className="table-cell">
                    <div className="flex flex-wrap gap-2">
                      {props.onView && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onView?.(memory)}
                        >
                          View
                        </button>
                      )}
                      {props.onEdit && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onEdit?.(memory)}
                        >
                          Edit
                        </button>
                      )}
                      {props.onArchive && memory.status !== "archived" && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onArchive?.(memory)}
                        >
                          Archive
                        </button>
                      )}
                      {props.onRestore && memory.status !== "active" && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onRestore?.(memory)}
                        >
                          Restore
                        </button>
                      )}
                      {props.onForget && memory.status !== "forgotten" && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onForget?.(memory)}
                        >
                          Forget
                        </button>
                      )}
                      {props.onDelete && (
                        <button
                          className="button-secondary"
                          type="button"
                          onClick={() => props.onDelete?.(memory)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function MemoryCandidateList(props: {
  candidates: MemoryCandidateReview[];
  compact?: boolean;
  busyCandidateId?: string | null;
  onAccept?(candidate: MemoryCandidateReview): void;
  onReject?(candidate: MemoryCandidateReview): void;
  onEdit?(candidate: MemoryCandidateReview): void;
}): JSX.Element {
  return (
    <div className="max-h-[360px] space-y-3 overflow-auto">
      {props.candidates.map((candidate) => (
        <div key={candidate.id} className="rounded-md border border-ink-100 bg-white p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <span className="badge">{candidate.decision}</span>
            <span className="font-mono text-ink-500">{candidate.type}</span>
            <span className="text-ink-500">{candidate.subtype ?? "none"}</span>
            <span className="text-ink-500">
              {candidate.memoryLayer ?? "unknown"} · {candidate.scope ?? "user"}
              {candidate.scopeId ? `/${candidate.scopeId}` : ""}
            </span>
            <span className="text-ink-500">importance {candidate.importance.toFixed(2)}</span>
            {candidate.confidence !== undefined && (
              <span className="text-ink-500">confidence {candidate.confidence.toFixed(2)}</span>
            )}
            <span className="font-mono text-ink-500">
              trace {shortTrace(candidate.sourceTraceId ?? candidate.traceId)}
            </span>
            {!props.compact && (
              <>
                <span className="text-ink-500">extractor {candidate.extractorMode ?? "n/a"}</span>
                <span className="text-ink-500">
                  fallback {String(candidate.fallbackUsed ?? false)}
                </span>
              </>
            )}
          </div>
          <p className="whitespace-pre-wrap text-sm text-ink-700">
            {props.compact ? candidate.contentPreview : candidate.content}
          </p>
          {!props.compact && candidate.temporalStatus === "unresolved" && (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
              Relative time detected. Consider resolving it to an absolute date before saving.
              {candidate.temporalSuggestion ? ` Suggested: ${candidate.temporalSuggestion}` : ""}
            </div>
          )}
          {candidate.summary && (
            <p className="mt-2 text-xs text-ink-500">Summary: {candidate.summary}</p>
          )}
          <div className="mt-2 text-xs text-ink-500">
            Reason: {candidate.reason}
            {candidate.storageReason ? ` · Stored: ${candidate.storageReason}` : ""}
            {candidate.rejectedReason ? ` · Rejected: ${candidate.rejectedReason}` : ""}
          </div>
          {!props.compact && (
            <div className="mt-2 text-xs text-ink-500">
              Origin: {candidate.originRole ?? "n/a"} · Explicit remember:{" "}
              {String(candidate.explicitRememberRequested ?? false)} · Correction:{" "}
              {String(candidate.correctionRequested ?? false)}
              {candidate.canonicalFingerprint
                ? ` · Fingerprint: ${candidate.canonicalFingerprint}`
                : ""}
            </div>
          )}
          {!props.compact && (
            <div className="mt-2 text-xs text-ink-500">
              Tags: {candidate.tags.join(", ") || "none"}
            </div>
          )}
          {!props.compact && candidate.createdAt && (
            <div className="mt-2 text-xs text-ink-500">
              Created: {formatDate(candidate.createdAt)} · Source: {candidate.source ?? "runtime"}
              {candidate.extractorProvider ? ` · Provider: ${candidate.extractorProvider}` : ""}
            </div>
          )}
          {!props.compact && (
            <div className="mt-2 text-xs text-ink-500">
              Observed: {formatDate(candidate.observedAt ?? "")} · Valid:{" "}
              {formatDate(candidate.validFrom ?? "") || "now"} →{" "}
              {formatDate(candidate.validUntil ?? "") || "open"}
              {candidate.expiresAt ? ` · Expires: ${formatDate(candidate.expiresAt)}` : ""}
            </div>
          )}
          {!props.compact &&
            ((candidate.possibleSupersedes?.length ?? 0) > 0 ||
              (candidate.possibleContradictions?.length ?? 0) > 0) && (
              <div className="mt-2 text-xs text-ink-500">
                Possible supersedes: {candidate.possibleSupersedes?.join(", ") || "none"} ·
                Contradictions: {candidate.possibleContradictions?.join(", ") || "none"}
                {candidate.relationshipConfidence !== undefined
                  ? ` · Confidence: ${candidate.relationshipConfidence.toFixed(2)}`
                  : ""}
                {candidate.relationshipReason ? ` · Reason: ${candidate.relationshipReason}` : ""}
              </div>
            )}
          {!props.compact && relationshipPreviews(candidate).length > 0 && (
            <div className="mt-2 space-y-1 text-xs text-ink-500">
              {relationshipPreviews(candidate).map((preview) => (
                <div key={`${preview.relation}-${preview.id}`}>
                  {preview.relation}: {preview.contentPreview}
                </div>
              ))}
            </div>
          )}
          {(props.onAccept || props.onReject || props.onEdit) && (
            <div className="mt-3 flex flex-wrap gap-2">
              {props.onAccept && (
                <button
                  className="button-secondary"
                  type="button"
                  disabled={
                    props.busyCandidateId === candidate.id || Boolean(candidate.storedMemoryId)
                  }
                  onClick={() => props.onAccept?.(candidate)}
                >
                  {candidate.storedMemoryId ? "Stored" : "Accept"}
                </button>
              )}
              {props.onEdit && (
                <button
                  className="button-secondary"
                  type="button"
                  onClick={() => props.onEdit?.(candidate)}
                >
                  Edit & Save
                </button>
              )}
              {props.onReject && (
                <button
                  className="button-secondary"
                  type="button"
                  disabled={props.busyCandidateId === candidate.id}
                  onClick={() => props.onReject?.(candidate)}
                >
                  Reject
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function shortTrace(value: string | undefined): string {
  return value ? value.slice(0, 8) : "unknown";
}

function promptSections(
  preview: PromptPreviewResponse | null
): Array<{ title: string; content: string; mock?: boolean }> {
  if (!preview?.promptPreview) {
    return promptPreviewPlaceholder.map((section) => ({
      title: section.title,
      content: section.content,
      mock: true
    }));
  }

  return preview.promptPreview.sections.map((section) => ({
    title: section.name,
    content: section.content
  }));
}
