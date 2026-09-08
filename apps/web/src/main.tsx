import { fetchUserSettings } from "./user-settings-client.js";
import { isTauriRuntime } from "./tauri-window.js";
import { initializeLocale, setLocale, LOCALE_STORAGE_KEY } from "./locale.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ProductWebUI } from "./product-webui.js";
import { MainPage } from "./main-page.js";
import { CompanionPage } from "./companion-page.js";
import { SubtitlePage } from "./subtitle-page.js";
import { resolveDesktopSurface, type DesktopSurface } from "./desktop-runtime.js";
import "./styles.css";
import "./product-ui.css";

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

initializeLocale();
window.addEventListener("storage", event => { if (event.key === LOCALE_STORAGE_KEY) window.location.reload(); });

const rootElement = document.getElementById("root") as HTMLElement;
const root = createRoot(rootElement);

void resolveDesktopSurface().then(async (surface) => {
  if (isTauriRuntime()) {
    try { const view = await fetchUserSettings(); setLocale(view.settings.app.language === "en" ? "en" : "zh-CN"); }
    catch { /* Settings surfaces expose load errors; the local UI remains usable. */ }
  }
  document.documentElement.dataset["yuviSurface"] = surface;
  root.render(<StrictMode>{renderSurface(surface)}</StrictMode>);
});
