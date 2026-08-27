import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import {
  apiClient,
  type AcceptMemoryCandidateRequest,
  type CreateMemoryRequest,
  type HealthResponse,
  type MemoryCandidateReview,
  type MemoryHealthSummary,
  type MemoryMaintenanceSchedulerStatus,
  type MemoryMaintenanceSummary,
  type MemoryRecord,
  type MemoryVectorIndexStatus,
  type RetrievedMemoryDebug,
  type UpdateMemoryRequest
} from "../api/client.js";
import { useAsyncData } from "../hooks/useAsyncData.js";
import {
  Definition,
  EmptyState,
  Field,
  Notice,
  PageShell,
  Panel,
  StatusCard
} from "../dashboard-ui.js";
import { formatDate } from "../dashboard-format.js";
import {
  formatRankComponents,
  formatScope,
  memoryPreview,
  shortTrace
} from "../dashboard-memory-view.js";
import { memoryModeFromHealth } from "../dashboard-memory-health.js";
import { MemoryTable } from "../dashboard-memory-table.js";
import { MemoryCandidateList } from "../dashboard-memory-candidates.js";

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

export function MemoryPage(props: {
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
