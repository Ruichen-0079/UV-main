import type {
  ProductCapabilitiesSurface,
  ProductHealthItem,
  ProductMemoryOverview,
  ProductMemorySurface
} from "./product-client.js";

export type SurfaceTone = "ok" | "warn" | "bad" | "idle";

export type MemoryLayerCard = {
  id: "L0" | "L1" | "L2";
  name: string;
  summary: string;
  tone: SurfaceTone;
  countLabel: string;
  items: Array<{ id: string; title: string; meta?: string }>;
};

export type MemoryNormalView = {
  overall: { summary: string; tone: SurfaceTone; detail: string };
  backend: string;
  extractor?: string | undefined;
  databaseConfigured: boolean;
  episodeCount: number;
  durableCount: number;
  durableStatus: string;
  durableTone: SurfaceTone;
  epistemic?: string | undefined;
  dream: { status: string; operational: boolean; dueJobCount: number };
  layers: MemoryLayerCard[];
  searchEvents: Array<{ id: string; content: string; kind?: string }>;
  query: string | null;
  loadError?: string | undefined;
};

export function memoryNormalView(input: {
  overview: ProductMemoryOverview;
  surface: ProductMemorySurface | null;
  memoryHealth?: ProductHealthItem | undefined;
  loadError?: string | undefined;
}): MemoryNormalView {
  const episodes = input.surface?.l1.episodes ?? [];
  const events = input.surface?.l2.events ?? [];
  const epistemic = input.surface?.l2.epistemic;
  const durableTone = input.surface?.l2.tone ?? input.memoryHealth?.tone ?? "idle";
  const durableStatus = input.loadError
    ? "Unavailable"
    : (input.surface?.l2.summary ?? input.memoryHealth?.summary ?? "Unknown");
  const ingestion = input.overview.ingestion;
  const overallTone: SurfaceTone = input.loadError
    ? "bad"
    : (input.memoryHealth?.tone ?? (input.overview.databaseConfigured ? "ok" : "warn"));
  const overallSummary = input.loadError
    ? "Error"
    : (input.memoryHealth?.summary ??
      (input.overview.databaseConfigured ? "Ready" : "Not configured"));
  const detailParts = [
    input.memoryHealth?.detail,
    input.overview.databaseConfigured ? "Database configured" : "Database not configured",
    `Ingestion ${ingestion.status}`
  ];
  if (ingestion.pendingCount) detailParts.push(`${ingestion.pendingCount} pending`);
  if (ingestion.terminalFailedCount) detailParts.push(`${ingestion.terminalFailedCount} failed`);
  if (epistemic && epistemic !== "ok" && epistemic !== "empty") {
    detailParts.unshift(`Retrieval ${epistemic}`);
  }

  return {
    overall: {
      summary: overallSummary,
      tone: overallTone,
      detail: detailParts.filter(Boolean).join(" · ")
    },
    backend: input.overview.backend,
    extractor: input.overview.extractor,
    databaseConfigured: input.overview.databaseConfigured,
    episodeCount: episodes.length,
    durableCount: events.length,
    durableStatus,
    durableTone,
    epistemic,
    dream: {
      status: input.overview.idleDream.operational
        ? "Runtime-active"
        : input.overview.idleDream.classification,
      operational: input.overview.idleDream.operational,
      dueJobCount: input.surface?.dream.dueJobs.length ?? 0
    },
    layers: [
      {
        id: "L0",
        name: "DirectContext",
        summary: input.surface?.l0.description ?? "Near-verbatim recent completed turns.",
        tone: "idle",
        countLabel: "Working context",
        items: []
      },
      {
        id: "L1",
        name: "Episodes",
        summary:
          episodes.length === 0
            ? "No recent episodes in the ledger."
            : `${episodes.length} recent episode${episodes.length === 1 ? "" : "s"}.`,
        tone: episodes.length > 0 ? "ok" : "idle",
        countLabel: `${episodes.length} episodes`,
        items: episodes.slice(0, 6).map((episode) => ({
          id: episode.id,
          title: episode.whatHappened || episode.id,
          meta: [episode.status, episode.temporalConfidence].filter(Boolean).join(" · ")
        }))
      },
      {
        id: "L2",
        name: "Durable memory",
        summary: input.surface?.l2.query
          ? durableStatus
          : "Search to inspect durable MemoryEvent evidence.",
        tone: input.surface?.l2.query ? durableTone : "idle",
        countLabel: input.surface?.l2.query ? `${events.length} matches` : "Search required",
        items: events.slice(0, 8).map((event) => ({
          id: event.id,
          title: event.content,
          ...(event.kind ? { meta: event.kind } : {})
        }))
      }
    ],
    searchEvents: events,
    query: input.surface?.l2.query ?? null,
    loadError: input.loadError
  };
}

export type CapabilityRow = {
  name: string;
  capabilityRef: string;
  description: string;
  status: string;
};

function capabilityDescriptionMap(
  descriptions: ProductCapabilitiesSurface["descriptions"] | undefined
): Record<string, string> {
  if (!descriptions) return {};
  if (Array.isArray(descriptions)) {
    const mapped: Record<string, string> = {};
    for (const item of descriptions) {
      if (item.capabilityRef) mapped[item.capabilityRef] = item.description;
    }
    return mapped;
  }
  return descriptions;
}

export function capabilityNormalView(surface: ProductCapabilitiesSurface | null): {
  editable: boolean;
  notice: string;
  rows: CapabilityRow[];
} {
  if (!surface) {
    return {
      editable: false,
      notice: "Capability discovery has not loaded yet.",
      rows: []
    };
  }
  const descriptions = capabilityDescriptionMap(surface.descriptions);
  return {
    editable: surface.userConfigurableServers,
    notice: surface.userConfigurableServers ? surface.authority : surface.deferredReason,
    rows: surface.capabilities.map((binding) => ({
      name: binding.toolName,
      capabilityRef: binding.capabilityRef,
      description: descriptions[binding.capabilityRef] ?? "No description provided.",
      status: "Allowlisted"
    }))
  };
}
