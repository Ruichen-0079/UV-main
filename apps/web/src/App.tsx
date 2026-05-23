import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  apiClient,
  type AcceptMemoryCandidateRequest,
  type CreateMemoryRequest,
  type DashboardWebSocketMessage,
  type HealthResponse,
  type LayeredSetting,
  type MemoryCandidateReview,
  type MemoryRecord,
  type ProviderCallMetadata,
  type ProviderVerificationResponse,
  type PromptPreviewResponse,
  type ProvidersStatusResponse,
  type RetrievedMemoryDebug,
  type RuntimeEvent,
  type RuntimeSettingsReloadResponse,
  type RuntimeSettingsResponse,
  type UpdateMemoryRequest
} from "./api/client.js";
import { promptPreviewPlaceholder } from "./data/mock.js";
import { useAsyncData } from "./hooks/useAsyncData.js";

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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  traceId?: string;
  useMemory?: boolean;
  readMemory?: boolean;
  writeMemory?: boolean;
  voiceOutput?: boolean;
  provider?: ProviderCallMetadata;
};

type WebSocketStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "paused"
  | "error";
type RequestStatus = "idle" | "sending" | "success" | "error";
type MemoryResultSource = "/memory/recent" | "/memory/search" | "local fallback";

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
  "workflow",
  "milestone",
  "emotion",
  "relationship"
];

const memoryScopes = ["user", "project", "agent", "plugin", "session"];
const memoryLayers = ["core", "recall", "archival", "working"];
const memoryStatuses = ["active", "superseded", "archived", "forgotten", "expired"];

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
          {activePage === "chat" && (
            <ChatPage onEvent={(event) => setLocalEvents((current) => [event, ...current])} />
          )}
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
          {activePage === "voice" && (
            <CapabilityPlaceholder title="Voice" status="Not implemented" />
          )}
          {activePage === "vision" && (
            <CapabilityPlaceholder title="Vision" status="Not implemented" />
          )}
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
        <StatusCard
          title="WebSocket"
          status={props.wsStatus}
          detail="Dashboard runtime event stream"
        />
        <StatusCard
          title="Memory"
          status={memoryModeFromHealth(props.health.data)}
          detail={props.health.data?.database.message ?? "No memory health yet"}
        />
        <StatusCard
          title="Providers"
          status={providerSummaryStatus(props.health.data)}
          detail={`Chat: ${props.health.data?.providers.chat.provider ?? "unknown"}`}
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

function ChatPage(props: { onEvent(event: RuntimeEvent): void }): JSX.Element {
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState("dashboard");
  const [readMemory, setReadMemory] = useState(true);
  const [writeMemory, setWriteMemory] = useState(true);
  const [promptPreview, setPromptPreview] = useState(true);
  const [voiceOutput, setVoiceOutput] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [requestStatus, setRequestStatus] = useState<RequestStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastTraceId, setLastTraceId] = useState<string | null>(null);

  const outgoingPayload = useMemo(
    () => ({
      text: input.trim() || "<message text>",
      options: {
        readMemory,
        writeMemory,
        promptPreview,
        voiceOutput
      }
    }),
    [input, promptPreview, readMemory, voiceOutput, writeMemory]
  );

  async function send(): Promise<void> {
    if (!input.trim()) {
      return;
    }

    const content = input.trim();
    setInput("");
    setRequestStatus("sending");
    setError(null);
    setMessages((current) => [
      ...current,
      {
        role: "user",
        content,
        useMemory: readMemory && writeMemory,
        readMemory,
        writeMemory,
        voiceOutput
      }
    ]);

    try {
      const response = await apiClient.sendMessage({
        sessionId,
        text: content,
        options: {
          readMemory,
          writeMemory,
          voiceOutput,
          promptPreview
        }
      });
      props.onEvent(response);
      setLastTraceId(response.traceId);
      const provider = response.provider ?? response.payload.provider;
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: response.reply || response.payload.content || "No assistant content returned.",
          traceId: response.traceId,
          ...(provider ? { provider } : {})
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
                  <div
                    key={`${message.role}-${index}`}
                    className={`rounded-md border p-3 ${message.role === "user" ? "border-cyan-100 bg-white" : "border-ink-200 bg-white"}`}
                  >
                    <div className="mb-1 text-xs font-semibold uppercase text-ink-500">
                      {message.role}
                    </div>
                    <div className="text-sm leading-6">{message.content}</div>
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
            />
            <button
              className="button-primary h-20 w-24"
              disabled={requestStatus === "sending" || !input.trim()}
              onClick={() => void send()}
            >
              {requestStatus === "sending" ? "Sending" : "Send"}
            </button>
          </div>
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
              note="Requests promptPreview metadata in the /message response."
            />
            <Toggle
              label="TTS output"
              checked={voiceOutput}
              onChange={setVoiceOutput}
              note="Sent as voiceOutput to /message."
            />
            <div className="rounded-md border border-ink-100 bg-ink-50 p-3">
              <div className="label mb-2">Outgoing Payload</div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap text-xs leading-5 text-ink-700">
                {JSON.stringify(outgoingPayload, null, 2)}
              </pre>
            </div>
            <p className="text-xs leading-5 text-ink-500">
              After sending, Prompt Preview shows the latest prompt sections and memory usage for
              the returned trace.
            </p>
          </div>
        </Panel>
      </div>
    </PageShell>
  );
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
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const candidates = useAsyncData(() => apiClient.listRecentMemoryCandidates(20), []);
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
      matchesImportance &&
      matchesQuery
    );
  });
  const sources = Array.from(new Set(sourceMemories.map((memory) => memory.source))).sort();

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
        <Panel title="Recent Memory Candidates" badge="Debug">
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
  const [verifying, setVerifying] = useState<"chat" | "reasoning" | null>(null);
  const [verification, setVerification] = useState<ProviderVerificationResponse | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const rows = [
    {
      label: "DeepSeek Chat",
      capability: "chat",
      requirement: "Required",
      health: props.state.data?.providers.chat
    },
    {
      label: "DeepSeek Reasoning",
      capability: "reasoning",
      requirement: "Required",
      health: props.state.data?.providers.reasoning
    },
    {
      label: "xAI TTS",
      capability: "tts",
      requirement: "Optional",
      health: props.state.data?.providers.tts
    },
    {
      label: "xAI Vision",
      capability: "vision",
      requirement: "Optional / future UI",
      health: props.state.data?.providers.vision
    },
    {
      label: "Alibaba DashScope STT",
      capability: "stt",
      requirement: "Optional / future UI",
      health: props.state.data?.providers.stt
    },
    {
      label: "Embedding provider",
      capability: "embedding",
      requirement: "Required for vector memory later",
      health: props.state.data?.providers.embedding
    }
  ];

  async function verify(capability: "chat" | "reasoning"): Promise<void> {
    setVerifying(capability);
    setVerification(null);
    setVerificationError(null);
    try {
      setVerification(await apiClient.verifyProvider(capability));
    } catch (caught) {
      setVerificationError(caught instanceof Error ? caught.message : "Provider verify failed");
    } finally {
      setVerifying(null);
    }
  }

  return (
    <PageShell
      title="Providers"
      subtitle="Provider health without exposing keys or raw secret configuration."
    >
      {props.state.loading && (
        <Notice tone="info" title="Loading" message="Fetching provider status." />
      )}
      {props.state.error && (
        <Notice tone="error" title="Provider health failed" message={props.state.error} />
      )}
      <div className="grid grid-cols-3 gap-4">
        <StatusCard
          title="Chat"
          status={props.state.data?.providers.chat.status ?? "unknown"}
          detail={providerConfigurationHint(props.state.data?.providers.chat)}
        />
        <StatusCard
          title="Reasoning"
          status={props.state.data?.providers.reasoning.status ?? "unknown"}
          detail={providerConfigurationHint(props.state.data?.providers.reasoning)}
        />
        <StatusCard
          title="Optional Media"
          status={optionalProviderSummary(props.state.data)}
          detail="TTS, STT, and Vision are placeholders in the dashboard."
        />
      </div>
      <Notice
        tone="info"
        title="Status meanings"
        message="configured=false + mock=true means the dashboard is using development mock fallback. configured=true + mock=false + degraded means config is present, but remote health is intentionally unverified. unavailable means the provider cannot be used with the current config."
      />
      <Panel
        title="Manual Verification"
        actions={
          <div className="flex gap-2">
            <button
              className="button-secondary"
              disabled={verifying !== null}
              onClick={() => void verify("chat")}
            >
              {verifying === "chat" ? "Verifying Chat" : "Verify Chat"}
            </button>
            <button
              className="button-secondary"
              disabled={verifying !== null}
              onClick={() => void verify("reasoning")}
            >
              {verifying === "reasoning" ? "Verifying Reasoning" : "Verify Reasoning"}
            </button>
          </div>
        }
      >
        <p className="mb-3 text-sm leading-6 text-ink-600">
          Verification is explicit and may call the selected provider. Results show only safe
          metadata; API keys and Authorization headers are never displayed.
        </p>
        {verificationError && (
          <Notice tone="error" title="Verification failed" message={verificationError} />
        )}
        {verification && <ProviderVerificationResult result={verification} />}
      </Panel>
      <Panel title="Provider Status">
        <div className="overflow-auto rounded-md border border-ink-100">
          <table className="w-full border-collapse">
            <thead className="bg-ink-50">
              <tr>
                <th className="table-cell">Capability</th>
                <th className="table-cell">Requirement</th>
                <th className="table-cell">Provider</th>
                <th className="table-cell">Status</th>
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
                  <td className="table-cell text-ink-500">{row.requirement}</td>
                  <td className="table-cell">{row.health?.provider ?? "unknown"}</td>
                  <td className="table-cell">
                    <Pill status={row.health?.status ?? "unknown"} />
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
  const preview = useAsyncData(() => apiClient.getLatestPromptPreview(), []);
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
        <Panel title="Memory Candidates from this turn" badge="Review">
          <MemoryCandidateList candidates={promptPreview.memoryCandidates} compact />
        </Panel>
      )}
    </PageShell>
  );
}

function CapabilityPlaceholder(props: { title: string; status: string }): JSX.Element {
  return (
    <PageShell
      title={props.title}
      subtitle={`${props.title} debugging controls will be added after backend support exists.`}
    >
      <div className="grid grid-cols-3 gap-4">
        <StatusCard
          title={`${props.title} status`}
          status={props.status}
          detail="No backend endpoint yet"
          mock
        />
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
  const settings = useAsyncData(() => apiClient.getRuntimeSettings(), []);
  const [form, setForm] = useState<SettingsForm>(() => emptySettingsForm());
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{
    changedKeys: string[];
    restartRequired: boolean;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<RuntimeSettingsReloadResponse | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<"chat" | "reasoning" | null>(null);
  const [verification, setVerification] = useState<ProviderVerificationResponse | null>(null);
  const [clearedSecrets, setClearedSecrets] = useState<Set<SettingsKey>>(() => new Set());

  useEffect(() => {
    if (settings.data) {
      setForm(settingsFormFromResponse(settings.data));
    }
  }, [settings.data]);

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    setSaveResult(null);
    try {
      const response = await apiClient.updateRuntimeSettings({
        values: buildSettingsUpdate(form, clearedSecrets)
      });
      setSaveResult({
        changedKeys: response.changedKeys,
        restartRequired: response.restartRequired
      });
      setForm(settingsFormFromResponse(response.settings));
      setClearedSecrets(new Set());
      await settings.refresh();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Settings update failed");
    } finally {
      setSaving(false);
    }
  }

  async function applyRuntimeConfig(): Promise<void> {
    setApplying(true);
    setApplyError(null);
    setApplyResult(null);
    try {
      const response = await apiClient.reloadRuntimeSettings();
      setApplyResult(response);
      setForm(settingsFormFromResponse(response.settings));
      setClearedSecrets(new Set());
      await settings.refresh();
    } catch (caught) {
      setApplyError(caught instanceof Error ? caught.message : "Runtime config reload failed");
    } finally {
      setApplying(false);
    }
  }

  async function verify(capability: "chat" | "reasoning"): Promise<void> {
    setVerifying(capability);
    setVerification(null);
    try {
      setVerification(await apiClient.verifyProvider(capability));
    } finally {
      setVerifying(null);
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
      (settings.data.memory.memoryRepository !== settings.data.memory.activeMemoryRepository ||
        settings.data.memory.memoryExtractor !== settings.data.memory.activeMemoryExtractor ||
        settings.data.runtime.serverHost !== settings.data.runtime.activeServerHost ||
        settings.data.runtime.serverPort !== settings.data.runtime.activeServerPort ||
        settings.data.runtime.eventBus !== settings.data.runtime.activeEventBus)
    );
  const configLayerKeys = [
    "SERVER_HOST",
    "SERVER_PORT",
    "EVENT_BUS",
    "MEMORY_REPOSITORY",
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

  return (
    <PageShell title="Settings" subtitle="Local development runtime configuration.">
      {settings.loading && (
        <Notice tone="info" title="Loading" message="Fetching safe runtime settings." />
      )}
      {settings.error && (
        <Notice tone="error" title="Settings load failed" message={settings.error} />
      )}
      {saveError && <Notice tone="error" title="Save failed" message={saveError} />}
      {applyError && <Notice tone="error" title="Apply failed" message={applyError} />}
      {saveResult && (
        <Notice
          tone="info"
          title="Saved to .env.local"
          message={`${saveResult.changedKeys.length || 0} field(s) changed. Click Apply Now to reload provider config without restarting. Memory/server setting changes may still require restart.`}
        />
      )}
      {applyResult && (
        <Notice
          tone="info"
          title="Applied to active runtime"
          message={`${applyResult.message} ${applyResult.restartRequired ? `Restart required for: ${applyResult.notHotReloaded.join(", ")}` : "No restart required for the applied provider config."}`}
        />
      )}
      {savedDeepSeekButRuntimeMock && (
        <Notice
          tone="info"
          title="Saved config is not active yet"
          message="DeepSeek config is saved, but active runtime is still mock. Click Apply Now or restart the server."
        />
      )}
      {savedConfigDiffersFromActive && (
        <Notice
          tone="info"
          title="Saved config differs from active runtime"
          message="Dashboard writes to .env.local. Click Apply Now to reload hot-reloadable provider config, or restart for memory/server boundary changes."
        />
      )}
      <div className="grid grid-cols-2 gap-4">
        <Panel title="Runtime">
          <SettingsInput form={form} name="SERVER_HOST" setForm={setForm} />
          <SettingsInput form={form} name="SERVER_PORT" setForm={setForm} />
          <SettingsInput form={form} name="EVENT_BUS" setForm={setForm} />
          <Definition
            label="Runtime mode"
            value={settings.data?.runtime.runtimeMode ?? "unknown"}
          />
          <p className="text-xs leading-5 text-ink-500">
            Active: {settings.data?.runtime.activeServerHost ?? "unknown"}:
            {settings.data?.runtime.activeServerPort ?? "unknown"} · event bus{" "}
            {settings.data?.runtime.activeEventBus ?? "unknown"}
          </p>
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
          </div>
        </Panel>
      </div>
      <Panel title="Active Runtime">
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
            value={settings.data?.memory.activeMemoryRepository ?? "unknown"}
          />
          <Definition
            label="Memory Extractor"
            value={`${settings.data?.memory.activeMemoryExtractor ?? "unknown"} / ${settings.data?.memory.memoryExtractorActive ?? "unknown"}`}
          />
        </div>
      </Panel>
      <Panel title="Config Layering">
        <Notice
          tone="info"
          title="How settings are saved"
          message=".env.local overrides .env. Dashboard writes to .env.local for safety and does not modify .env automatically."
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
                Verify Chat
              </button>
              <button
                className="button-secondary"
                disabled={verifying !== null}
                onClick={() => void verify("reasoning")}
              >
                Verify Reasoning
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
          {verification && <ProviderVerificationResult result={verification} />}
        </Panel>
        <Panel title="xAI" badge="Optional / placeholder">
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
        </Panel>
        <Panel title="DashScope / Embedding" badge="Optional / placeholder">
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
          <SettingsInput form={form} name="EMBEDDING_PROVIDER" setForm={setForm} />
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
      <div className="flex justify-end gap-3">
        <button
          className="button-secondary"
          disabled={applying}
          onClick={() => void applyRuntimeConfig()}
        >
          {applying ? "Applying" : "Apply Now / Reload Runtime Config"}
        </button>
        <button className="button-primary" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving" : "Save to .env.local"}
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
  | "MEMORY_REPOSITORY"
  | "MEMORY_EXTRACTOR"
  | "DEEPSEEK_API_BASEURL"
  | "DEEPSEEK_API_KEY"
  | "DEEPSEEK_CHAT_MODEL"
  | "DEEPSEEK_REASONING_MODEL"
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

function emptySettingsForm(): SettingsForm {
  return {
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: "6121",
    EVENT_BUS: "in-memory",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_EXTRACTOR: "llm",
    DEEPSEEK_API_BASEURL: "",
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_CHAT_MODEL: "",
    DEEPSEEK_REASONING_MODEL: "",
    XAI_API_BASEURL: "",
    XAI_API_KEY: "",
    XAI_TTS_MODEL: "",
    XAI_TTS_VOICE: "",
    XAI_VISION_MODEL: "",
    DASHSCOPE_API_BASEURL: "",
    DASHSCOPE_API_KEY: "",
    DASHSCOPE_STT_MODEL: "",
    EMBEDDING_PROVIDER: "mock",
    EMBEDDING_API_BASEURL: "",
    EMBEDDING_API_KEY: "",
    EMBEDDING_MODEL: "",
    EMBEDDING_DIMENSIONS: "1024"
  };
}

function settingsFormFromResponse(settings: RuntimeSettingsResponse): SettingsForm {
  return {
    SERVER_HOST: settings.runtime.serverHost,
    SERVER_PORT: String(settings.runtime.serverPort),
    EVENT_BUS: settings.runtime.eventBus,
    MEMORY_REPOSITORY: settings.memory.memoryRepository,
    MEMORY_EXTRACTOR: settings.memory.memoryExtractor ?? "llm",
    DEEPSEEK_API_BASEURL: settings.providers.deepseek.baseUrl,
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_CHAT_MODEL: settings.providers.deepseek.chatModel,
    DEEPSEEK_REASONING_MODEL: settings.providers.deepseek.reasoningModel,
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
      {props.mock && (
        <div className="mt-3 text-xs font-medium text-amber-700">Mock / placeholder</div>
      )}
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
  provider?: ProviderCallMetadata | undefined;
}): JSX.Element {
  const provider = props.provider;
  if (!provider) {
    return (
      <div className="mt-2 text-xs text-ink-500">
        provider: unknown · model: unknown · mode: unknown
      </div>
    );
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
      <span>provider: {provider.name}</span>
      <span>model: {provider.model ?? "unknown"}</span>
      <span>latency: {formatLatency(provider.latencyMs)}</span>
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
      <Definition label="Status" value={result.ok ? "ok" : "failed"} />
      <Definition label="Capability" value={result.capability} />
      <Definition label="Provider" value={result.provider} />
      <Definition label="Mode" value={result.mock ? "mock" : "real"} />
      <Definition label="Model" value={result.model ?? "unknown"} />
      <Definition label="Latency" value={formatLatency(result.latencyMs)} />
      {result.tokenUsage && (
        <div className="col-span-3">
          <Definition label="Token Usage" value={formatTokenUsage(result.tokenUsage)} />
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

function providerConfigurationHint(
  health: ProvidersStatusResponse["providers"]["chat"] | undefined
): string {
  if (!health) {
    return "Not configured";
  }
  if (health.mock) {
    return "Mock fallback";
  }
  if (health.configured) {
    return health.available ? "Configured, unverified" : "Configured, unavailable";
  }
  if (health.required) {
    return "Missing config or unavailable";
  }
  return "Optional, not configured";
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
	                    {debug?.matchedBy ?? "n/a"}
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
          {candidate.summary && (
            <p className="mt-2 text-xs text-ink-500">Summary: {candidate.summary}</p>
          )}
          <div className="mt-2 text-xs text-ink-500">
            Reason: {candidate.reason}
            {candidate.rejectedReason ? ` · Rejected: ${candidate.rejectedReason}` : ""}
          </div>
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
