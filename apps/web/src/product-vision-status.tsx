import { t } from "./locale.js";
import { apiClient } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";

export function ProductVisionStatus(): JSX.Element {
  const settings = useAsyncData((signal) => apiClient.getRuntimeSettings(signal), []);
  const config = settings.data?.activeRuntimeConfig;
  const vision = config?.providers?.vision;
  return (
    <section className="yuvi-card">
      <h2 className="m-0 text-base font-semibold">{t("Vision")}</h2>
      <p>{t("Configuration:")}{" "}{vision ? (vision.configured ? t("Configured") : t("Unconfigured")) : t("Unknown")}
      </p>
      <p>{t("Provider readiness:")}{" "}
        {vision?.readiness === "ready"
          ? t("Ready")
          : vision?.readiness === "not_ready"
            ? t("Not ready")
            : t("Unknown")}
      </p>
      <p>{t("One-shot visual grounding:")}{" "}
        {config?.visualGroundingAvailable === true
          ? t("Available")
          : config?.visualGroundingAvailable === false
            ? t("Unavailable")
            : t("Unknown")}
      </p>
      <p className="text-sm text-[var(--yuvi-muted)]">{t("YUVI can request current-screen evidence when a turn needs it. Readiness does not verify provider reachability.")}</p>
      {settings.error ? <p role="alert">{t("Vision status could not be refreshed.")}</p> : null}
      <button type="button" className="yuvi-product-action" onClick={() => void settings.refresh()}>{t("Refresh Vision status")}</button>
    </section>
  );
}
