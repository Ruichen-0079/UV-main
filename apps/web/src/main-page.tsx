import { useEffect, useReducer, useRef, useState } from "react";
import { ApiError, apiClient, type MessageStreamEvent } from "./api/client.js";
import {
  beginControlledDraftSubmit,
  reduceChatMessages,
  shouldSubmitChatKey,
  type ChatMessage
} from "./chat-state.js";
import { ChatMessageContent } from "./markdown-message.js";
import { detectSpeechLanguage, type SpeechQueueState } from "./speech-queue.js";
import { SpeechSegmenter } from "./speech-segmenter.js";
import { CompanionBus, type CompanionBusMessage } from "./companion-bus.js";
import { EmptyState, Field, Notice, Panel, Pill, Toggle } from "./surface-ui.js";
import {
  readVoiceOutputPreference,
  writeVoiceOutputPreference
} from "./voice-output.js";
import { controlCompanionWindow, isTauriRuntime } from "./tauri-window.js";

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
  const [messages, dispatchMessages] = useReducer(reduceChatMessages, [] as ChatMessage[]);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastTraceId, setLastTraceId] = useState<string | null>(null);
  const [voicePlaybackStatus, setVoicePlaybackStatus] = useState<VoicePlaybackStatus>("idle");
  const [companionReady, setCompanionReady] = useState(false);
  const [input, setInput] = useState("");
  const [companionActionError, setCompanionActionError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busRef = useRef<CompanionBus | null>(null);
  const voiceOutputRef = useRef(voiceOutput);
  const speechSessionRef = useRef<{
    generation: string;
    segmenter: SpeechSegmenter;
    sequence: number;
    ended: boolean;
  } | null>(null);
  const activeRequestRef = useRef<{
    id: string;
    assistantId: string;
    controller: AbortController;
    completedObserved: boolean;
  } | null>(null);

  useEffect(() => {
    voiceOutputRef.current = voiceOutput;
  }, [voiceOutput]);

  useEffect(() => {
    mountedRef.current = true;
    const bus = new CompanionBus("main");
    busRef.current = bus;
    const unsubscribe = bus.subscribe((message: CompanionBusMessage) => {
      if (!mountedRef.current) return;
      if (message.kind === "companion-ready") {
        setCompanionReady(true);
        // A companion window may have been recreated; re-sync the current
        // voice-enabled preference so TTS state converges without a reload.
        bus.post({ kind: "voice-enabled", enabled: voiceOutputRef.current });
      } else if (message.kind === "speech-status") {
        setVoicePlaybackStatus(message.state);
      }
    });
    // Announce the persisted preference so a companion that is already open
    // (or opens later) starts with the same voice-enabled state.
    bus.post({ kind: "voice-enabled", enabled: voiceOutputRef.current });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      bus.close();
      busRef.current = null;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      speechSessionRef.current = null;
    };
  }, []);

  function updateVoiceOutput(enabled: boolean): void {
    setVoiceOutput(enabled);
    writeVoiceOutputPreference(enabled);
    voiceOutputRef.current = enabled;
    if (!enabled) setVoicePlaybackStatus("idle");
    busRef.current?.post({ kind: "voice-enabled", enabled });
  }

  async function send(): Promise<void> {
    // Capture the exact draft once, then clear the controlled state immediately
    // so async work never re-reads or restores the textarea contents.
    const submit = beginControlledDraftSubmit(input);
    if (submit === null || activeRequestRef.current) return;
    const content = submit.submittedText;
    setInput(submit.nextDraft);
    setError(null);
    inputRef.current?.focus();
    const requestId = createSurfaceId("turn");
    const assistantId = createSurfaceId("assistant");
    const controller = new AbortController();
    activeRequestRef.current = {
      id: requestId,
      assistantId,
      controller,
      completedObserved: false
    };
    setRequestStatus("sending");
    const bus = busRef.current;
    bus?.post({ kind: "user-gesture" });
    bus?.post({ kind: "voice-enabled", enabled: voiceOutputRef.current });
    bus?.post({ kind: "start-generation", requestId, sessionId });
    const segmenter = new SpeechSegmenter();
    if (voiceOutputRef.current) {
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
            if (!mountedRef.current || activeRequestRef.current?.id !== requestId) {
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
            forwardSpeechEnd(requestId, "completed");
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
      forwardSpeechEnd(requestId, "completed");
    } catch (caught) {
      if (!mountedRef.current || activeRequestRef.current?.id !== requestId) {
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
      if (activeRequestRef.current?.id === requestId) {
        activeRequestRef.current = null;
      }
      bus?.post({ kind: "generation-state", requestId, state: "idle" });
      speechSessionRef.current = null;
    }
  }

  function forwardSpeechSegments(requestId: string, text: string): void {
    const speech = speechSessionRef.current;
    const bus = busRef.current;
    if (!speech || speech.generation !== requestId || !bus) return;
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
    if (!active || active.completedObserved) return;
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
    const requestId = activeRequestRef.current?.id ?? "unknown";
    busRef.current?.post({ kind: "stop-speech", requestId });
    busRef.current?.post({ kind: "generation-state", requestId, state: "interrupted" });
    setVoicePlaybackStatus("stopped");
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
    <div className="min-h-screen bg-ink-100 p-6">
      <div className="mx-auto max-w-3xl space-y-4">
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
              {voicePlaybackStatusLabel(voicePlaybackStatus)}
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

function voicePlaybackStatusLabel(status: VoicePlaybackStatus): string {
  switch (status) {
    case "synthesizing":
      return "Preparing speech…";
    case "playing":
      return "Speaking…";
    case "stopped":
      return "Speech stopped; generated text is preserved.";
    case "error":
      return "Speech unavailable; text response is preserved.";
    default:
      return "";
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
