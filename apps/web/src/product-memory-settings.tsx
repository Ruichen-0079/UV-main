import { t } from "./locale.js";
import { apiClient, type LocalServicesStatus } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";

export function productMemoryOperational(
  memory: LocalServicesStatus["memory"] | null | undefined
): boolean {
  return Boolean(
    memory &&
      memory.database === "healthy" &&
      memory.crud &&
      memory.search &&
      memory.embedder &&
      memory.vectorStore
  );
}

export function ProductMemorySettings(): JSX.Element {
  const services = useAsyncData((signal) => apiClient.getLocalServices(signal), []);
  const memory = services.data?.memory;
  const operational = productMemoryOperational(memory);

  return (
    <section className="yuvi-card">
      <h2>{t("Memory")}</h2>
      <p>{t("YUVI manages Memory storage and service topology automatically.")}</p>

      <div
        className={
          services.loading
            ? "yuvi-product-inline-state"
            : operational
              ? "yuvi-product-inline-state is-ok"
              : "yuvi-product-inline-state is-warning"
        }
        role="status"
      >
        {t(services.loading ? "Checking" : operational ? "Available" : memory ? "Unavailable" : "Unknown")}
      </div>

      {services.error && (
        <p role="alert">
          {t("Could not load settings. Check the connection and try again.")}{" "}
          <button className="yuvi-product-button" onClick={() => void services.refresh()}>
            {t("Retry")}
          </button>
        </p>
      )}

      {memory &&
        (operational ? (
          <p>{t("Memory search and durable vector storage are operational.")}</p>
        ) : (
          <p>{t("Memory is unavailable. Open System diagnostics for details.")}</p>
        ))}
    </section>
  );
}
