import { t } from "./locale.js";
import { useRef, useState } from "react";
import { apiClient } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";

export function ProductLive2DModels(): JSX.Element {
  const state = useAsyncData((signal) => apiClient.getLive2DModels(signal), []);
  const [files, setFiles] = useState<File[]>([]);
  const [model, setModel] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const busy = useRef(false);
  const manifests = files.filter((f) => f.name.endsWith(".model3.json"));
  async function act(work: () => Promise<unknown>, success: string): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await work();
      if (!(await state.refresh()))
        throw new Error(t("Action completed, but refreshing installed models failed."));
      setMessage(t(success));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Model action failed.");
    } finally {
      busy.current = false;
      setPending(false);
      setProgress(null);
    }
  }
  async function importModel(): Promise<void> {
    if (files.length > 512 || files.reduce((n, f) => n + f.size, 0) > 64 * 1024 * 1024)
      throw new Error(t("Choose a model directory under 64 MiB and 512 files."));
    const encoded: { path: string; base64: string }[] = [];
    let read = 0;
    const size = files.reduce((n, f) => n + f.size, 0);
    for (const file of files) {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(t("Unable to read model file.")));
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.readAsDataURL(file);
      });
      encoded.push({ path: file.webkitRelativePath || file.name, base64 });
      read += file.size;
      setProgress(size ? read / size : 1);
    }
    setProgress(null);
    await apiClient.importLive2DModel({ name, model, files: encoded });
    setFiles([]);
    setModel("");
    setName("");
  }
  return (
    <section
      className="yuvi-panel grid gap-3"
      aria-label={t("Live2D models")}
      aria-busy={pending || state.loading}
    >
      <h2>{t("Companion · Live2D")}</h2>
      <p>{t("Intended default: 桃瀬ひより / Hiyori Momose · © Live2D Inc.")}</p>
      <p>
        {t(
          "Download the official sample, extract it, then choose its runtime model directory. Imported files are copied into YUVI durable storage."
        )}
      </p>
      <div className="flex flex-wrap gap-3">
        <a href="https://www.live2d.com/en/learn/sample/" target="_blank" rel="noreferrer">
          {t("Official Live2D samples")}
        </a>
        <a
          href="https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html"
          target="_blank"
          rel="noreferrer"
        >
          {t("Sample license")}
        </a>
        <a
          href="https://www.live2d.com/eula/live2d-sample-model-terms_en.html"
          target="_blank"
          rel="noreferrer"
        >
          {t("Character terms and notices")}
        </a>
      </div>
      <p>
        {t(
          "Hiyori binaries are not bundled. Review the official terms before downloading; Hiyori's character design must remain unchanged."
        )}
      </p>
      <label>
        {t("Model directory")}
        <input
          type="file"
          aria-label={t("Model directory")}
          multiple
          {...{ webkitdirectory: "" }}
          disabled={pending}
          onChange={(e) => {
            const next = Array.from(e.target.files ?? []);
            setFiles(next);
            const first = next.find((f) => f.name.endsWith(".model3.json"));
            setModel(first?.webkitRelativePath || first?.name || "");
            setName(first?.name.replace(/\.model3\.json$/u, "") ?? "");
            setError("");
            setMessage("");
          }}
        />
      </label>
      {files.length > 0 && !manifests.length && (
        <p role="alert">{t("No .model3.json found in this directory.")}</p>
      )}
      <label>
        {t("Model manifest")}
        <select
          value={model}
          disabled={pending || !manifests.length}
          onChange={(e) => setModel(e.target.value)}
        >
          <option value="">{t("Choose a model")}</option>
          {manifests.map((f) => (
            <option key={f.webkitRelativePath || f.name} value={f.webkitRelativePath || f.name}>
              {f.webkitRelativePath || f.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("Model name")}
        <input
          value={name}
          maxLength={80}
          disabled={pending}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={pending || !model || !name.trim()}
        onClick={() => void act(importModel, "Model installed. Select it to load Companion.")}
      >
        {t("Import model")}
      </button>
      {pending && (
        <div role="status">
          <span>
            {progress === null ? t("Installing or updating model…") : t("Reading model files…")}
          </span>
          <progress
            aria-label={t("Model operation progress")}
            {...(progress === null ? {} : { value: progress, max: 1 })}
          />
        </div>
      )}
      {state.loading && <progress aria-label={t("Loading installed models")} />}
      {(error || state.error) && <p role="alert">{error || state.error}</p>}
      {message && <p role="status">{message}</p>}
      {!state.loading && !state.error && !state.data?.activeId && (
        <p>
          {t("No active model. Install Hiyori from the official source or import your own model.")}
        </p>
      )}
      <button
        type="button"
        disabled={pending || !state.data?.activeId}
        onClick={() =>
          void act(
            () => apiClient.selectLive2DModel(null),
            "Companion model disabled. Installed models are retained."
          )
        }
      >
        {t("Disable model")}
      </button>
      <ul className="grid gap-2">
        {state.data?.models.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-3">
            <strong>{m.name}</strong>
            <span>{m.source === "user" ? t("User imported") : t("Preinstalled / configured")}</span>
            {state.data?.activeId === m.id ? (
              <span>{t("Selected")}</span>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  void act(
                    () => apiClient.selectLive2DModel(m.id),
                    "Selection saved. Companion will load the model; its status shows whether rendering succeeds."
                  )
                }
              >
                {t("Select model")}
              </button>
            )}
            <button
              type="button"
              disabled={pending || m.source !== "user" || state.data?.activeId === m.id}
              title={
                state.data?.activeId === m.id
                  ? t("Select another model before removal")
                  : m.source !== "user"
                    ? t("Preinstalled models cannot be removed here")
                    : t("Remove installed copy")
              }
              onClick={() => {
                if (
                  window.confirm(t("Remove {0}? The original files will remain untouched.", m.name))
                )
                  void act(() => apiClient.removeLive2DModel(m.id), "Installed model removed.");
              }}
            >
              {t("Remove model")}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={pending || state.loading}
        onClick={() => void state.refresh()}
      >
        {t("Refresh models")}
      </button>
    </section>
  );
}

function modelActionError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Model action failed.";
  try {
    const response = JSON.parse(message);
    return t(typeof response.message === "string" ? response.message : "Model action failed.");
  } catch {
    return t(message);
  }
}
