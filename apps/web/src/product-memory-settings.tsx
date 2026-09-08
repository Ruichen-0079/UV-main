import { t } from "./locale.js";
import { useEffect, useState } from "react";
import { apiClient } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";
import { productSettingValue } from "./product-models-providers.js";

export function ProductMemorySettings(): JSX.Element {
  const settings = useAsyncData((signal) => apiClient.getRuntimeSettings(signal), []);
  const [values, setValues] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!settings.data) return;
    setValues(
      Object.fromEntries(
        ["MEMORY_BACKEND", "MEMORY_REPOSITORY", "MEM0_BASE_URL", "MEM0_OLLAMA_BASE_URL"].map(
          (key) => [key, productSettingValue(settings.data!, key, "")]
        )
      )
    );
  }, [settings.data]);
  return (
    <section className="yuvi-card">
      <h2>{t("Local memory connection")}</h2>
      <p>{t("Mem0 uses yuvi-embedding:0.6b at 1024 dimensions. Database credentials remain private. Connection changes require a service restart.")}</p>
      {[
        ["MEMORY_BACKEND", "Memory backend"],
        ["MEMORY_REPOSITORY", "Persistence repository"],
        ["MEM0_BASE_URL", "Mem0 URL"],
        ["MEM0_OLLAMA_BASE_URL", "Ollama URL"],
        ["DATABASE_URL", "PostgreSQL connection (blank keeps saved value)"]
      ].map(([key, label]) => (
        <label className="yuvi-product-provider-field" key={key}>
          <span>{label}</span>
          <input
            disabled={busy || !settings.data}
            type={key === "DATABASE_URL" ? "password" : "text"}
            value={values[key!] ?? ""}
            onChange={(event) =>
              setValues((current) => ({ ...current, [key!]: event.target.value }))
            }
          />
        </label>
      ))}
      <button
        className="yuvi-product-button"
        disabled={busy || !settings.data}
        onClick={() => {
          setBusy(true);
          const saved = { ...values };
          if (!saved["DATABASE_URL"]?.trim()) delete saved["DATABASE_URL"];
          void apiClient
            .updateRuntimeSettings({ values: saved })
            .then(() => {
              setValues((v) => ({ ...v, DATABASE_URL: "" }));
              setNotice("Saved. Restart local services to apply the connection changes.");
            })
            .catch(() => setNotice("Could not save. Check the connection values."))
            .finally(() => setBusy(false));
        }}
      >{t("Save memory configuration")}</button>
      <button
        className="yuvi-product-button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void apiClient
            .restartLocalServices()
            .then(() =>
              setNotice("Restart requested. Wait a few seconds, then refresh local service status.")
            )
            .catch(() => setNotice("Restart requires the installed Linux daily-use launcher."))
            .finally(() => setBusy(false));
        }}
      >{t("Restart local services")}</button>
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
