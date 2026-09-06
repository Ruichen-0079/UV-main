import { useEffect, useRef, useState } from "react";
import {
  apiClient,
  type ProviderAttempt,
  type ProviderChainInspectionResponse,
  type ProviderHealth,
  type ProviderRouteHealth,
  type ProvidersStatusResponse,
  type RuntimeSettingsResponse,
  type RuntimeSettingsReloadResponse,
  type RuntimeSettingsUpdateResponse
} from "./api/client.js";
import {
  providerAttemptLabel,
  providerObservationLabel,
  providerReadinessLabel,
  verificationModeExplanation,
  verificationModeLabel
} from "./provider-diagnostics.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { productSettingValue } from "./product-models-providers.js";

export type ProductRoutingCapability = "chat" | "reasoning" | "embedding";

export type ProductRoutingDefinition = {
  capability: ProductRoutingCapability;
  label: string;
  settingKey: "CHAT_PROVIDER_CHAIN" | "REASONING_PROVIDER_CHAIN" | "EMBEDDING_PROVIDER_CHAIN";
  description: string;
};

export const PRODUCT_ROUTING_DEFINITIONS: ProductRoutingDefinition[] = [
  {
    capability: "chat",
    label: "Chat",
    settingKey: "CHAT_PROVIDER_CHAIN",
    description: "The Runtime chain used for assistant replies, tried left to right."
  },
  {
    capability: "reasoning",
    label: "Reasoning",
    settingKey: "REASONING_PROVIDER_CHAIN",
    description: "The Runtime chain used for reasoning and cognition, tried left to right."
  },
  {
    capability: "embedding",
    label: "Embedding",
    settingKey: "EMBEDDING_PROVIDER_CHAIN",
    description: "The Runtime chain used for memory embeddings; changes may require restart."
  }
];

const PROVIDER_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  "openai-compatible": "OpenAI-compatible",
  nvidia: "NVIDIA",
  local: "Local",
  mock: "Mock",
  unavailable: "Unavailable"
};

function definitionFor(capability: ProductRoutingCapability): ProductRoutingDefinition {
  return PRODUCT_ROUTING_DEFINITIONS.find((item) => item.capability === capability)!;
}

export function productRoutingSetting(
  settings: RuntimeSettingsResponse | null | undefined,
  capability: ProductRoutingCapability
): { value: string; source: string } {
  const definition = definitionFor(capability);
  const setting = settings?.settings[definition.settingKey];
  return {
    value: productSettingValue(settings, definition.settingKey),
    source: setting?.source ?? "unknown"
  };
}

function normalizedChain(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function productActiveRoutingRoutes(
  providerStatus: ProvidersStatusResponse | null | undefined,
  capability: ProductRoutingCapability
): ProviderRouteHealth[] | null {
  const routes = providerStatus?.routes?.[capability];
  return routes && routes.length > 0 ? routes : null;
}

export type ProductRoutingTruth = {
  savedChain: string;
  savedSource: string;
  activeChain: string | null;
  activeMatchesSaved: boolean | null;
  activeProvider: string;
  activeModel?: string;
  pendingRestart: boolean;
};

export function productRoutingTruth(
  settings: RuntimeSettingsResponse | null | undefined,
  providerStatus: ProvidersStatusResponse | null | undefined,
  capability: ProductRoutingCapability
): ProductRoutingTruth {
  const saved = productRoutingSetting(settings, capability);
  const routes = productActiveRoutingRoutes(providerStatus, capability);
  const activeChain = routes?.map((route) => route.provider).join(",") ?? null;
  const savedEntries = normalizedChain(saved.value);
  const activeEntries = routes?.map((route) => route.provider) ?? null;
  const selected = providerStatus?.providers[capability];
  const selectedRoute = routes?.find((route) => route.provider === selected?.provider);
  const activeModel = selected?.model ?? selectedRoute?.model;

  return {
    savedChain: saved.value,
    savedSource: saved.source,
    activeChain,
    activeMatchesSaved:
      savedEntries.length > 0 && activeEntries !== null
        ? savedEntries.length === activeEntries.length &&
          savedEntries.every((entry, index) => entry === activeEntries[index])
        : null,
    activeProvider: selected?.provider ?? "unknown",
    ...(activeModel !== undefined ? { activeModel } : {}),
    pendingRestart: Boolean(settings?.restartRequired || settings?.runtime.pendingRestart)
  };
}

export function productRoutingMatchLabel(truth: ProductRoutingTruth): string {
  if (truth.activeMatchesSaved === true) return "Active route matches saved chain";
  if (truth.activeMatchesSaved === false) return "Saved chain differs from active route";
  if (!truth.activeChain) return "Active route order is unknown";
  if (!truth.savedChain.trim()) return "No explicit saved chain; active Runtime order is observed";
  return "Active route order could not be confirmed";
}

export type ProductRoutingRouteSummary = {
  provider: string;
  priority: number;
  enabled: boolean;
  fallbackEligible: boolean;
  readiness?: NonNullable<ProviderHealth["readiness"]>;
  observed?: NonNullable<ProviderHealth["observed"]>;
  model?: string;
  lastVerifiedAt?: string;
};

export function productRoutingRouteSummary(route: ProviderRouteHealth): ProductRoutingRouteSummary {
  return {
    provider: route.provider,
    priority: route.priority,
    enabled: route.enabled,
    fallbackEligible: route.fallbackEligible,
    ...(route.readiness !== undefined ? { readiness: route.readiness } : {}),
    ...(route.observed !== undefined ? { observed: route.observed } : {}),
    ...(route.model ? { model: route.model } : {}),
    ...(route.lastVerifiedAt ? { lastVerifiedAt: route.lastVerifiedAt } : {})
  };
}

function routingStateTone(
  status: Pick<ProviderHealth, "readiness" | "observed"> | undefined
): "ok" | "warn" | "bad" | "idle" {
  if (!status) return "idle";
  if (status.readiness === "not_ready" || status.observed === "unavailable") return "bad";
  if (status.observed === "degraded") return "warn";
  if (status.observed === "available") return "ok";
  return "warn";
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function safeRoutingError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Request failed";
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
    .replace(/(api[-_]?key|authorization|token|password|secret)=([^&\s]+)/gi, "$1=[REDACTED]")
    .slice(0, 300);
}

export type ProductRoutingUpdateResult = {
  saved: RuntimeSettingsUpdateResponse;
  applied: RuntimeSettingsReloadResponse | null;
  applyError: string | null;
};

export async function updateProductRouting(
  capability: ProductRoutingCapability,
  chain: string
): Promise<ProductRoutingUpdateResult> {
  const definition = definitionFor(capability);
  const saved = await apiClient.updateRuntimeSettings({
    values: { [definition.settingKey]: chain }
  });
  try {
    return {
      saved,
      applied: await apiClient.reloadRuntimeSettings(),
      applyError: null
    };
  } catch (error) {
    return { saved, applied: null, applyError: safeRoutingError(error) };
  }
}

export function inspectProductRouting(
  capability: ProductRoutingCapability
): Promise<ProviderChainInspectionResponse> {
  return apiClient.verifyProviderChain(capability);
}

function RouteRow(props: {
  route: ProviderRouteHealth;
  inspectionAttempt?: ProviderAttempt;
}): JSX.Element {
  const summary = productRoutingRouteSummary(props.route);
  const tone = routingStateTone(summary);
  return (
    <div className={`yuvi-product-route-row is-${tone}`}>
      <div className="yuvi-product-route-priority">#{summary.priority}</div>
      <div className="yuvi-product-route-main">
        <div className="yuvi-product-route-title">
          <strong>{providerLabel(summary.provider)}</strong>
          <span>{summary.provider}</span>
        </div>
        <div className="yuvi-product-route-facts">
          <span>{providerReadinessLabel(summary.readiness)}</span>
          <span>{providerObservationLabel(summary.observed)}</span>
          <span>{summary.fallbackEligible ? "Fallback eligible" : "Not fallback eligible"}</span>
          {!summary.enabled ? <span>Disabled</span> : null}
        </div>
        {summary.model ? <small>Model: {summary.model}</small> : null}
        {summary.lastVerifiedAt ? (
          <small>Last explicit check: {summary.lastVerifiedAt}</small>
        ) : null}
        {props.inspectionAttempt ? (
          <small>
            Inspection: {providerAttemptLabel(props.inspectionAttempt)}
            {props.inspectionAttempt.errorCode
              ? ` · error code: ${props.inspectionAttempt.errorCode}`
              : ""}
          </small>
        ) : null}
      </div>
      <span className={`yuvi-product-route-badge is-${tone}`}>
        {summary.readiness === "ready"
          ? "Ready"
          : summary.readiness === "not_ready"
            ? "Not ready"
            : "Unknown"}
      </span>
    </div>
  );
}

function RouteList(props: {
  routes: ProviderRouteHealth[] | null;
  attemptedProviders?: ProviderAttempt[];
}): JSX.Element {
  if (!props.routes) {
    return (
      <div className="yuvi-product-route-unknown">
        unknown · current Runtime route list unavailable
      </div>
    );
  }

  return (
    <div className="yuvi-product-route-list">
      {props.routes.map((route, index) => (
        <RouteRow
          key={`${route.provider}-${route.priority}`}
          route={route}
          {...(props.attemptedProviders?.[index]
            ? { inspectionAttempt: props.attemptedProviders[index] }
            : {})}
        />
      ))}
    </div>
  );
}

function InspectionResult(props: { inspection: ProviderChainInspectionResponse }): JSX.Element {
  const inspection = props.inspection;
  return (
    <div className="yuvi-product-routing-inspection" role="status">
      <div className="yuvi-product-routing-inspection-header">
        <strong>Route inspection · config-only</strong>
        <span>{inspection.readyRouteCount} locally ready route(s)</span>
      </div>
      <p>{inspection.message}</p>
      <div className="yuvi-product-routing-inspection-mode">
        <strong>{verificationModeLabel(inspection)}</strong>
        <span>{verificationModeExplanation(inspection)}</span>
      </div>
      <RouteList routes={inspection.routes} attemptedProviders={inspection.attemptedProviders} />
    </div>
  );
}

export type ProductRoutingCardProps = {
  definition: ProductRoutingDefinition;
  settings: RuntimeSettingsResponse;
  providerStatus: ProvidersStatusResponse | null;
  draft: string;
  saving: boolean;
  inspecting: boolean;
  inspection: ProviderChainInspectionResponse | undefined;
  onChange(value: string): void;
  onSave(): void;
  onInspect(): void;
};

export function ProductRoutingCard(props: ProductRoutingCardProps): JSX.Element {
  const truth = productRoutingTruth(
    props.settings,
    props.providerStatus,
    props.definition.capability
  );
  const selectedStatus = props.providerStatus?.providers[props.definition.capability];
  const routeStatus = productActiveRoutingRoutes(props.providerStatus, props.definition.capability);
  const selectedTone = routingStateTone(selectedStatus);
  const matchTone =
    truth.activeMatchesSaved === false ? "bad" : truth.activeMatchesSaved === true ? "ok" : "warn";

  return (
    <section className="yuvi-product-routing-card">
      <header className="yuvi-product-routing-card-header">
        <div>
          <div className="yuvi-product-eyebrow">Capability</div>
          <h2>{props.definition.label}</h2>
          <p>{props.definition.description}</p>
        </div>
        <span className={`yuvi-product-route-badge is-${selectedTone}`}>
          {providerLabel(truth.activeProvider)}
        </span>
      </header>

      <div className="yuvi-product-routing-summary">
        <div>
          <span>Runtime default provider</span>
          <strong>{providerLabel(truth.activeProvider)}</strong>
          <small>
            {truth.activeModel ? `Default model: ${truth.activeModel}` : "Default model: unknown"}
          </small>
        </div>
        <div>
          <span>Readiness</span>
          <strong>{providerReadinessLabel(selectedStatus?.readiness)}</strong>
        </div>
        <div>
          <span>Cached observation</span>
          <strong>{providerObservationLabel(selectedStatus?.observed)}</strong>
        </div>
      </div>

      <label className="yuvi-product-routing-editor">
        <span>Saved / effective provider chain</span>
        <input
          aria-label={`${props.definition.label} provider chain`}
          value={props.draft}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder="provider-a,provider-b"
        />
        <small>
          Comma-separated priority order. Source: {truth.savedSource}. Runtime validates the
          provider names.
        </small>
      </label>

      <div className="yuvi-product-routing-truth">
        <div>
          <span>Active Runtime route order</span>
          <strong>
            {truth.activeChain ? truth.activeChain.split(",").join(" → ") : "unknown"}
          </strong>
        </div>
        <span className={`yuvi-product-route-badge is-${matchTone}`}>
          {productRoutingMatchLabel(truth)}
        </span>
      </div>

      {truth.pendingRestart ? (
        <div className="yuvi-product-routing-pending">
          Runtime reports a pending restart. Saved/effective settings remain visible; active route
          order remains the source of truth until Runtime applies the change.
        </div>
      ) : null}

      <div className="yuvi-product-routing-chain-heading">
        <strong>Current route chain</strong>
        <span>Read-only Runtime observation · no provider call on page load</span>
      </div>
      <RouteList routes={routeStatus} />

      <div className="yuvi-product-routing-actions">
        <button
          type="button"
          className="yuvi-product-button is-primary"
          disabled={props.saving || props.inspecting}
          onClick={props.onSave}
        >
          {props.saving ? "Saving…" : "Save & apply"}
        </button>
        <button
          type="button"
          className="yuvi-product-button"
          disabled={props.saving || props.inspecting}
          onClick={props.onInspect}
        >
          {props.inspecting ? "Inspecting…" : "Inspect route"}
        </button>
      </div>

      {props.inspection ? <InspectionResult inspection={props.inspection} /> : null}
    </section>
  );
}

export function ProductAIRouting(): JSX.Element {
  const settings = useAsyncData((signal) => apiClient.getRuntimeSettings(signal), []);
  const providerStatus = useAsyncData((signal) => apiClient.getProviderStatus(signal), []);
  const [draft, setDraft] = useState<Record<ProductRoutingCapability, string>>({
    chat: "",
    reasoning: "",
    embedding: ""
  });
  const [saving, setSaving] = useState<ProductRoutingCapability | null>(null);
  const [inspecting, setInspecting] = useState<ProductRoutingCapability | null>(null);
  const [inspections, setInspections] = useState<
    Partial<Record<ProductRoutingCapability, ProviderChainInspectionResponse>>
  >({});
  const [notice, setNotice] = useState<{
    tone: "info" | "warning" | "error";
    text: string;
  } | null>(null);
  const seededRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (settings.data && !seededRef.current) {
      setDraft({
        chat: productRoutingSetting(settings.data, "chat").value,
        reasoning: productRoutingSetting(settings.data, "reasoning").value,
        embedding: productRoutingSetting(settings.data, "embedding").value
      });
      seededRef.current = true;
    }
  }, [settings.data]);

  async function refreshSurfaces(): Promise<{
    settings: RuntimeSettingsResponse | null;
    providerStatus: ProvidersStatusResponse | null;
  }> {
    const [nextSettings, nextProviderStatus] = await Promise.all([
      settings.refresh(),
      providerStatus.refresh()
    ]);
    return { settings: nextSettings, providerStatus: nextProviderStatus };
  }

  async function save(capability: ProductRoutingCapability): Promise<void> {
    if (!settings.data || saving !== null) return;
    setSaving(capability);
    setNotice(null);
    const chain = draft[capability] ?? "";
    try {
      const result = await updateProductRouting(capability, chain);
      const refreshed = await refreshSurfaces();
      const nextSettings = refreshed.settings ?? result.saved.settings;
      const truth = productRoutingTruth(nextSettings, refreshed.providerStatus, capability);

      if (mountedRef.current) {
        setDraft((current) => ({
          ...current,
          [capability]: productRoutingSetting(nextSettings, capability).value
        }));
        if (result.applyError) {
          setNotice({
            tone: "warning",
            text: `Saved/effective, but Runtime apply failed: ${result.applyError}`
          });
        } else if (
          result.applied?.notHotReloaded.includes(definitionFor(capability).settingKey) ||
          truth.pendingRestart
        ) {
          setNotice({
            tone: "warning",
            text: `Saved/effective. Runtime reports restart required; active route remains ${truth.activeChain ?? "unknown"}.`
          });
        } else if (truth.activeMatchesSaved === true) {
          setNotice({
            tone: "info",
            text: `Saved and applied. Active route matches ${truth.activeChain ?? "unknown"}.`
          });
        } else if (truth.activeMatchesSaved === false) {
          setNotice({
            tone: "warning",
            text: `Saved/effective, but active route remains ${truth.activeChain ?? "unknown"}.`
          });
        } else {
          setNotice({
            tone: "info",
            text: `Saved/effective. Runtime reload completed; active route is ${truth.activeChain ?? "unknown"}.`
          });
        }
      }
    } catch (error) {
      if (mountedRef.current) {
        setNotice({ tone: "error", text: `Routing save failed: ${safeRoutingError(error)}` });
      }
    } finally {
      if (mountedRef.current) setSaving(null);
    }
  }

  async function inspect(capability: ProductRoutingCapability): Promise<void> {
    if (inspecting !== null) return;
    setInspecting(capability);
    setNotice(null);
    try {
      const result = await inspectProductRouting(capability);
      if (mountedRef.current) {
        setInspections((current) => ({ ...current, [capability]: result }));
      }
    } catch (error) {
      if (mountedRef.current) {
        setNotice({ tone: "error", text: `Route inspection failed: ${safeRoutingError(error)}` });
      }
    } finally {
      if (mountedRef.current) setInspecting(null);
    }
  }

  return (
    <section className="yuvi-product-routing">
      <header className="yuvi-product-page-header">
        <div>
          <div className="yuvi-product-eyebrow">Product settings</div>
          <h1>AI Routing</h1>
          <p>
            See the provider order Runtime actually exposes for Chat, Reasoning, and Embedding.
            Readiness is local configuration; observations are cached only after an explicit check.
          </p>
        </div>
        <div className="yuvi-product-provider-count">
          <span>Runtime chains</span>
          <strong>{PRODUCT_ROUTING_DEFINITIONS.length}</strong>
        </div>
      </header>

      <div className="yuvi-product-authority-note">
        <strong>Current Runtime authority</strong>
        <span>
          Save &amp; apply uses <code>/settings/runtime</code> and Runtime reload. Route inspection
          uses <code>/providers/verify-chain/:capability</code> and performs no provider I/O.
        </span>
      </div>

      <div className="yuvi-product-gap-note">
        Provider observations on this page are local/cache-only reads. Use the explicit Models &amp;
        Providers verification action when a live Chat, Reasoning, or Embedding check is needed.
        Fallback eligibility is the Runtime route-readiness projection; call-error fallback policy
        remains Runtime-owned.
      </div>

      {settings.loading && !settings.data ? (
        <div className="yuvi-product-inline-state">Loading current routing settings…</div>
      ) : null}
      {settings.error ? (
        <div className="yuvi-product-inline-state is-error" role="alert">
          Routing settings unavailable: {safeRoutingError(settings.error)}
        </div>
      ) : null}
      {providerStatus.error ? (
        <div className="yuvi-product-inline-state is-warning" role="alert">
          Runtime route observations unavailable: {safeRoutingError(providerStatus.error)}
        </div>
      ) : null}
      {notice ? (
        <div className={`yuvi-product-inline-state is-${notice.tone}`} role="status">
          {notice.text}
        </div>
      ) : null}

      {settings.data ? (
        <div className="yuvi-product-routing-grid">
          {PRODUCT_ROUTING_DEFINITIONS.map((definition) => (
            <ProductRoutingCard
              key={definition.capability}
              definition={definition}
              settings={settings.data!}
              providerStatus={providerStatus.data}
              draft={draft[definition.capability] ?? ""}
              saving={saving === definition.capability}
              inspecting={inspecting === definition.capability}
              inspection={inspections[definition.capability]}
              onChange={(value) =>
                setDraft((current) => ({ ...current, [definition.capability]: value }))
              }
              onSave={() => void save(definition.capability)}
              onInspect={() => void inspect(definition.capability)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
