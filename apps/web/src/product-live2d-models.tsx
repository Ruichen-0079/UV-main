import { t } from "./locale.js";
import { useRef, useState } from "react";
import { apiClient } from "./api/client.js";
import { useAsyncData } from "./hooks/useAsyncData.js";

export const LIVE2D_ZIP_MAX_BYTES = 64 * 1024 * 1024;

export type Live2DArchiveSelectionError =
  | "empty-selection"
  | "multiple-files"
  | "directory"
  | "not-zip"
  | "empty-file"
  | "too-large";

export function inspectLive2DArchiveSelection(
  files: readonly Pick<File, "name" | "size">[],
  containsDirectory = false
): Live2DArchiveSelectionError | null {
  if (containsDirectory) return "directory";
  if (files.length === 0) return "empty-selection";
  if (files.length !== 1) return "multiple-files";
  const file = files[0]!;
  if (!/\.zip$/iu.test(file.name)) return "not-zip";
  if (file.size === 0) return "empty-file";
  if (file.size > LIVE2D_ZIP_MAX_BYTES) return "too-large";
  return null;
}

export function defaultLive2DModelName(fileName: string): string {
  const name = fileName.trim().replace(/\.zip$/iu, "").trim();
  return (name || "Live2D model").slice(0, 80);
}

function selectionErrorMessage(error: Live2DArchiveSelectionError): string {
  switch (error) {
    case "empty-selection":
      return t("Choose one Live2D ZIP.");
    case "multiple-files":
      return t("Choose one Live2D ZIP at a time.");
    case "directory":
      return t("Drop a ZIP file, not a directory.");
    case "not-zip":
      return t("Choose a file ending in .zip.");
    case "empty-file":
      return t("The selected ZIP is empty.");
    case "too-large":
      return t("Choose a Live2D ZIP under 64 MiB.");
  }
}

async function readFileBase64(
  file: File,
  errorMessage: string,
  onProgress: (value: number) => void
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(errorMessage));
    reader.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    reader.onload = () => {
      onProgress(1);
      const encoded = String(reader.result).split(",")[1];
      if (!encoded) reject(new Error(errorMessage));
      else resolve(encoded);
    };
    reader.readAsDataURL(file);
  });
}

export function ProductLive2DModels(): JSX.Element {
  const state = useAsyncData((signal) => apiClient.getLive2DModels(signal), []);
  const [archive, setArchive] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const busy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

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
    } catch (caught) {
      setError(modelActionError(caught));
    } finally {
      busy.current = false;
      setPending(false);
      setProgress(null);
    }
  }

  function chooseArchive(files: readonly File[], containsDirectory = false): void {
    const selectionError = inspectLive2DArchiveSelection(files, containsDirectory);
    setMessage("");
    setFailed(false);
    if (selectionError) {
      setArchive(null);
      setName("");
      setError(selectionErrorMessage(selectionError));
      return;
    }

    const next = files[0]!;
    setArchive(next);
    setName(defaultLive2DModelName(next.name));
    setError("");
  }

  async function importArchive(): Promise<void> {
    if (busy.current || !archive) return;
    const selectionError = inspectLive2DArchiveSelection([archive]);
    if (selectionError) {
      setError(selectionErrorMessage(selectionError));
      setFailed(true);
      return;
    }

    busy.current = true;
    setPending(true);
    setProgress(0);
    setError("");
    setMessage("");
    setFailed(false);
    let installed = false;
    try {
      const archiveBase64 = await readFileBase64(
        archive,
        t("Unable to read model ZIP."),
        setProgress
      );
      setProgress(null);
      await apiClient.importLive2DZip({
        name: name.trim() || defaultLive2DModelName(archive.name),
        archiveBase64
      });
      installed = true;
      setArchive(null);
      setName("");
      if (fileInput.current) fileInput.current.value = "";
      if (!(await state.refresh())) {
        throw new Error(t("Model installed and selected, but refreshing the model list failed."));
      }
      setMessage(t("Model ZIP installed and selected. Companion will reload it automatically."));
    } catch (caught) {
      setError(modelActionError(caught));
      setFailed(!installed);
    } finally {
      busy.current = false;
      setPending(false);
      setProgress(null);
    }
  }

  return (
    <section
      className="yuvi-card yuvi-model-library grid gap-3"
      aria-label={t("Live2D models")}
      aria-busy={pending || state.loading}
    >
      <h2>{t("Companion · Live2D")}</h2>
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
        {state.data?.models.map((model) => (
          <li key={model.id} className="flex flex-wrap items-center gap-3">
            <strong>{model.name}</strong>
            <span>
              {model.source === "user" ? t("User imported") : t("Preinstalled / configured")}
            </span>
            {state.data?.activeId === model.id ? (
              <span>{t("Selected")}</span>
            ) : (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  void act(
                    () => apiClient.selectLive2DModel(model.id),
                    "Selection saved. Companion will load the model; its status shows whether rendering succeeds."
                  )
                }
              >
                {t("Select model")}
              </button>
            )}
            <button
              type="button"
              disabled={pending || model.source !== "user" || state.data?.activeId === model.id}
              title={
                state.data?.activeId === model.id
                  ? t("Select another model before removal")
                  : model.source !== "user"
                    ? t("Preinstalled models cannot be removed here")
                    : t("Remove installed copy")
              }
              onClick={() => {
                if (
                  window.confirm(
                    t("Remove {0}? The original files will remain untouched.", model.name)
                  )
                ) {
                  void act(() => apiClient.removeLive2DModel(model.id), "Installed model removed.");
                }
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
      <details className="yuvi-advanced">
        <summary>{t("Official sample and license")}</summary>
        <p>{t("Intended default: 桃瀬ひより / Hiyori Momose · © Live2D Inc.")}</p>
        <p>
          {t(
            "Import a Live2D / VTube Studio ZIP. YUVI detects the model manifest and copies validated assets into durable storage."
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
      </details>

      <h3>{t("Import a character")}</h3>
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        multiple
        aria-label={t("Live2D ZIP")}
        disabled={pending}
        onClick={(event) => {
          event.currentTarget.value = "";
        }}
        onChange={(event) => {
          chooseArchive(Array.from(event.target.files ?? []));
        }}
      />
      <div
        className={`yuvi-live2d-dropzone${dragging ? " is-dragging" : ""}`}
        data-testid="live2d-zip-dropzone"
        onDragEnter={(event) => {
          event.preventDefault();
          if (!pending) setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = pending ? "none" : "copy";
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (pending) return;
          const containsDirectory = Array.from(event.dataTransfer.items).some((item) => {
            const entry = (
              item as DataTransferItem & {
                webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
              }
            ).webkitGetAsEntry?.();
            return entry?.isDirectory === true;
          });
          chooseArchive(Array.from(event.dataTransfer.files), containsDirectory);
        }}
      >
        <strong>{t("Drop a Live2D ZIP here")}</strong>
        <span>{t("or choose one ZIP file up to 64 MiB")}</span>
        <button
          type="button"
          className="button-secondary"
          disabled={pending}
          onClick={() => fileInput.current?.click()}
        >
          {t("Choose ZIP")}
        </button>
      </div>

      {archive && (
        <div className="yuvi-live2d-archive">
          <div>
            <strong>{archive.name}</strong>
            <span>{formatBytes(archive.size)}</span>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setArchive(null);
              setName("");
              setError("");
              setFailed(false);
              if (fileInput.current) fileInput.current.value = "";
            }}
          >
            {t("Remove ZIP")}
          </button>
        </div>
      )}

      <label>
        {t("Model name (optional)")}
        <input
          value={name}
          maxLength={80}
          disabled={pending || !archive}
          placeholder={archive ? defaultLive2DModelName(archive.name) : t("Selected ZIP name")}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <button
        type="button"
        className="button-primary"
        disabled={pending || !archive}
        onClick={() => void importArchive()}
      >
        {t(failed ? "Retry import" : "Import ZIP")}
      </button>

      {pending && (
        <div role="status">
          <span>
            {progress === null ? t("Installing model…") : t("Reading model ZIP…")}
          </span>
          <progress
            aria-label={t("Model operation progress")}
            {...(progress === null ? {} : { value: progress, max: 1 })}
          />
        </div>
      )}
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
