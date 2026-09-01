import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  apiClient,
  type DashboardWebSocketMessage,
  type HealthResponse,
  type MemoryRecord,
  type ProviderCapability,
  type ProviderChainInspectionResponse,
  type ProviderHealth,
  type ProviderRouteHealth,
  type ProviderVerificationResponse,
  type PromptPreviewResponse,
  type ProvidersStatusResponse,
  type RuntimeEvent
} from "./api/client.js";
import {
  cachedObservationDetail,
  providerAttemptLabel,
  providerObservationLabel,
  providerReadinessLabel
} from "./provider-diagnostics.js";
import { promptPreviewPlaceholder } from "./data/mock.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import {
  normalizeVisionImageMimeType,
  toVisionFileInput,
  type VisionImageMimeType
} from "./vision-input.js";
import {
  Definition,
  EmptyState,
  Field,
  Notice,
  PageShell,
  Panel,
  Pill,
  StatusCard,
  StatusDot,
  Toggle
} from "./dashboard-ui.js";
import {
  formatLatency,
  formatTokenUsage,
  ProviderVerificationResult
} from "./dashboard-provider-verification.js";
import { formatDate } from "./dashboard-format.js";
import { EventTable } from "./dashboard-events.js";
import { MemoryTable } from "./dashboard-memory-table.js";
import { formatRankComponents, shortTrace } from "./dashboard-memory-view.js";
import { memoryModeFromHealth } from "./dashboard-memory-health.js";
import { MemoryCandidateList } from "./dashboard-memory-candidates.js";
import { EventsPage } from "./pages/events-page.js";
import { MemoryPage } from "./pages/memory-page.js";
import { SettingsPage } from "./pages/settings-page.js";
import { ChatPage } from "./pages/chat-page.js";
import {
  dashboardVoicePlaybackStatusLabel,
  deriveDashboardTtsPolicy,
  flushDashboardSpeechTail
} from "./dashboard-chat-speech.js";
import { CompanionBus } from "./companion-bus.js";
import { createEmbodiedPresentationRequest } from "@companion/protocol";

export { dashboardVoicePlaybackStatusLabel, deriveDashboardTtsPolicy, flushDashboardSpeechTail };

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
  const embodiedBusRef = useRef<CompanionBus | null>(null);
  useEffect(() => {
    const bus = new CompanionBus("main");
    embodiedBusRef.current = bus;
    return () => {
      bus.close();
      embodiedBusRef.current = null;
    };
  }, []);
  const [eventsPaused, setEventsPaused] = useState(false);
  const wsStatus = useDashboardEventStream({
    paused: eventsPaused,
    onEvent: (event) => {
      setLiveEvents((current) => [event, ...current].slice(0, 100));
      if (event.type === "runtime.embodied.presentation.request") {
        try {
          const request = createEmbodiedPresentationRequest(event.payload);
          embodiedBusRef.current?.post({ kind: "embodied-presentation-request", request });
        } catch {
          // Dashboard transport must fail closed on malformed Runtime input.
        }
      }
    }
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
function formatIncludedScopes(scopes: Array<{ scope: string; scopeId?: string | null }>): string {
  if (scopes.length === 0) {
    return "none";
  }

  return scopes
    .map((entry) => `${entry.scope}${entry.scopeId ? `:${entry.scopeId}` : ""}`)
    .join(", ");
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

function providerPreviewDetail(
  promptPreview: NonNullable<PromptPreviewResponse["promptPreview"]>,
  response: PromptPreviewResponse | null | undefined
): string {
  const model = promptPreview.providerModel ?? response?.providerModel ?? "unknown model";
  const mock = promptPreview.providerMock ?? response?.providerMock;
  const latency = promptPreview.providerLatencyMs ?? response?.providerLatencyMs;
  return `${mock ? "mock" : "real/unverified"} · ${model} · ${formatLatency(latency)}`;
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
