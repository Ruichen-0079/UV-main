import { fetchUserSettings } from "./user-settings-client.js";
import {
  getDesktopRuntimeBinding,
  retryDesktopRuntimeBinding
} from "./service-supervisor-client.js";
import { isTauriRuntime } from "./tauri-window.js";
import { initializeLocale, setLocale, LOCALE_STORAGE_KEY } from "./locale.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ProductWebUI } from "./product-webui.js";
import { MainPage } from "./main-page.js";
import { CompanionPage } from "./companion-page.js";
import { SubtitlePage } from "./subtitle-page.js";
import {
  resolveDesktopSurface,
  setDesktopRuntimeBinding,
  type DesktopRuntimeBindingMode,
  type DesktopSurface
} from "./desktop-runtime.js";
import "./styles.css";
import "./product-ui.css";
import "./typography.css";

/**
 * Lightweight surface routing for the desktop split.
 * Tauri windows prefer window label (main/companion); hash is a browser fallback.
 */
function renderSurface(surface: DesktopSurface): JSX.Element {
  switch (surface) {
    case "main":
      return <MainPage />;
    case "companion":
      return <CompanionPage />;
    case "subtitle":
      return <SubtitlePage />;
    case "webui":
      return <ProductWebUI />;
    case "dashboard":
      return <App />;
  }
}

function RuntimeBindingUnavailable({ detail }: { detail: string }): JSX.Element {
  return (
    <main className="runtime-binding-unavailable" role="alert">
      <div className="runtime-binding-unavailable__card">
        <h1>YUVI Runtime unavailable</h1>
        <p>
          This desktop instance could not verify its own Runtime binding. No other local YUVI
          Runtime will be used as a fallback.
        </p>
        <p className="runtime-binding-unavailable__detail">{detail}</p>
        <button
          className="button-primary"
          type="button"
          onClick={() => {
            void retryDesktopRuntimeBinding().finally(() => window.location.reload());
          }}
        >
          Retry
        </button>
      </div>
    </main>
  );
}

initializeLocale();
window.addEventListener("storage", event => { if (event.key === LOCALE_STORAGE_KEY) window.location.reload(); });

const rootElement = document.getElementById("root") as HTMLElement;
const root = createRoot(rootElement);

void resolveDesktopSurface().then(async (surface) => {
  document.documentElement.dataset["yuviSurface"] = surface;
  if (isTauriRuntime()) {
    let bindingMode: DesktopRuntimeBindingMode = "attach";
    try {
      const binding = await getDesktopRuntimeBinding();
      if (!binding) throw new Error("Desktop Runtime binding projection is unavailable.");
      bindingMode = binding.mode;
      setDesktopRuntimeBinding(binding.mode, binding.ready ? binding.runtimeUrl : null);
      if (binding.mode === "attach" && (!binding.ready || !binding.runtimeUrl)) {
        root.render(
          <StrictMode>
            <RuntimeBindingUnavailable
              detail={binding.error ?? "The bound Supervisor/Runtime identity could not be verified."}
            />
          </StrictMode>
        );
        return;
      }
    } catch (error) {
      setDesktopRuntimeBinding(bindingMode, null);
      if (bindingMode === "attach") {
        root.render(
          <StrictMode>
            <RuntimeBindingUnavailable
              detail={error instanceof Error ? error.message : "Runtime binding failed."}
            />
          </StrictMode>
        );
        return;
      }
      // Owner/development mode retains the installed Runtime fallback.
    }
    try { const view = await fetchUserSettings(); setLocale(view.settings.app.language === "en" ? "en" : "zh-CN"); }
    catch { /* Settings surfaces expose load errors; the local UI remains usable. */ }
  }
  root.render(<StrictMode>{renderSurface(surface)}</StrictMode>);
});
