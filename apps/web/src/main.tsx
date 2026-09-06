import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { MainPage } from "./main-page.js";
import { CompanionPage } from "./companion-page.js";
import { resolveDesktopSurface, type DesktopSurface } from "./desktop-runtime.js";
import "./styles.css";

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
    case "webui":
    case "dashboard":
      return <App />;
  }
}

const rootElement = document.getElementById("root") as HTMLElement;
const root = createRoot(rootElement);

void resolveDesktopSurface().then((surface) => {
  document.documentElement.dataset["yuviSurface"] = surface;
  root.render(<StrictMode>{renderSurface(surface)}</StrictMode>);
});
