import { apiClient } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";

export function ProductVisionStatus(): JSX.Element {
  const settings = useAsyncData((signal) => apiClient.getRuntimeSettings(signal), []);
  const config = settings.data?.activeRuntimeConfig;
  const vision = config?.providers?.vision;
  return (
    <section className="yuvi-card">
      <h2 className="m-0 text-base font-semibold">Vision</h2>
      <p>
        Configuration: {vision ? (vision.configured ? "Configured" : "Unconfigured") : "Unknown"}
      </p>
      <p>
        Provider readiness:{" "}
        {vision?.readiness === "ready"
          ? "Ready"
          : vision?.readiness === "not_ready"
            ? "Not ready"
            : "Unknown"}
      </p>
      <p>
        One-shot visual grounding:{" "}
        {config?.visualGroundingAvailable === true
          ? "Available"
          : config?.visualGroundingAvailable === false
            ? "Unavailable"
            : "Unknown"}
      </p>
      <p className="text-sm text-[var(--yuvi-muted)]">
        YUVI can request current-screen evidence when a turn needs it. Readiness does not verify
        provider reachability.
      </p>
      {settings.error ? <p role="alert">Vision status could not be refreshed.</p> : null}
      <button type="button" className="yuvi-product-action" onClick={() => void settings.refresh()}>
        Refresh Vision status
      </button>
    </section>
  );
}
