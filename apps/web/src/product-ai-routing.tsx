import { ProductConfigurationPanel } from "./product-configuration.js";
import { AsyncProgress } from "./async-progress.js";
import { t } from "./locale.js";
import { useEffect, useRef, useState } from "react";
import {
  apiClient,
  type ProviderAttempt,
  type ProviderChainInspectionResponse,
  type ProviderHealth,
  type ProviderRouteHealth,
  type ProvidersStatusResponse,
  type RuntimeEvent,
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

export type ProductRoutingCapability =
  | "chat"
  | "reasoning"
  | "embedding"
  | "stt"
  | "tts"
  | "vision";

export type ProductRoutingDefinition = {
  capability: ProductRoutingCapability;
  label: string;
  settingKey:
    | "CHAT_PROVIDER_CHAIN"
    | "REASONING_PROVIDER_CHAIN"
    | "EMBEDDING_PROVIDER_CHAIN"
    | "STT_PROVIDER_CHAIN"
    | "TTS_PROVIDER_CHAIN"
    | "VISION_PROVIDER_CHAIN";
  description: string;
};

export const PRODUCT_ROUTING_DEFINITIONS: ProductRoutingDefinition[] = [
  {
    capability: "chat",
    label: t("Chat"),
    settingKey: "CHAT_PROVIDER_CHAIN",
    description: t("The Runtime chain used for assistant replies, tried left to right.")
  },
  {
    capability: "reasoning",
    label: t("Reasoning"),
    settingKey: "REASONING_PROVIDER_CHAIN",
    description: t("The Runtime chain used for reasoning and cognition, tried left to right.")
  },
  {
    capability: "embedding",
    label: t("Embedding"),
    settingKey: "EMBEDDING_PROVIDER_CHAIN",
    description: t("The legacy Runtime embedding chain. Mem0 uses its own fixed Ollama embedder.")
  },
  {
    capability: "stt",
    label: t("Speech recognition"),
    settingKey: "STT_PROVIDER_CHAIN",
    description: t("Choose local for the installed speech and acoustic profile service.")
  },
  {
    capability: "tts",
    label: t("Speech output"),
    settingKey: "TTS_PROVIDER_CHAIN",
    description:
      t("Optional speech output. Select a configured provider; this does not install or select a voice model.")
  },
  {
    capability: "vision",
    label: t("Vision"),
    settingKey: "VISION_PROVIDER_CHAIN",
    description:
      t("Current-screen evidence on demand. Grounding uses one provider attempt on the first route; configure it before use.")
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

export type ProductRoutingServedRoute = {
  capability: ProductRoutingCapability;
  provider: string;
  fallbackUsed: boolean | null;
  attemptedProviders: Array<Pick<ProviderAttempt, "provider" | "status">>;
  model?: string;
  observedAt?: string;
};

const PROVIDER_ATTEMPT_STATUSES = new Set<ProviderAttempt["status"]>([
  "skipped",
  "success",
  "failed",
  "unavailable"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function safeProviderAttempt(value: unknown): Pick<ProviderAttempt, "provider" | "status"> | null {
  if (!isRecord(value) || typeof value["provider"] !== "string") return null;
  const provider = value["provider"].trim();
  if (
    !provider ||
    typeof value["status"] !== "string" ||
    !PROVIDER_ATTEMPT_STATUSES.has(value["status"] as ProviderAttempt["status"])
  ) {
    return null;
  }
  return { provider, status: value["status"] as ProviderAttempt["status"] };
}

/**
 * Read only the safe provider fields already carried by a completed assistant
 * event. This intentionally ignores message content and provider error text.
 */
export function productRoutingServedRoute(
  events: RuntimeEvent[] | null | undefined,
  capability: ProductRoutingCapability
): ProductRoutingServedRoute | null {
  for (const event of events ?? []) {
    if (event.type !== "assistant.message" || !isRecord(event.payload)) continue;
    const provider = event.payload["provider"];
    if (!isRecord(provider) || provider["capability"] !== capability) continue;

    const finalProvider =
      typeof provider["finalProvider"] === "string" ? provider["finalProvider"].trim() : "";
    const name = typeof provider["name"] === "string" ? provider["name"].trim() : "";
    const servedProvider = finalProvider || name;
    if (!servedProvider) continue;

    const attemptedProviders = Array.isArray(provider["attemptedProviders"])
      ? provider["attemptedProviders"]
          .map(safeProviderAttempt)
          .filter(
            (attempt): attempt is Pick<ProviderAttempt, "provider" | "status"> => attempt !== null
          )
      : [];
    const model = typeof provider["model"] === "string" ? provider["model"].trim() : "";

    return {
      capability,
      provider: servedProvider,
      fallbackUsed: typeof provider["fallbackUsed"] === "boolean" ? provider["fallbackUsed"] : null,
      attemptedProviders,
      ...(model ? { model } : {}),
      ...(event.timestamp || event.createdAt
        ? { observedAt: event.timestamp ?? event.createdAt }
        : {})
    };
  }

  return null;
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
          <strong>{t(providerLabel(summary.provider))}</strong>
          <span>{summary.provider}</span>
        </div>
        <div className="yuvi-product-route-facts">
          <span>{t(providerReadinessLabel(summary.readiness))}</span>
          <span>{t(providerObservationLabel(summary.observed))}</span>
          <span>{summary.fallbackEligible ? t("Fallback eligible") : t("Not fallback eligible")}</span>
          {!summary.enabled ? <span>{t("Disabled")}</span> : null}
        </div>
        {summary.model ? <small>{t("Model:")}{" "}{summary.model}</small> : null}
        {summary.lastVerifiedAt ? (
          <small>{t("Last explicit check:")}{" "}{summary.lastVerifiedAt}</small>
        ) : null}
        {props.inspectionAttempt ? (
          <small>{t("Inspection:")}{" "}{t(providerAttemptLabel(props.inspectionAttempt))}
            {props.inspectionAttempt.errorCode
              ? t(" · error code: {0}", props.inspectionAttempt.errorCode)
              : ""}
          </small>
        ) : null}
      </div>
      <span className={`yuvi-product-route-badge is-${tone}`}>
        {summary.readiness === "ready"
          ? t("Ready")
          : summary.readiness === "not_ready"
            ? t("Not ready")
            : t("Unknown")}
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
      <div className="yuvi-product-route-unknown">{t("unknown · current Runtime route list unavailable")}</div>
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
        <strong>{t("Route inspection · config-only")}</strong>
        <span>{inspection.readyRouteCount}{t("locally ready route(s)")}</span>
      </div>
      <p>{inspection.message}</p>
      <div className="yuvi-product-routing-inspection-mode">
        <strong>{t(verificationModeLabel(inspection))}</strong>
        <span>{t(verificationModeExplanation(inspection))}</span>
      </div>
      <RouteList routes={inspection.routes} attemptedProviders={inspection.attemptedProviders} />
    </div>
  );
}

function servedRouteOutcome(route: ProductRoutingServedRoute | null): {
  label: string;
  tone: "ok" | "warn" | "idle";
} {
  if (!route || route.fallbackUsed === null) return { label: t("Unknown"), tone: "idle" };
  return route.fallbackUsed
    ? { label: t("Fallback used"), tone: "warn" }
    : { label: "Primary served", tone: "ok" };
}

function ServedRouteSummary(props: {
  route: ProductRoutingServedRoute | null;
  loading: boolean;
  error: string | null;
}): JSX.Element {
  const outcome = servedRouteOutcome(props.route);
  const source = props.route
    ? "Source: recent Runtime assistant event · no provider call"
    : props.loading
      ? "Recent Runtime route evidence is loading."
      : props.error
        ? "Recent Runtime route evidence is unavailable."
        : "No completed-request provider metadata was observed.";

  return (
    <div className="yuvi-product-routing-served">
      <div className="yuvi-product-routing-served-heading">
        <div>
          <span>{t("Last completed request")}</span>
          <strong>{props.route ? providerLabel(props.route.provider) : t("Unknown")}</strong>
        </div>
        <span className={`yuvi-product-route-badge is-${outcome.tone}`}>{outcome.label}</span>
      </div>
      <div className="yuvi-product-routing-served-facts">
        <span>{t("Served provider:")}{" "}{props.route ? providerLabel(props.route.provider) : t("Unknown")}
        </span>
        {props.route?.model ? <span>{t("Model:")}{" "}{props.route.model}</span> : null}
        {props.route?.attemptedProviders.length ? (
          <span>{t("Runtime attempts:")}{" "}
            {props.route.attemptedProviders.map((attempt) => attempt.provider).join(" → ")}
          </span>
        ) : null}
      </div>
      <small>{source}</small>
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
  servedRoute?: ProductRoutingServedRoute | null;
  servedRouteLoading?: boolean;
  servedRouteError?: string | null;
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
          <div className="yuvi-product-eyebrow">{t("Capability")}</div>
          <h2>{props.definition.label}</h2>
          <p>{props.definition.description}</p>
        </div>
        <span className={`yuvi-product-route-badge is-${selectedTone}`}>
          {t(providerLabel(truth.activeProvider))}
        </span>
      </header>

      <div className="yuvi-product-routing-summary">
        <div>
          <span>{t("Runtime default provider")}</span>
          <strong>{t(providerLabel(truth.activeProvider))}</strong>
          <small>
            {truth.activeModel ? t("Default model: {0}", truth.activeModel) : "Default model: unknown"}
          </small>
        </div>
        <div>
          <span>{t("Readiness")}</span>
          <strong>{t(providerReadinessLabel(selectedStatus?.readiness))}</strong>
        </div>
        <div>
          <span>{t("Cached observation")}</span>
          <strong>{t(providerObservationLabel(selectedStatus?.observed))}</strong>
        </div>
      </div>

      <label className="yuvi-product-routing-editor">
        <span>{t("Saved / effective provider chain")}</span>
        <input
          aria-label={t("{0} provider chain", props.definition.label)}
          value={props.draft}
          disabled={props.saving}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder="provider-a,provider-b"
        />
        <small>{t("Comma-separated priority order. Source:")}{" "}{truth.savedSource}{t(". Runtime validates the provider names.")}</small>
      </label>

      <div className="yuvi-product-routing-truth">
        <div>
          <span>{t("Active Runtime route order")}</span>
          <strong>
            {truth.activeChain ? truth.activeChain.split(",").join(" → ") : t("unknown")}
          </strong>
        </div>
        <span className={`yuvi-product-route-badge is-${matchTone}`}>
          {t(productRoutingMatchLabel(truth))}
        </span>
      </div>

      {truth.pendingRestart ? (
        <div className="yuvi-product-routing-pending">{t("Runtime reports a pending restart. Saved/effective settings remain visible; active route order remains the source of truth until Runtime applies the change.")}</div>
      ) : null}

      <div className="yuvi-product-routing-chain-heading">
        <strong>{t("Current route chain")}</strong>
        <span>{t("Read-only Runtime observation · no provider call on page load")}</span>
      </div>
      <RouteList routes={routeStatus} />

      <ServedRouteSummary
        route={props.servedRoute ?? null}
        loading={props.servedRouteLoading ?? false}
        error={props.servedRouteError ?? null}
      />

      <div className="yuvi-product-routing-actions">
        <button
          type="button"
          className="yuvi-product-button is-primary"
          disabled={props.saving || props.inspecting}
          onClick={props.onSave}
        >
          {props.saving ? t("Saving…") : t("Save & apply")}
        </button>
        <button
          type="button"
          className="yuvi-product-button"
          disabled={props.saving || props.inspecting}
          onClick={props.onInspect}
        >
          {props.inspecting ? t("Inspecting…") : t("Inspect route")}
        </button>
      </div>

      {props.inspection ? <InspectionResult inspection={props.inspection} /> : null}
    </section>
  );
}

export function ProductAIRouting(): JSX.Element { return <ProductConfigurationPanel />; }
