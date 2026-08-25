import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  ApiError,
  apiClient,
  type MessageStreamEvent,
  type ProactiveMessageStreamEvent
} from "./api/client.js";
import {
  beginControlledDraftSubmit,
  reduceChatMessages,
  shouldSubmitChatKey,
  type ChatMessage
} from "./chat-state.js";
import { ChatMessageContent } from "./markdown-message.js";
import { detectSpeechLanguage, type SpeechQueueState } from "./speech-queue.js";
import { SpeechSegmenter } from "./speech-segmenter.js";
import {
  CompanionBus,
  type CompanionBusMessage,
  type CompanionPlaybackState,
  type CompanionTtsConfiguration
} from "./companion-bus.js";
import { deriveCapabilityProjection, deriveEffectiveVoiceOutput } from "./capability-projection.js";
import {
  correlateSpeechPlayback,
  createSpeechPlaybackCorrelation,
  retireActiveSpeechPlayback,
  type SpeechPlaybackCorrelationState
} from "./speech-playback-correlation.js";
import type { SpeechSegmentIdentity } from "./speech-identity.js";
import { EmptyState, Field, Notice, Panel, Pill, Toggle } from "./surface-ui.js";
import { readVoiceOutputPreference, writeVoiceOutputPreference } from "./voice-output.js";
import { controlCompanionWindow, isTauriRuntime } from "./tauri-window.js";
import { ServiceStatusPanel } from "./service-status-panel.js";
import { UserSettingsPanel } from "./user-settings-panel.js";
import { fetchUserSettings, subscribeUserSettingsChanged } from "./user-settings-client.js";
import { initialServiceStatusState, type ServiceStatusState } from "./service-status-state.js";
import {
  isServiceSupervisorAvailable,
  subscribeServiceStatusState
} from "./service-supervisor-client.js";
import {
  createInitialProactiveConsentState,
  reduceProactiveConsent,
  type ProactiveConsentAction
} from "./proactive-consent.js";
import { evaluateProactiveTurnAdmission } from "./proactive-turn-admission.js";
import {
  createProactiveTurnExecution,
  isCurrentProactiveEffect,
  isCurrentRequest,
  preemptProactiveRequest,
  type ActiveRequestOwnership,
  type ProactiveTurnEffect
} from "./proactive-turn-execution.js";
import type { TtsSettingsProjection } from "./user-settings-state.js";

type RequestStatus = "idle" | "sending" | "success" | "error";
type VoicePlaybackStatus = SpeechQueueState;

let surfaceSequence = 0;

function createSurfaceId(prefix: string): string {
  surfaceSequence += 1;
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid ?? surfaceSequence}`;
}

/**
 * Desktop main window surface: chat input and the streaming text reply.
 * Speech segments are forwarded to the companion window over CompanionBus;
 * this surface never owns audio playback, Lumi, or the analyser chain.
 */
export function MainPage(): JSX.Element {
  const [sessionId, setSessionId] = useState("default");
  const [readMemory, setReadMemory] = useState(true);
  const [writeMemory, setWriteMemory] = useState(true);
  const [promptPreview, setPromptPreview] = useState(true);
  const [voiceOutput, setVoiceOutput] = useState<boolean>(readVoiceOutputPreference);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusState>(initialServiceStatusState);
  const [ttsConfig, setTtsConfig] = useState<CompanionTtsConfiguration | null>(() =>
    isTauriRuntime() ? null : { enabled: true, mode: "external" }
  );
  const [proactiveConsent, dispatchProactiveConsent] = useReducer(
    reduceProactiveConsent,
    undefined,
    createInitialProactiveConsentState
  );
  const [messages, dispatchMessages] = useReducer(reduceChatMessages, [] as ChatMessage[]);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastTraceId, setLastTraceId] = useState<string | null>(null);
  const [voicePlaybackStatus, setVoicePlaybackStatus] = useState<VoicePlaybackStatus>("idle");
  const [actualPlaybackActive, setActualPlaybackActive] = useState(false);
  const [companionReady, setCompanionReady] = useState(false);
  const [input, setInput] = useState("");
  const [companionActionError, setCompanionActionError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busRef = useRef<CompanionBus | null>(null);
  const voiceOutputRef = useRef(voiceOutput);
  const ttsConfigRef = useRef(ttsConfig);
  const ttsConfigRevisionRef = useRef(-1);
  const proactiveConsentRef = useRef(proactiveConsent);
  const runtimeContextRef = useRef({ sessionId, readMemory, promptPreview });
  runtimeContextRef.current = { sessionId, readMemory, promptPreview };
  const proactiveExecutionRef = useRef<ReturnType<typeof createProactiveTurnExecution> | null>(
    null
  );
  if (proactiveExecutionRef.current === null) {
    proactiveExecutionRef.current = createProactiveTurnExecution({
      createRequestId: () => createSurfaceId("proactive-turn"),
      createAssistantId: () => createSurfaceId("proactive-assistant")
    });
  }
  const speechSessionRef = useRef<{
    generation: string;
    segmenter: SpeechSegmenter;
    sequence: number;
    ended: boolean;
  } | null>(null);
  const speechEpochRef = useRef<string | null>(null);
  const playbackCorrelationRef = useRef<SpeechPlaybackCorrelationState>(
    createSpeechPlaybackCorrelation()
  );
  const activeRequestRef = useRef<ActiveRequestOwnership | null>(null);

  const capabilityProjection = useMemo(
    () =>
      deriveCapabilityProjection({
        serviceStatus,
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        ttsConfiguration: ttsConfig,
        audio: "unknown",
        live2dLifecycle: "loading"
      }),
    [serviceStatus, ttsConfig]
  );
  const effectiveVoiceOutput = useMemo(
    () =>
      deriveEffectiveVoiceOutput({
        persistentTtsEnabled: ttsConfig?.enabled ?? null,
        perTurnVoiceOutput: voiceOutput,
        ttsCapability: capabilityProjection.capabilities.tts,
        ttsConfiguration: ttsConfig
      }),
    [capabilityProjection.capabilities.tts, ttsConfig?.enabled, ttsConfig?.mode, voiceOutput]
  );
  const effectiveVoiceOutputRef = useRef(effectiveVoiceOutput);
  ttsConfigRef.current = ttsConfig;
  effectiveVoiceOutputRef.current = effectiveVoiceOutput;

  useEffect(() => {
    voiceOutputRef.current = voiceOutput;
  }, [voiceOutput]);

  useEffect(() => {
    if (!isTauriRuntime() && !isServiceSupervisorAvailable()) return;
    return subscribeServiceStatusState(setServiceStatus);
  }, []);

  const applyProactiveConsent = useCallback((action: ProactiveConsentAction): boolean => {
    const current = proactiveConsentRef.current;
    const next = reduceProactiveConsent(current, action);
    if (next === current) return false;
    proactiveConsentRef.current = next;
    dispatchProactiveConsent(action);
    return true;
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const initialRequestRevision = proactiveConsentRef.current.revisionFloor;

    const applySettingsView = (
      view: Awaited<ReturnType<typeof fetchUserSettings>>,
      requestRevision: number
    ): void => {
      if (cancelled) return;
      if (view.loadError !== null) {
        applyProactiveConsent({
          type: "settings-read-failed",
          requestRevision: Math.max(requestRevision, view.revision)
        });
      } else {
        applyProactiveConsent({
          type: "settings-view",
          revision: view.revision,
          enabled: view.settings.proactive.enabled
        });
      }
    };

    const refetchProactiveConsent = (requestRevision: number): void => {
      void fetchUserSettings()
        .then((view) => applySettingsView(view, requestRevision))
        .catch(() => {
          if (!cancelled) {
            applyProactiveConsent({ type: "settings-read-failed", requestRevision });
          }
        });
    };

    void fetchUserSettings()
      .then((view) => {
        if (cancelled) return;
        // Preserve the existing TTS initial-load projection and its revision fence.
        if (view.revision >= ttsConfigRevisionRef.current) {
          const settings: CompanionTtsConfiguration = {
            enabled: view.settings.tts.enabled,
            mode: view.settings.tts.mode
          };
          ttsConfigRevisionRef.current = view.revision;
          ttsConfigRef.current = settings;
          setTtsConfig(settings);
        }
        applySettingsView(view, initialRequestRevision);
      })
      .catch(() => {
        if (!cancelled) {
          // Keep the existing TTS capability unknown and keep proactive consent denied.
          applyProactiveConsent({
            type: "settings-read-failed",
            requestRevision: initialRequestRevision
          });
        }
      });

    const unsubscribe = subscribeUserSettingsChanged((event) => {
      if (cancelled) return;
      const invalidated = applyProactiveConsent({
        type: "settings-changed",
        revision: event.revision,
        changedSections: event.changedSections
      });
      if (invalidated) refetchProactiveConsent(event.revision);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyProactiveConsent]);

  const onTtsSettings = useCallback((settings: TtsSettingsProjection, revision: number): void => {
    if (revision < ttsConfigRevisionRef.current) return;
    ttsConfigRevisionRef.current = revision;
    const config: CompanionTtsConfiguration = {
      enabled: settings.enabled,
      mode: settings.mode
    };
    ttsConfigRef.current = config;
    setTtsConfig(config);
    busRef.current?.post({ kind: "tts-config", config });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const bus = new CompanionBus("main");
    busRef.current = bus;
    const handleProactiveTextRequest = (
      message: Extract<CompanionBusMessage, { kind: "proactive-text-request" }>
    ): void => {
      const admission = evaluateProactiveTurnAdmission(proactiveConsentRef.current);
      // The correlated E2B answer is always posted before any execution
      // arbitration, claim, local row, key generation, or Runtime call.
      bus.post({
        kind: "proactive-text-admission-result",
        decisionId: message.decisionId,
        ...admission
      });

      const execution = proactiveExecutionRef.current;
      if (execution === null) return;
      const result = execution.tryCommit({
        decisionId: message.decisionId,
        admission,
        active: activeRequestRef.current,
        context: runtimeContextRef.current
      });
      if (result.kind !== "committed") return;

      const { effect } = result;
      activeRequestRef.current = effect.ownership;
      setError(null);
      setRequestStatus("sending");
      void executeProactiveTurn(effect);
    };
    const unsubscribe = bus.subscribe((message: CompanionBusMessage) => {
      if (!mountedRef.current) return;
      if (message.kind === "companion-ready") {
        setCompanionReady(true);
        // A companion window may have been recreated; re-sync the current
        // voice-enabled preference so TTS state converges without a reload.
        bus.post({ kind: "voice-enabled", enabled: voiceOutputRef.current });
        bus.post({ kind: "tts-config", config: ttsConfigRef.current });
      } else if (message.kind === "speech-status") {
        if (speechEpochRef.current !== message.requestId) return;
        setVoicePlaybackStatus(message.state);
        if (message.state === "idle" || message.state === "stopped") {
          speechEpochRef.current = null;
        }
      } else if (message.kind === "playback-status") {
        if (speechEpochRef.current !== message.requestId) return;
        const segment: SpeechSegmentIdentity = {
          requestId: message.requestId,
          sequence: message.segmentSequence
        };
        const result = correlateMainPlaybackStatus(
          playbackCorrelationRef.current,
          message.state === "started" ? "started" : "terminal",
          segment
        );
        playbackCorrelationRef.current = result.state;
        if (!result.accepted) return;
        applyPlaybackStatus(message.state, setVoicePlaybackStatus, setActualPlaybackActive);
      } else if (message.kind === "proactive-text-request") {
        handleProactiveTextRequest(message);
      }
    });
    // Announce the persisted preference so a companion that is already open
    // (or opens later) starts with the same voice-enabled state.
    bus.post({ kind: "voice-enabled", enabled: voiceOutputRef.current });
    bus.post({ kind: "tts-config", config: ttsConfigRef.current });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      bus.close();
      busRef.current = null;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      speechSessionRef.current = null;
      speechEpochRef.current = null;
      playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
    };
  }, []);

  useEffect(() => {
    busRef.current?.post({ kind: "tts-config", config: ttsConfig });
  }, [ttsConfig]);

  function updateVoiceOutput(enabled: boolean): void {
    setVoiceOutput(enabled);
    writeVoiceOutputPreference(enabled);
    voiceOutputRef.current = enabled;
    if (!enabled) {
      setVoicePlaybackStatus("idle");
      setActualPlaybackActive(false);
      speechEpochRef.current = null;
      playbackCorrelationRef.current = retireActiveSpeechPlayback(playbackCorrelationRef.current);
    }
    busRef.current?.post({ kind: "voice-enabled", enabled });
  }

  function cancelActiveProactiveRequest(active: ActiveRequestOwnership): void {
    if (!isCurrentRequest(activeRequestRef.current, active)) return;
    // Clear the page owner before aborting so the rejected promise and any
    // late stream event cannot touch the user request that follows.
    activeRequestRef.current = null;
    preemptProactiveRequest(active);
    dispatchMessages({
      type: "cancel",
      assistantId: active.assistantId,
      error: "生成已取消，以上内容可能不完整。"
    });
    setRequestStatus("idle");
  }

  async function send(): Promise<void> {
    // Capture the exact draft once, then clear the controlled state immediately
    // so async work never re-reads or restores the textarea contents.
    const submit = beginControlledDraftSubmit(input);
    if (submit === null) return;
    const active = activeRequestRef.current;
    if (active?.origin === "user") return;
    if (active?.origin === "proactive") {
      cancelActiveProactiveRequest(active);
    }
    const content = submit.submittedText;
    setInput(submit.nextDraft);
    setError(null);
    inputRef.current?.focus();
    const requestId = createSurfaceId("turn");
    const assistantId = createSurfaceId("assistant");
    const controller = new AbortController();
    const ownership: ActiveRequestOwnership = {
      id: requestId,
      assistantId,
      controller,
      completedObserved: false,
      origin: "user"
    };
    activeRequestRef.current = ownership;
    const shouldRequestTts = effectiveVoiceOutputRef.current.requestTts;
    speechEpochRef.current = shouldRequestTts ? requestId : null;
    playbackCorrelationRef.current = createSpeechPlaybackCorrelation();
    setActualPlaybackActive(false);
    setRequestStatus("sending");
    const bus = busRef.current;
    bus?.post({ kind: "user-gesture" });
    bus?.post({ kind: "voice-enabled", enabled: voiceOutputRef.current });
    bus?.post({ kind: "start-generation", requestId, sessionId });
    const segmenter = new SpeechSegmenter();
    if (shouldRequestTts) {
      speechSessionRef.current = { generation: requestId, segmenter, sequence: 0, ended: false };
    }
    dispatchMessages({
      type: "append-turn",
      user: {
        id: createSurfaceId("user"),
        requestId,
        role: "user",
        content,
        useMemory: readMemory && writeMemory,
        readMemory,
        writeMemory,
        voiceOutput: voiceOutputRef.current,
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
            // The companion window owns sentence-level TTS for this path;
            // avoid asking Runtime to synthesize the full reply a second time.
            voiceOutput: false,
            promptPreview
          }
        },
        {
          signal: controller.signal,
          onEvent: (event: MessageStreamEvent) => {
            if (!mountedRef.current || !isCurrentRequest(activeRequestRef.current, ownership)) {
              return;
            }
            if (event.type === "text-delta") {
              setLastTraceId(event.traceId);
              dispatchMessages({
                type: "append-delta",
                assistantId,
                text: event.text,
                traceId: event.traceId
              });
              forwardSpeechSegments(requestId, event.text);
              return;
            }
            if (event.type === "error") {
              dispatchMessages({ type: "fail", assistantId, error: event.message });
              setError(event.message);
              forwardSpeechEnd(requestId, "failed");
              return;
            }
            ownership.completedObserved = true;
            setLastTraceId(event.traceId);
            dispatchMessages({
              type: "complete",
              assistantId,
              content: event.content,
              traceId: event.traceId,
              provider: event.provider
            });
            setRequestStatus("success");
            forwardSpeechEnd(requestId, "completed");
          }
        }
      );

      if (!mountedRef.current || !isCurrentRequest(activeRequestRef.current, ownership)) {
        return;
      }
      ownership.completedObserved = true;
      dispatchMessages({
        type: "complete",
        assistantId,
        content: response.content,
        traceId: response.traceId,
        provider: response.provider
      });
      setLastTraceId(response.traceId);
      setRequestStatus("success");
      forwardSpeechEnd(requestId, "completed");
    } catch (caught) {
      if (!mountedRef.current || !isCurrentRequest(activeRequestRef.current, ownership)) {
        return;
      }
      if (controller.signal.aborted) {
        const speech = speechSessionRef.current;
        if (speech?.generation === requestId) {
          speech.segmenter.reset();
        }
        dispatchMessages({
          type: "cancel",
          assistantId,
          error: "生成已取消，以上内容可能不完整。"
        });
        setRequestStatus("idle");
        return;
      }
      const message = friendlyChatError(caught);
      forwardSpeechEnd(requestId, "failed");
      dispatchMessages({ type: "fail", assistantId, error: message });
      setError(message);
      setRequestStatus("error");
    } finally {
      if (isCurrentRequest(activeRequestRef.current, ownership)) {
        activeRequestRef.current = null;
        bus?.post({ kind: "generation-state", requestId, state: "idle" });
      }
      if (speechSessionRef.current?.generation === requestId) {
        speechSessionRef.current = null;
      }
    }
  }

  async function executeProactiveTurn(effect: ProactiveTurnEffect): Promise<void> {
    const isCurrent = (): boolean =>
      mountedRef.current && isCurrentProactiveEffect(activeRequestRef.current, effect);
    let assistantProjected = false;

    try {
      const response = await apiClient.streamProactiveTurn(effect.request, {
        signal: effect.ownership.controller.signal,
        onEvent: (event: ProactiveMessageStreamEvent) => {
          if (!isCurrent()) return;
          if (event.type === "proactive-decision") {
            setLastTraceId(event.traceId);
            if (event.decision === "NO_OP") {
              effect.ownership.completedObserved = true;
              setRequestStatus("idle");
            }
            return;
          }
          if (event.type === "text-delta") {
            setLastTraceId(event.traceId);
            if (!assistantProjected) {
              assistantProjected = true;
              dispatchMessages({
                type: "append-assistant",
                assistant: {
                  id: effect.assistantId,
                  requestId: effect.requestId,
                  role: "assistant",
                  content: event.text,
                  status: "streaming",
                  traceId: event.traceId
                }
              });
            } else {
              dispatchMessages({
                type: "append-delta",
                assistantId: effect.assistantId,
                text: event.text,
                traceId: event.traceId
              });
            }
            return;
          }
          if (event.type === "error") {
            dispatchMessages({
              type: "fail",
              assistantId: effect.assistantId,
              error: event.message
            });
            setError(event.message);
            return;
          }
          effect.ownership.completedObserved = true;
          setLastTraceId(event.traceId);
          dispatchMessages({
            type: "complete",
            assistantId: effect.assistantId,
            content: event.content,
            traceId: event.traceId,
            provider: event.provider
          });
          setRequestStatus("success");
        }
      });

      if (!isCurrent()) return;
      if (response.type === "proactive-decision") {
        effect.ownership.completedObserved = true;
        setLastTraceId(response.traceId);
        setRequestStatus("idle");
        return;
      }
      effect.ownership.completedObserved = true;
      dispatchMessages({
        type: "complete",
        assistantId: effect.assistantId,
        content: response.content,
        traceId: response.traceId,
        provider: response.provider
      });
      setLastTraceId(response.traceId);
      setRequestStatus("success");
    } catch (caught) {
      if (!isCurrent()) return;
      if (effect.ownership.controller.signal.aborted) {
        dispatchMessages({
          type: "cancel",
          assistantId: effect.assistantId,
          error: "生成已取消，以上内容可能不完整。"
        });
        setRequestStatus("idle");
        return;
      }
      const message = friendlyChatError(caught);
      dispatchMessages({ type: "fail", assistantId: effect.assistantId, error: message });
      setError(message);
      setRequestStatus("error");
    } finally {
      if (isCurrent()) {
        activeRequestRef.current = null;
      }
    }
  }

  function forwardSpeechSegments(requestId: string, text: string): void {
    const speech = speechSessionRef.current;
    const bus = busRef.current;
    if (
      !speech ||
      speech.generation !== requestId ||
      !bus ||
      !effectiveVoiceOutputRef.current.requestTts
    ) {
      return;
    }
    for (const segment of speech.segmenter.push(text)) {
      bus.post({
        kind: "speak",
        requestId,
        sequence: speech.sequence++,
        text: segment,
        language: detectSpeechLanguage(segment)
      });
    }
  }

  function forwardSpeechEnd(requestId: string, reason: "completed" | "failed"): void {
    const speech = speechSessionRef.current;
    const bus = busRef.current;
    if (!speech || speech.generation !== requestId || !bus) return;
    if (speech.ended) return;
    speech.ended = true;
    if (!effectiveVoiceOutputRef.current.requestTts) {
      // Let already-queued/playing local audio finish, but do not flush new
      // text into synthesis after settings or service health disables TTS.
      bus.post({ kind: "speech-end", requestId });
      return;
    }
    for (const segment of speech.segmenter.flush(reason)) {
      bus.post({
        kind: "speak",
        requestId,
        sequence: speech.sequence++,
        text: segment,
        language: detectSpeechLanguage(segment)
      });
    }
    bus.post({ kind: "speech-end", requestId });
  }

  function stopGeneration(): void {
    const active = activeRequestRef.current;
    if (!active) return;
    if (active.origin === "proactive") {
      cancelActiveProactiveRequest(active);
      return;
    }
    if (active.completedObserved) return;
    busRef.current?.post({ kind: "stop-speech", requestId: active.id });
    busRef.current?.post({
      kind: "generation-state",
      requestId: active.id,
      state: "interrupted"
    });
    active.controller.abort();
    activeRequestRef.current = null;
    speechSessionRef.current = null;
    dispatchMessages({
      type: "cancel",
      assistantId: active.assistantId,
      error: "生成已取消，以上内容可能不完整。"
    });
    setRequestStatus("idle");
    setVoicePlaybackStatus("idle");
  }

  function stopSpeech(): void {
    const requestId = resolveSpeechCommandEpoch(
      speechEpochRef.current,
      activeRequestRef.current?.id ?? null
    );
    if (requestId === null) return;
    busRef.current?.post({ kind: "stop-speech", requestId });
    setVoicePlaybackStatus("stopped");
    setActualPlaybackActive(false);
    playbackCorrelationRef.current = retireActiveSpeechPlayback(playbackCorrelationRef.current);
  }

  async function controlCompanion(
    action: "show_companion" | "hide_companion" | "reopen_companion"
  ): Promise<void> {
    setCompanionActionError(null);
    try {
      await controlCompanionWindow(action);
    } catch {
      setCompanionActionError("无法控制 companion 窗口。");
    }
  }

  return (
    <div className="min-h-screen bg-ink-100">
      <ServiceStatusPanel />
      <div className={`mx-auto space-y-4 p-6 ${showSettings ? "max-w-6xl" : "max-w-3xl"}`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">YUVI Chat</h1>
            <p className="mt-1 text-sm text-ink-500">
              Main window: chat input and streaming text. Speech and Lumi live in the companion
              window.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Pill status={companionReady ? "companion connected" : "companion offline"} />
            {isTauriRuntime() && (
              <>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => setShowSettings((value) => !value)}
                >
                  {showSettings ? "关闭设置" : "设置"}
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void controlCompanion("show_companion")}
                >
                  显示形象
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void controlCompanion("hide_companion")}
                >
                  隐藏形象
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => void controlCompanion("reopen_companion")}
                >
                  重新打开
                </button>
              </>
            )}
          </div>
        </div>

        {showSettings && <UserSettingsPanel onTtsSettings={onTtsSettings} />}

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
                  </div>
                ))}
              </div>
            )}
          </div>
          {error && (
            <div className="mt-2">
              <Notice tone="error" title="Send failed" message={error} />
            </div>
          )}
          {companionActionError && (
            <div className="mt-2">
              <Notice tone="error" title="Companion" message={companionActionError} />
            </div>
          )}
          {lastTraceId && (
            <div className="mt-2">
              <Notice tone="info" title="Latest trace" message={lastTraceId} />
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <textarea
              ref={inputRef}
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
            {requestStatus === "sending" ? (
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
                disabled={!input.trim()}
                onClick={() => void send()}
                aria-label="Send message"
              >
                Send
              </button>
            )}
            {(actualPlaybackActive ||
              voicePlaybackStatus === "synthesizing" ||
              voicePlaybackStatus === "playing") && (
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
              {voicePlaybackStatusLabel(voicePlaybackStatus, actualPlaybackActive)}
            </div>
          )}
        </Panel>

        <Panel title="Turn Options">
          <div className="grid gap-3">
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
              label="TTS output"
              checked={voiceOutput}
              onChange={updateVoiceOutput}
              testId="tts-output-toggle"
              note="Streams sentence segments to the companion window for synthesis and lip sync."
            />
          </div>
        </Panel>
      </div>
    </div>
  );
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

export function resolveSpeechCommandEpoch(
  speechEpoch: string | null,
  generationEpoch: string | null
): string | null {
  return speechEpoch ?? generationEpoch;
}

export function correlateMainPlaybackStatus(
  current: SpeechPlaybackCorrelationState,
  phase: "started" | "terminal",
  segment: SpeechSegmentIdentity
) {
  return correlateSpeechPlayback(current, phase, segment);
}

export function voicePlaybackStatusLabel(
  status: VoicePlaybackStatus,
  actualPlaybackActive = false
): string {
  if (actualPlaybackActive) return "Speaking…";
  switch (status) {
    case "synthesizing":
      return "Preparing speech…";
    case "playing":
      return actualPlaybackActive ? "Speaking…" : "Speech queued…";
    case "stopped":
      return "Speech stopped; generated text is preserved.";
    case "error":
      return "Speech unavailable; text response is preserved.";
    default:
      return "";
  }
}

function applyPlaybackStatus(
  state: CompanionPlaybackState,
  setStatus: (status: VoicePlaybackStatus) => void,
  setActive: (active: boolean) => void
): void {
  if (state === "started") {
    setStatus("playing");
    setActive(true);
    return;
  }
  setActive(false);
  if (state === "error") setStatus("error");
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
