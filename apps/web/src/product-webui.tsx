import { useState } from "react";
import { App as DeveloperDashboard } from "./App.js";
import { apiClient, type HealthResponse } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { ProductCompactHealth, productCompactHealthItems } from "./product-compact-health.js";
import { ProductAIRouting } from "./product-ai-routing.js";
import { ProductModelsProviders } from "./product-models-providers.js";

type ProductView = "home" | "models" | "routing" | "developer";

function healthLabel(
  health: HealthResponse | null,
  loading: boolean,
  error: string | null
): string {
  return productCompactHealthItems({ health, loading, error })[0]?.summary ?? "Unknown";
}

/**
 * Daily-use WebUI.
 * Presentation baseline: Grok Product UI v1 (PR #162).
 * Authority baseline: current main. No stale PR #162 product backend or secret writer is restored.
 */
export function ProductWebUI(): JSX.Element {
  const [view, setView] = useState<ProductView>("home");
  const health = useAsyncData((signal) => apiClient.getHealth(signal), []);

  if (view === "developer") {
    return (
      <>
        <button type="button" className="yuvi-developer-return" onClick={() => setView("home")}>
          ← Product WebUI
        </button>
        <DeveloperDashboard />
      </>
    );
  }

  const status = healthLabel(health.data, health.loading, health.error);

  return (
    <div className="yuvi-shell yuvi-product-webui">
      <header className="yuvi-topbar">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--yuvi-muted)]">
            YUVI
          </div>
          <div className="truncate text-base font-semibold leading-tight">Companion Control</div>
        </div>
        <button
          type="button"
          className="yuvi-health-chip"
          onClick={() => void health.refresh()}
          title="Refresh product status"
        >
          <span className="yuvi-health-chip-label">Runtime</span>
          <span>{status}</span>
        </button>
        <div className="yuvi-topbar-actions">
          <button
            type="button"
            className={`yuvi-product-action ${view === "home" ? "is-active" : ""}`}
            onClick={() => setView("home")}
          >
            Home
          </button>
          <button
            type="button"
            className={`yuvi-product-action ${view === "models" ? "is-active" : ""}`}
            onClick={() => setView("models")}
          >
            Models &amp; Providers
          </button>
          <button
            type="button"
            className={`yuvi-product-action ${view === "routing" ? "is-active" : ""}`}
            onClick={() => setView("routing")}
          >
            AI Routing
          </button>
          <button
            type="button"
            className="yuvi-product-action"
            onClick={() => setView("developer")}
          >
            Developer
          </button>
        </div>
      </header>

      <main className="yuvi-shell-main" style={{ width: "min(72rem, calc(100% - 1.5rem))" }}>
        {view === "home" ? (
          <div className="yuvi-product-home">
            <section className="yuvi-product-hero">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--yuvi-muted)]">
                Product WebUI
              </div>
              <h1 className="m-0 text-2xl font-semibold">Daily control surface for YUVI</h1>
              <p className="m-0 max-w-2xl text-sm leading-6 text-[var(--yuvi-muted)]">
                Grok Product UI v1 supplies the visual language. Current-main Runtime, settings,
                secrets, Memory, voice, and provider semantics remain authoritative.
              </p>
              <div className="yuvi-product-actions mt-2">
                <button
                  type="button"
                  className="yuvi-product-action is-active"
                  onClick={() => setView("models")}
                >
                  Models &amp; Providers
                </button>
                <button
                  type="button"
                  className="yuvi-product-action"
                  onClick={() => setView("developer")}
                >
                  Open developer console
                </button>
              </div>
            </section>

            <ProductCompactHealth
              health={health.data}
              loading={health.loading}
              error={health.error}
              onRefresh={() => void health.refresh()}
            />

            {health.error ? (
              <section className="yuvi-card yuvi-card-alert">
                <div className="font-semibold">
                  {health.data ? "Product status refresh incomplete" : "Runtime health unavailable"}
                </div>
                <p className="mb-0 mt-1 text-sm text-[var(--yuvi-muted)]">
                  {health.data
                    ? "Showing the last successful Runtime projection."
                    : "Current status remains unknown until the Runtime health endpoint responds."}
                </p>
              </section>
            ) : null}
          </div>
        ) : view === "models" ? (
          <div className="grid gap-4">
            <section className="yuvi-product-hero">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--yuvi-muted)]">
                Models &amp; Providers
              </div>
              <h1 className="m-0 text-2xl font-semibold">Model connections</h1>
              <p className="m-0 text-sm leading-6 text-[var(--yuvi-muted)]">
                Provider connections use current-main Runtime settings and secret authority. AI
                Routing has its own product page.
              </p>
            </section>
            <ProductModelsProviders />
          </div>
        ) : (
          <ProductAIRouting />
        )}
      </main>
    </div>
  );
}
