import type { HealthResponse, ProviderHealth } from "./api/client.js";
import { providerObservationLabel, providerReadinessLabel } from "./provider-diagnostics.js";

export type ProductCompactHealthId = "yuvi" | "memory" | "voice" | "lumi";
export type ProductCompactHealthTone = "ok" | "warn" | "bad" | "idle";

export type ProductCompactHealthItem = {
  id: ProductCompactHealthId;
  label: string;
  tone: ProductCompactHealthTone;
  summary: string;
  detail: string;
  source: string;
};

export type ProductCompactHealthProps = {
  health: HealthResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh?: () => void;
};

/**
 * Build the four daily-use status cards from current-main's existing health
 * projection. This function deliberately does not inspect provider `status`
 * for Voice: that legacy aggregate can say healthy while `observed` is still
 * unknown, which is not evidence that voice works.
 */
export function productCompactHealthItems(input: {
  health: HealthResponse | null;
  loading: boolean;
  error: string | null;
}): ProductCompactHealthItem[] {
  const source = healthSource(input);
  return [
    runtimeHealthItem(input, source),
    memoryHealthItem(input, source),
    voiceHealthItem(input, source),
    lumiHealthItem()
  ];
}

export function ProductCompactHealth(props: ProductCompactHealthProps): JSX.Element {
  const items = productCompactHealthItems(props);

  return (
    <section className="yuvi-product-health" aria-labelledby="yuvi-product-health-title">
      <div className="yuvi-product-health-header">
        <div>
          <div className="yuvi-product-eyebrow">At a glance</div>
          <h2 id="yuvi-product-health-title">Daily health</h2>
        </div>
        {props.onRefresh ? (
          <button
            type="button"
            className="yuvi-product-button"
            disabled={props.loading}
            onClick={props.onRefresh}
          >
            {props.loading ? "Refreshing…" : "Refresh status"}
          </button>
        ) : null}
      </div>

      <div className="yuvi-product-health-grid">
        {items.map((item) => (
          <article key={item.id} className={`yuvi-product-health-card is-${item.tone}`}>
            <div className="yuvi-product-health-card-header">
              <span className="yuvi-product-health-card-label">{item.label}</span>
              <span className={`yuvi-product-health-badge is-${item.tone}`} role="status">
                {item.summary}
              </span>
            </div>
            <p>{item.detail}</p>
            <small>{item.source}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function healthSource(input: {
  health: HealthResponse | null;
  loading: boolean;
  error: string | null;
}): string {
  if (input.error && input.health) return "GET /health · last successful response";
  if (input.error) return "GET /health · no response";
  if (input.loading && input.health) return "GET /health · refresh in progress";
  if (input.loading && !input.health) return "GET /health · awaiting response";
  return "GET /health · current Runtime projection";
}

function runtimeHealthItem(
  input: ProductCompactHealthProps,
  source: string
): ProductCompactHealthItem {
  if (!input.health) {
    return {
      id: "yuvi",
      label: "YUVI",
      tone: input.loading ? "idle" : "warn",
      summary: input.loading ? "Checking" : "Unknown",
      detail: input.loading
        ? "Reading the current Runtime health projection."
        : "Runtime health was not observed. Refresh status to try again.",
      source
    };
  }

  const serverStatus = input.health.server.status.trim().toLowerCase();
  const gate = input.health.ok ? "passed" : "not passed";
  if (serverStatus === "healthy") {
    return {
      id: "yuvi",
      label: "YUVI",
      tone: "ok",
      summary: "Available",
      detail: `Runtime endpoint reports healthy; overall health gate ${gate}.`,
      source
    };
  }
  if (serverStatus === "unavailable") {
    return {
      id: "yuvi",
      label: "YUVI",
      tone: "bad",
      summary: "Unavailable",
      detail: `Runtime endpoint reports unavailable; overall health gate ${gate}.`,
      source
    };
  }
  if (serverStatus.length > 0) {
    return {
      id: "yuvi",
      label: "YUVI",
      tone: "warn",
      summary: "Degraded",
      detail: `Runtime endpoint reports ${serverStatus}; overall health gate ${gate}.`,
      source
    };
  }
  return {
    id: "yuvi",
    label: "YUVI",
    tone: "warn",
    summary: "Unknown",
    detail: "Runtime responded without a recognizable server status.",
    source
  };
}

function memoryHealthItem(
  input: ProductCompactHealthProps,
  source: string
): ProductCompactHealthItem {
  const status = input.health?.database.status;
  if (!status) {
    return {
      id: "memory",
      label: "Memory",
      tone: input.loading ? "idle" : "warn",
      summary: input.loading ? "Checking" : "Unknown",
      detail: input.loading
        ? "Reading the current Memory repository projection."
        : "Memory repository health was not observed.",
      source
    };
  }

  switch (status) {
    case "healthy":
      return {
        id: "memory",
        label: "Memory",
        tone: "ok",
        summary: "Healthy",
        detail: "The Runtime Memory repository health check passed.",
        source
      };
    case "degraded":
      return {
        id: "memory",
        label: "Memory",
        tone: "warn",
        summary: "Degraded",
        detail: "The Runtime Memory repository reported degraded health.",
        source
      };
    case "unavailable":
      return {
        id: "memory",
        label: "Memory",
        tone: "bad",
        summary: "Unavailable",
        detail: "The Runtime Memory repository reported unavailable health.",
        source
      };
  }
}

function voiceHealthItem(
  input: ProductCompactHealthProps,
  source: string
): ProductCompactHealthItem {
  const tts = input.health?.providers.optional.tts;
  const stt = input.health?.providers.optional.stt;
  if (!tts || !stt) {
    return {
      id: "voice",
      label: "Voice",
      tone: input.loading ? "idle" : "warn",
      summary: input.loading ? "Checking" : "Unknown",
      detail: input.loading
        ? "Reading TTS and STT configuration and cached observations."
        : "Current-main did not expose both TTS and STT status projections.",
      source
    };
  }

  const providers = [tts, stt];
  const readiness = providers.map((provider) => provider.readiness);
  const observations = providers.map((provider) => provider.observed);
  const allReady = readiness.every((value) => value === "ready");
  const allNotReady = readiness.every((value) => value === "not_ready");
  const anyReady = readiness.some((value) => value === "ready");
  const allObservedUnavailable = observations.every((value) => value === "unavailable");
  const anyObservedUnavailable = observations.some((value) => value === "unavailable");
  const anyObservedDegraded = observations.some((value) => value === "degraded");
  const detail = [`TTS: ${providerAxes(tts)}`, `STT: ${providerAxes(stt)}`].join(" · ");

  if (allObservedUnavailable) {
    return { id: "voice", label: "Voice", tone: "bad", summary: "Unavailable", detail, source };
  }
  if (anyObservedUnavailable || anyObservedDegraded) {
    return { id: "voice", label: "Voice", tone: "warn", summary: "Degraded", detail, source };
  }
  if (allReady && observations.every((value) => value === "available")) {
    return {
      id: "voice",
      label: "Voice",
      tone: "ok",
      summary: "Observed available",
      detail,
      source
    };
  }
  if (allNotReady) {
    return { id: "voice", label: "Voice", tone: "warn", summary: "Not configured", detail, source };
  }
  if (allReady) {
    return {
      id: "voice",
      label: "Voice",
      tone: "warn",
      summary: "Configured · unverified",
      detail,
      source
    };
  }
  if (anyReady) {
    return {
      id: "voice",
      label: "Voice",
      tone: "warn",
      summary: "Partially configured",
      detail,
      source
    };
  }
  return { id: "voice", label: "Voice", tone: "warn", summary: "Unknown", detail, source };
}

function providerAxes(provider: ProviderHealth): string {
  return `${providerReadinessLabel(provider.readiness)} · ${providerObservationLabel(provider.observed)}`;
}

function lumiHealthItem(): ProductCompactHealthItem {
  return {
    id: "lumi",
    label: "Lumi",
    tone: "idle",
    summary: "Unknown",
    detail: "Lumi renderer readiness is unknown right now.",
    source: "Renderer readiness is not exposed by current Runtime/Desktop APIs"
  };
}
