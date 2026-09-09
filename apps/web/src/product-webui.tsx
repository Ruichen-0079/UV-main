import { LocaleSelector } from "./locale-selector.js";
import { t } from "./locale.js";
import { ProductLive2DModels } from "./product-live2d-models.js";
import { ProductVisionStatus } from "./product-vision-status.js";
import { useState } from "react";
import { App as DeveloperDashboard } from "./App.js";
import { apiClient, type HealthResponse } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { ProductCompactHealth, productCompactHealthItems } from "./product-compact-health.js";
import { ProductModelsProviders } from "./product-models-providers.js";
import { ProductMemorySettings } from "./product-memory-settings.js";
import { ProductConfigurationPanel } from "./product-configuration.js";
import { isTauriRuntime } from "./tauri-window.js";
import { UserSettingsPanel } from "./user-settings-panel.js";
import { CompanionAppearanceSettings } from "./companion-appearance-settings.js";
import { SubtitleAppearanceSettings } from "./subtitle-appearance-settings.js";

type ProductView = "home" | "models" | "people" | "appearance" | "advanced" | "developer";

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
        <button type="button" className="yuvi-developer-return" onClick={() => setView("home")}>{t("← Product WebUI")}</button>
        <DeveloperDashboard />
      </>
    );
  }

  const status = healthLabel(health.data, health.loading, health.error);
  const tauri = isTauriRuntime();

  return (
    <div className="yuvi-shell yuvi-product-webui">
      <header className="yuvi-topbar">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--yuvi-muted)]">
            YUVI
          </div>
          <div className="truncate text-base font-semibold leading-tight">{t("Companion Control")}</div>
        </div>
        <button
          type="button"
          className="yuvi-health-chip"
          onClick={() => void health.refresh()}
          title={t("Refresh product status")}
        >
          <span className="yuvi-health-chip-label">Runtime</span>
          <span>{status}</span>
        </button>
        <div className="yuvi-topbar-actions">
          {!tauri ? (
            <>
              <a className="yuvi-product-action" href="/#/main" target="yuvi-main">{t("Chat & Voice Mode")}</a>
              <a className="yuvi-product-action" href="/#/companion" target="yuvi-companion">{t("Companion")}</a>
              <a className="yuvi-product-action" href="/#/subtitle" target="yuvi-subtitle">{t("Subtitle")}</a>
            </>
          ) : null}
          <button
            type="button"
            className={`yuvi-product-action ${view === "home" ? "is-active" : ""}`}
            onClick={() => setView("home")}
          >{t("Home")}</button>
          <button
            type="button"
            className={`yuvi-product-action ${view === "models" ? "is-active" : ""}`}
            onClick={() => setView("models")}
          >{t("Models")}</button>
          <button
            type="button"
            className={`yuvi-product-action ${view === "people" ? "is-active" : ""}`}
            onClick={() => setView("people")}
          >{t("People & Memory")}</button>
          <button
            type="button"
            className={`yuvi-product-action ${view === "appearance" ? "is-active" : ""}`}
            onClick={() => setView("appearance")}
          >{t("Appearance")}</button>
          <button
            type="button"
            className={`yuvi-product-action ${view === "advanced" ? "is-active" : ""}`}
            onClick={() => setView("advanced")}
          >{t("Advanced settings")}</button>
          <button
            type="button"
            className="yuvi-product-action"
            onClick={() => setView("developer")}
          >{t("Developer")}</button>
        </div>
      </header>

      <main className="yuvi-shell-main" style={{ width: "min(72rem, calc(100% - 1.5rem))" }}>
        {view === "home" ? (
          <div className="yuvi-product-home">
            <section className="yuvi-product-hero">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--yuvi-muted)]">{t("Product WebUI")}</div>
              <h1 className="m-0 text-2xl font-semibold">{t("Daily control surface for YUVI")}</h1>
              <p className="m-0 max-w-2xl text-sm leading-6 text-[var(--yuvi-muted)]">{t("Check connection health, choose your models, and manage companion settings.")}</p>
              <div className="yuvi-product-actions mt-2">
                <button
                  type="button"
                  className="yuvi-product-action is-active"
                  onClick={() => setView("models")}
                >{t("Models")}</button>
                <button
                  type="button"
                  className="yuvi-product-action"
                  onClick={() => setView("developer")}
                >{t("Open developer console")}</button>
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
            <ProductVisionStatus />
          </div>
        ) : view === "models" ? (
          <div className="grid gap-4">
            <section className="yuvi-product-hero">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--yuvi-muted)]">{t("Models")}</div>
              <h1 className="m-0 text-2xl font-semibold">{t("AI models")}</h1>
              <p className="m-0 text-sm leading-6 text-[var(--yuvi-muted)]">{t("Choose configured models here. Provider connections and route ordering are in Advanced settings.")}</p>
            </section>
            <ProductModelsProviders />
          </div>
        ) : view === "people" ? (
          <div className="grid gap-4">
            <section className="yuvi-product-hero">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--yuvi-muted)]">{t("People & Memory")}</div>
              <h1 className="m-0 text-2xl font-semibold">{t("People, voices, and memory identity")}</h1>
              <p className="m-0 text-sm leading-6 text-[var(--yuvi-muted)]">{t("Manage who YUVI knows and the trusted voice bindings attached to those people.")}</p>
            </section>
            <ProductConfigurationPanel sections={["people", "voices"]} />
          </div>
        ) : view === "appearance" ? (
          <div className="grid gap-4">
            <section className="yuvi-product-hero">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--yuvi-muted)]">{t("Appearance")}</div>
              <h1 className="m-0 text-2xl font-semibold">{t("Appearance & desktop surfaces")}</h1>
              <p className="m-0 text-sm leading-6 text-[var(--yuvi-muted)]">{t("Choose the companion model and product language. Window behavior stays with the desktop surface.")}</p>
            </section>
            <LocaleSelector />
            <CompanionAppearanceSettings />
            <SubtitleAppearanceSettings />
            <ProductLive2DModels />
          </div>
        ) : (
          <div className="grid gap-4">
            <section className="yuvi-product-hero">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--yuvi-muted)]">{t("Advanced settings")}</div>
              <h1 className="m-0 text-2xl font-semibold">{t("Advanced configuration")}</h1>
              <p className="m-0 text-sm leading-6 text-[var(--yuvi-muted)]">{t("Providers, capability routes, local services, and operational settings live here.")}</p>
            </section>
            <ProductConfigurationPanel sections={["status", "providers", "routes", "proactive"]} />
            {tauri ? <UserSettingsPanel /> : <ProductMemorySettings />}
          </div>
        )}
      </main>
    </div>
  );
}
