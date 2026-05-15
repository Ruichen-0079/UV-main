import { useEffect, useMemo, useRef, useState } from "react";
import { apiClient, type DashboardWebSocketMessage, type HealthResponse, type MemoryRecord, type PromptPreviewResponse, type ProvidersStatusResponse, type RuntimeEvent } from "./api/client.js";
import { promptPreviewPlaceholder } from "./data/mock.js";
import { useAsyncData } from "./hooks/useAsyncData.js";

type PageId = "overview" | "chat" | "memory" | "providers" | "events" | "prompt" | "voice" | "vision" | "settings";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  traceId?: string;
  useMemory?: boolean;
  voiceOutput?: boolean;
  providerKind?: string;
};

type WebSocketStatus = "connecting" | "connected" | "disconnected" | "reconnecting" | "paused" | "error";
type RequestStatus = "idle" | "sending" | "success" | "error";
type MemoryResultSource = "/memory/recent" | "/memory/search" | "local fallback";

const pages: Array<{ id: PageId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "memory", label: "Memory" },
  { id: "providers", label: "Providers" },
  { id: "events", label: "Events" },
  { id: "prompt", label: "Prompt Preview" },
  { id: "voice", label: "Voice" },
  { id: "vision", label: "Vision" },
  { id: "settings", label: "Settings" }
];

export function App(): JSX.Element {
  const [activePage, setActivePage] = useState<PageId>("overview");
  const health = useAsyncData(() => apiClient.getHealth(), []);
  const providerStatus = useAsyncData(() => apiClient.getProviderStatus(), []);
  const memories = useAsyncData(() => apiClient.listRecentMemories(20), []);
  const eventState = useAsyncData(() => apiClient.listRecentEvents(50), []);
  const [localEvents, setLocalEvents] = useState<RuntimeEvent[]>([]);
  const [liveEvents, setLiveEvents] = useState<RuntimeEvent[]>([]);
  const [eventsPaused, setEventsPaused] = useState(false);
  const wsStatus = useDashboardEventStream({
    paused: eventsPaused,
    onEvent: (event) => setLiveEvents((current) => [event, ...current].slice(0, 100))
  });

  const events = useMemo(() => mergeEvents(liveEvents, localEvents, eventState.data?.events ?? []), [eventState.data?.events, liveEvents, localEvents]);
  const recentEvents = useMemo(() => events.slice(0, 8), [events]);

  return (
    <div className="flex h-screen min-h-[720px] bg-ink-100">
      <aside className="flex w-60 shrink-0 flex-col border-r border-ink-200 bg-white">
        <div className="border-b border-ink-200 px-4 py-4">
          <div className="text-sm font-semibold text-ink-500">YUVI Runtime</div>
          <h1 className="mt-1 text-lg font-semibold text-ink-900">Developer Dashboard</h1>
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
        <TopStatusBar health={health.data} loading={health.loading} error={health.error} onRefresh={health.refresh} />
        <main className="min-h-0 flex-1 overflow-auto p-5">
          {activePage === "overview" && (
            <OverviewPage
              health={health}
              wsStatus={wsStatus}
              recentEvents={recentEvents}
              memories={memories.data?.memories ?? []}
            />
          )}
          {activePage === "chat" && <ChatPage onEvent={(event) => setLocalEvents((current) => [event, ...current])} />}
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
          {activePage === "voice" && <CapabilityPlaceholder title="Voice" status="Not implemented" />}
          {activePage === "vision" && <CapabilityPlaceholder title="Vision" status="Not implemented" />}
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
  onRefresh(): Promise<void>;
}): JSX.Element {
  const status = props.loading ? "loading" : props.error ? "error" : props.health?.ok ? "healthy" : "degraded";

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
      {props.health.loading && <Notice tone="info" title="Loading" message="Fetching runtime health from the backend." />}
      {props.health.error && <Notice tone="error" title="Backend error" message={props.health.error} />}
      <div className="grid grid-cols-4 gap-4">
        <StatusCard title="Server" status={props.health.data?.server.status ?? "unknown"} detail={`Runtime mode: ${props.health.data?.runtimeMode ?? "unknown"}`} />
        <StatusCard title="WebSocket" status={props.wsStatus} detail="Dashboard runtime event stream" />
        <StatusCard title="Memory" status={memoryModeFromHealth(props.health.data)} detail={props.health.data?.database.message ?? "No memory health yet"} />
        <StatusCard title="Providers" status={providerSummaryStatus(props.health.data)} detail={`Chat: ${props.health.data?.providers.chat.provider ?? "unknown"}`} />
      </div>
      <div className="grid grid-cols-[1.1fr_0.9fr] gap-4">
        <Panel title="Recent Events">
          <EventTable events={props.recentEvents} />
        </Panel>
        <Panel title="Recent Memories">
          {props.memories.length === 0 ? (
            <EmptyState title="No memories loaded" message="Create a memory or wait for runtime interactions." />
          ) : (
            <MemoryTable memories={props.memories.slice(0, 5)} compact />
          )}
        </Panel>
      </div>
    </PageShell>
  );
}

function ChatPage(props: { onEvent(event: RuntimeEvent): void }): JSX.Element {
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState("dashboard");
  const [useMemory, setUseMemory] = useState(true);
  const [voiceOutput, setVoiceOutput] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastTraceId, setLastTraceId] = useState<string | null>(null);

  const outgoingPayload = useMemo(() => ({
    text: input.trim() || "<message text>",
    options: {
      useMemory,
      voiceOutput
    }
  }), [input, useMemory, voiceOutput]);

  async function send(): Promise<void> {
    if (!input.trim()) {
      return;
    }

    const content = input.trim();
    setInput("");
    setRequestStatus("sending");
    setError(null);
    setMessages((current) => [...current, { role: "user", content, useMemory, voiceOutput }]);

    try {
      const response = await apiClient.sendMessage({
        sessionId,
        text: content,
        options: {
          useMemory,
          voiceOutput
        }
      });
      props.onEvent(response);
      setLastTraceId(response.traceId);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: response.reply || response.payload.content || "No assistant content returned.",
          traceId: response.traceId,
          providerKind: inferProviderKind(response)
        }
      ]);
      setRequestStatus("success");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Message request failed");
      setRequestStatus("error");
    } finally {
      // Keep success/error visible after the request completes.
    }
  }

  return (
    <PageShell title="Chat" subtitle="Send text turns through the runtime server.">
      <div className="grid grid-cols-[1fr_280px] gap-4">
        <Panel title="Chat History" actions={<Pill status={requestStatus} />}>
          <div className="h-[420px] overflow-auto rounded-md border border-ink-100 bg-ink-50 p-3">
            {messages.length === 0 ? (
              <EmptyState title="No chat yet" message="Send a message to exercise the runtime." />
            ) : (
              <div className="space-y-3">
                {messages.map((message, index) => (
                  <div key={`${message.role}-${index}`} className={`rounded-md border p-3 ${message.role === "user" ? "border-cyan-100 bg-white" : "border-ink-200 bg-white"}`}>
                    <div className="mb-1 text-xs font-semibold uppercase text-ink-500">{message.role}</div>
                    <div className="text-sm leading-6">{message.content}</div>
                    {message.traceId && <div className="mt-2 font-mono text-xs text-ink-500">traceId: {message.traceId}</div>}
                    {message.role === "user" && message.useMemory !== undefined && (
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink-500">
                        <span>memory: {message.useMemory ? "enabled" : "disabled"}</span>
                        <span>voice output: {message.voiceOutput ? "enabled" : "disabled"}</span>
                      </div>
                    )}
                    {message.role === "assistant" && message.providerKind && (
                      <div className="mt-2 text-xs text-ink-500">provider signal: {message.providerKind}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {error && <Notice tone="error" title="Send failed" message={error} />}
          {lastTraceId && <Notice tone="info" title="Latest trace" message={`${lastTraceId}. Open Prompt Preview to inspect the generated prompt for the latest turn.`} />}
          <div className="mt-3 flex gap-2">
            <textarea
              className="field min-h-20"
              placeholder="Type a runtime test message"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <button className="button-primary h-20 w-24" disabled={requestStatus === "sending" || !input.trim()} onClick={() => void send()}>
              {requestStatus === "sending" ? "Sending" : "Send"}
            </button>
          </div>
        </Panel>
        <Panel title="Turn Options">
          <div className="space-y-4">
            <Field label="Session ID">
              <input className="field" value={sessionId} onChange={(event) => setSessionId(event.target.value)} />
            </Field>
            <Toggle label="Use memory" checked={useMemory} onChange={setUseMemory} note="Sent as options.useMemory to /message." />
            <Toggle label="TTS output" checked={voiceOutput} onChange={setVoiceOutput} note="Sent as voiceOutput to /message." />
            <div className="rounded-md border border-ink-100 bg-ink-50 p-3">
              <div className="label mb-2">Outgoing Payload</div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-700">{JSON.stringify(outgoingPayload, null, 2)}</pre>
            </div>
            <p className="text-xs leading-5 text-ink-500">
              After sending, Prompt Preview shows the latest prompt sections and memory usage for the returned trace.
            </p>
          </div>
        </Panel>
      </div>
    </PageShell>
  );
}

function MemoryPage(props: { state: ReturnType<typeof useAsyncData<{ memories: MemoryRecord[] }>>; health: HealthResponse | null }): JSX.Element {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [searchMemories, setSearchMemories] = useState<MemoryRecord[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [resultSource, setResultSource] = useState<MemoryResultSource>("/memory/recent");
  const [content, setContent] = useState("");
  const [type, setType] = useState("semantic");
  const [importance, setImportance] = useState("0.5");
  const [source, setSource] = useState("dashboard");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);
  const memoryMode = memoryModeFromHealth(props.health);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchMemories(null);
      setSearchError(null);
      setSearchLoading(false);
      setResultSource("/memory/recent");
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      void apiClient.searchMemories(trimmed, { type: typeFilter, limit: 50 })
        .then((result) => {
          setSearchMemories(result.memories);
          setResultSource("/memory/search");
        })
        .catch((caught) => {
          if (!controller.signal.aborted) {
            setSearchError(caught instanceof Error ? caught.message : "Memory search failed");
            setSearchMemories(null);
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
  }, [query, typeFilter]);

  const sourceMemories = searchMemories ?? props.state.data?.memories ?? [];
  const memories = sourceMemories.filter((memory) => {
    const matchesType = typeFilter === "all" || memory.type === typeFilter;
    const matchesQuery = searchMemories !== null || query === "" || memory.content.toLowerCase().includes(query.toLowerCase());
    return matchesType && matchesQuery;
  });

  async function createMemory(): Promise<void> {
    if (!content.trim()) {
      return;
    }

    setError(null);
    try {
      const createInput = {
        type,
        content: content.trim(),
        source,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean)
      };
      const parsedImportance = parseImportance(importance);
      await apiClient.createMemory(parsedImportance === undefined
        ? createInput
        : { ...createInput, importance: parsedImportance });
      setContent("");
      setTags("");
      await props.state.refresh();
      if (query.trim()) {
        const result = await apiClient.searchMemories(query.trim(), { type: typeFilter, limit: 50 });
        setSearchMemories(result.memories);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Create memory failed");
    }
  }

  return (
    <PageShell title="Memory" subtitle="Inspect and create development memories.">
      <div className="grid grid-cols-3 gap-4">
        <StatusCard title="Repository" status={memoryMode} detail={memoryModeDetail(memoryMode)} />
        <StatusCard title="Result Source" status={resultSource} detail={query.trim() ? "Search query is active" : "Showing recent memories"} />
        <StatusCard title="Records Shown" status={String(memories.length)} detail={props.state.error ?? searchError ?? "Current filtered result count"} />
      </div>
      <div className="grid grid-cols-[1fr_340px] gap-4">
        <Panel title="Recent Memories">
          <div className="mb-3 grid grid-cols-[1fr_180px] gap-3">
            <input className="field" placeholder="Search memory content" value={query} onChange={(event) => setQuery(event.target.value)} />
            <select className="field" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
              <option value="all">All types</option>
              <option value="working">working</option>
              <option value="episodic">episodic</option>
              <option value="semantic">semantic</option>
              <option value="emotional">emotional</option>
              <option value="procedural">procedural</option>
            </select>
          </div>
          {(props.state.loading || searchLoading) && <Notice tone="info" title="Loading" message={query.trim() ? "Searching memories." : "Fetching recent memories."} />}
          {props.state.error && <Notice tone="error" title="Memory load failed" message={props.state.error} />}
          {searchError && <Notice tone="error" title="Memory search failed" message={`${searchError}. Showing local recent-memory fallback if available.`} />}
          {!props.state.loading && memories.length === 0 ? <EmptyState title="No matching memories" message="Create a memory or adjust the filter." /> : <MemoryTable memories={memories} />}
        </Panel>
        <Panel title="Create Memory">
          <div className="space-y-3">
            <Field label="Type">
              <select className="field" value={type} onChange={(event) => setType(event.target.value)}>
                <option value="working">working</option>
                <option value="episodic">episodic</option>
                <option value="semantic">semantic</option>
                <option value="emotional">emotional</option>
                <option value="procedural">procedural</option>
              </select>
            </Field>
            <Field label="Content">
              <textarea className="field min-h-28" value={content} onChange={(event) => setContent(event.target.value)} />
            </Field>
            <Field label="Importance">
              <input className="field" type="number" min="0" max="1" step="0.1" value={importance} onChange={(event) => setImportance(event.target.value)} />
            </Field>
            <Field label="Source">
              <input className="field" value={source} onChange={(event) => setSource(event.target.value)} />
            </Field>
            <Field label="Tags">
              <input className="field" placeholder="comma,separated" value={tags} onChange={(event) => setTags(event.target.value)} />
            </Field>
            {error && <Notice tone="error" title="Create failed" message={error} />}
            <button className="button-primary w-full" onClick={() => void createMemory()} disabled={!content.trim()}>
              Create memory
            </button>
          </div>
        </Panel>
      </div>
    </PageShell>
  );
}

function ProvidersPage(props: { state: ReturnType<typeof useAsyncData<ProvidersStatusResponse>> }): JSX.Element {
  const rows = [
    { label: "DeepSeek Chat", capability: "chat", requirement: "Required", health: props.state.data?.providers.chat },
    { label: "DeepSeek Reasoning", capability: "reasoning", requirement: "Required", health: props.state.data?.providers.reasoning },
    { label: "xAI TTS", capability: "tts", requirement: "Optional", health: props.state.data?.providers.tts },
    { label: "xAI Vision", capability: "vision", requirement: "Optional / future UI", health: props.state.data?.providers.vision },
    { label: "Alibaba DashScope STT", capability: "stt", requirement: "Optional / future UI", health: props.state.data?.providers.stt },
    { label: "Embedding provider", capability: "embedding", requirement: "Required for vector memory later", health: props.state.data?.providers.embedding }
  ];

  return (
    <PageShell title="Providers" subtitle="Provider health without exposing keys or raw secret configuration.">
      {props.state.loading && <Notice tone="info" title="Loading" message="Fetching provider status." />}
      {props.state.error && <Notice tone="error" title="Provider health failed" message={props.state.error} />}
      <div className="grid grid-cols-3 gap-4">
        <StatusCard title="Chat" status={props.state.data?.providers.chat.status ?? "unknown"} detail={providerConfigurationHint(props.state.data?.providers.chat)} />
        <StatusCard title="Reasoning" status={props.state.data?.providers.reasoning.status ?? "unknown"} detail={providerConfigurationHint(props.state.data?.providers.reasoning)} />
        <StatusCard title="Optional Media" status={optionalProviderSummary(props.state.data)} detail="TTS, STT, and Vision are placeholders in the dashboard." />
      </div>
      <Panel title="Provider Status">
        <div className="overflow-auto rounded-md border border-ink-100">
          <table className="w-full border-collapse">
            <thead className="bg-ink-50">
              <tr>
                <th className="table-cell">Capability</th>
                <th className="table-cell">Requirement</th>
                <th className="table-cell">Provider</th>
                <th className="table-cell">Status</th>
                <th className="table-cell">Config</th>
                <th className="table-cell">Base URL</th>
                <th className="table-cell">Model</th>
                <th className="table-cell">Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className="table-cell font-medium">{row.label}</td>
                  <td className="table-cell text-ink-500">{row.requirement}</td>
                  <td className="table-cell">{row.health?.provider ?? "unknown"}</td>
                  <td className="table-cell"><Pill status={row.health?.status ?? "unknown"} /></td>
                  <td className="table-cell text-ink-500">{providerConfigurationHint(row.health)}</td>
                  <td className="table-cell text-ink-500">{row.health?.baseUrl ?? "Not exposed by status endpoint"}</td>
                  <td className="table-cell text-ink-500">{row.health?.model ?? "Not exposed by status endpoint"}</td>
                  <td className="table-cell text-ink-500">{row.health?.message ?? "No message"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </PageShell>
  );
}

function EventsPage(props: {
  events: RuntimeEvent[];
  paused: boolean;
  wsStatus: string;
  onTogglePaused(): void;
}): JSX.Element {
  const [filter, setFilter] = useState("all");
  const filtered = filter === "all" ? props.events : props.events.filter((event) => event.type === filter);
  const types = Array.from(new Set(props.events.map((event) => event.type)));

  return (
    <PageShell title="Events" subtitle="Recent runtime events from the server, with live WebSocket updates when connected.">
      <Panel title="Event Stream" actions={<button className="button-secondary" onClick={props.onTogglePaused}>{props.paused ? "Resume" : "Pause"}</button>}>
        <div className="mb-3 grid grid-cols-[220px_1fr] gap-3">
          <select className="field" value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="all">All event types</option>
            {types.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <div className="rounded-md border border-ink-200 px-3 py-2 text-sm text-ink-500">WebSocket status: {props.wsStatus}</div>
        </div>
        <EventTable events={filtered} />
      </Panel>
    </PageShell>
  );
}

function useDashboardEventStream({ paused, onEvent }: { paused: boolean; onEvent(event: RuntimeEvent): void }): WebSocketStatus {
  const [status, setStatus] = useState<WebSocketStatus>("connecting");
  const pausedRef = useRef(paused);
  const onEventRef = useRef(onEvent);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
    if (paused) {
      setStatus((current) => current === "connected" ? "paused" : current);
    } else {
      setStatus((current) => current === "paused" ? "connected" : current);
    }
  }, [paused]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let closedByEffect = false;
    let socket: WebSocket | null = null;

    function connect(): void {
      setStatus((current) => current === "disconnected" || current === "error" ? "reconnecting" : "connecting");
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

function isDashboardConnectedMessage(value: unknown): value is Extract<DashboardWebSocketMessage, { kind: "dashboard.connected" }> {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "dashboard.connected");
}

function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  return Boolean(value && typeof value === "object" && "id" in value && "type" in value && "traceId" in value && "payload" in value);
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
  const preview = useAsyncData(() => apiClient.getLatestPromptPreview(), []);
  const promptPreview = preview.data?.promptPreview;

  return (
    <PageShell title="Prompt Preview" subtitle="Latest development prompt preview from the runtime.">
      {preview.loading && <Notice tone="info" title="Loading" message="Fetching latest prompt preview." />}
      {preview.error && <Notice tone="error" title="Prompt preview failed" message={preview.error} />}
      {preview.data?.mock && <Notice tone="info" title="No prompt yet" message={preview.data.message ?? "Send a message first."} />}
      {promptPreview && (
        <div className="grid grid-cols-4 gap-3">
          <StatusCard title="Trace" status={shortTrace(promptPreview.traceId ?? preview.data?.traceId)} detail={formatDate(promptPreview.timestamp ?? preview.data?.timestamp ?? "")} />
          <StatusCard title="Memory" status={String(promptPreview.useMemory ?? preview.data?.useMemory ?? false)} detail={`Repository: ${promptPreview.memoryRepository ?? preview.data?.memoryRepository ?? "unknown"}`} />
          <StatusCard title="Retrieved" status={String(promptPreview.retrievedMemoryCount ?? preview.data?.retrievedMemoryCount ?? 0)} detail="memories used in prompt" />
          <StatusCard title="Tokens" status={String(promptPreview.estimatedTokens)} detail={promptPreview.truncated ? "Prompt truncated" : "Within budget"} />
        </div>
      )}
      <div className="grid grid-cols-3 gap-4">
        {promptSections(preview.data).map((section) => (
          <Panel key={section.title} title={section.title} {...(section.mock ? { badge: "Placeholder" } : {})}>
            <p className="text-sm leading-6 text-ink-600 whitespace-pre-wrap">{section.content}</p>
          </Panel>
        ))}
      </div>
      {promptPreview?.finalMessages && (
        <Panel title="Final Messages">
          <div className="max-h-[360px] space-y-3 overflow-auto">
            {promptPreview.finalMessages.map((message, index) => (
              <div key={`${message.role}-${index}`} className="rounded-md border border-ink-100 bg-ink-50 p-3">
                <div className="mb-1 text-xs font-semibold uppercase text-ink-500">{message.role}</div>
                <pre className="whitespace-pre-wrap text-xs leading-5 text-ink-700">{message.content}</pre>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </PageShell>
  );
}

function CapabilityPlaceholder(props: { title: string; status: string }): JSX.Element {
  return (
    <PageShell title={props.title} subtitle={`${props.title} debugging controls will be added after backend support exists.`}>
      <div className="grid grid-cols-3 gap-4">
        <StatusCard title={`${props.title} status`} status={props.status} detail="No backend endpoint yet" mock />
        <Panel title="Expected Controls" badge="Future">
          <ul className="space-y-2 text-sm text-ink-600">
            <li>Provider health and model metadata</li>
            <li>Input/output inspection without exposing secrets</li>
            <li>Runtime events emitted for each operation</li>
          </ul>
        </Panel>
      </div>
    </PageShell>
  );
}

function SettingsPage(): JSX.Element {
  return (
    <PageShell title="Settings" subtitle="Read-only local development settings.">
      <div className="grid grid-cols-2 gap-4">
        <Panel title="Runtime URLs">
          <Definition label="API proxy" value="/api" />
          <Definition label="Server" value="http://localhost:6121" />
          <Definition label="WebSocket" value="ws://localhost:6121/ws" />
        </Panel>
        <Panel title="Security">
          <p className="text-sm leading-6 text-ink-600">
            API keys are intentionally not displayed. Edit local `.env` outside the dashboard and never paste secrets into logs or issue reports.
          </p>
        </Panel>
      </div>
    </PageShell>
  );
}

function PageShell(props: { title: string; subtitle: string; children: React.ReactNode }): JSX.Element {
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

function Panel(props: { title: string; children: React.ReactNode; badge?: string; actions?: React.ReactNode }): JSX.Element {
  return (
    <section className="panel">
      <div className="flex min-h-12 items-center justify-between border-b border-ink-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{props.title}</h3>
          {props.badge && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">{props.badge}</span>}
        </div>
        {props.actions}
      </div>
      <div className="p-4">{props.children}</div>
    </section>
  );
}

function StatusCard(props: { title: string; status: string; detail: string; mock?: boolean }): JSX.Element {
  return (
    <div className="panel p-4">
      <div className="label">{props.title}</div>
      <div className="mt-3 flex items-center gap-2">
        <StatusDot status={props.status} />
        <div className="text-lg font-semibold">{props.status}</div>
      </div>
      <div className="mt-2 text-sm text-ink-500">{props.detail}</div>
      {props.mock && <div className="mt-3 text-xs font-medium text-amber-700">Mock / placeholder</div>}
    </div>
  );
}

function StatusDot(props: { status: string }): JSX.Element {
  const color = props.status === "healthy" ? "bg-emerald-500" : props.status === "loading" ? "bg-cyan-500" : props.status === "error" || props.status === "unavailable" ? "bg-rose-500" : "bg-amber-500";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />;
}

function Pill(props: { status: string }): JSX.Element {
  return <span className="inline-flex rounded-full bg-ink-100 px-2 py-1 text-xs font-semibold text-ink-700">{props.status}</span>;
}

function Notice(props: { tone: "info" | "error"; title: string; message: string }): JSX.Element {
  const styles = props.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-800" : "border-cyan-200 bg-cyan-50 text-cyan-800";
  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${styles}`}>
      <strong>{props.title}:</strong> {props.message}
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

function Toggle(props: { label: string; checked: boolean; onChange(value: boolean): void; note: string }): JSX.Element {
  return (
    <label className="flex items-start gap-3 rounded-md border border-ink-100 p-3">
      <input className="mt-1 h-4 w-4" type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
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

function memoryModeDetail(mode: string): string {
  if (mode === "in-memory") {
    return "Temporary storage; resets when the server restarts.";
  }
  if (mode === "postgres") {
    return "Persistent development storage after migrations are applied.";
  }
  return "Mode is inferred from /health and may need a server response update.";
}

function providerSummaryStatus(health: HealthResponse | null): string {
  if (!health) {
    return "unknown";
  }
  return health.providers.chat.status === "healthy" ? "healthy" : "degraded";
}

function optionalProviderSummary(status: ProvidersStatusResponse | null): string {
  if (!status) {
    return "unknown";
  }
  const optional = [status.providers.tts, status.providers.stt, status.providers.vision];
  return optional.every((provider) => provider.status === "healthy") ? "healthy" : "optional";
}

function providerConfigurationHint(health: ProvidersStatusResponse["providers"]["chat"] | undefined): string {
  if (!health) {
    return "Not configured";
  }
  if (health.message?.toLowerCase().includes("mock")) {
    return "Mock fallback";
  }
  if (health.status === "healthy") {
    return "Configured";
  }
  if (health.status === "unavailable") {
    return "Missing config or unavailable";
  }
  return "Check provider message";
}

function inferProviderKind(response: { reply?: string; mock?: boolean; provider?: string }): string {
  if (response.mock || response.reply?.startsWith("Mock reply")) {
    return "mock provider";
  }
  if (response.provider) {
    return response.provider;
  }
  return "not reported by API";
}

function parseImportance(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, parsed));
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
              <td className="table-cell text-ink-500">{formatDate(event.createdAt ?? event.timestamp ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemoryTable(props: { memories: MemoryRecord[]; compact?: boolean }): JSX.Element {
  return (
    <div className="max-h-[420px] overflow-auto rounded-md border border-ink-100">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-ink-50">
          <tr>
            <th className="table-cell">Type</th>
            <th className="table-cell">Content</th>
            {!props.compact && <th className="table-cell">Importance</th>}
            {!props.compact && <th className="table-cell">Tags</th>}
            <th className="table-cell">Created</th>
            {!props.compact && <th className="table-cell">Updated</th>}
          </tr>
        </thead>
        <tbody>
          {props.memories.map((memory) => (
            <tr key={memory.id}>
              <td className="table-cell">{memory.type}</td>
              <td className="table-cell">{memory.summary ?? memory.content}</td>
              {!props.compact && <td className="table-cell text-ink-500">{memory.importance.toFixed(2)}</td>}
              {!props.compact && <td className="table-cell text-ink-500">{memory.tags.join(", ") || "none"}</td>}
              <td className="table-cell text-ink-500">{formatDate(memory.createdAt)}</td>
              {!props.compact && <td className="table-cell text-ink-500">{formatDate(memory.updatedAt ?? "")}</td>}
            </tr>
          ))}
        </tbody>
      </table>
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

function promptSections(preview: PromptPreviewResponse | null): Array<{ title: string; content: string; mock?: boolean }> {
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
