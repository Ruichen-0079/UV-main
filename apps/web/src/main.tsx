import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { MainPage } from "./main-page.js";
import { CompanionPage } from "./companion-page.js";
import "./styles.css";

type Surface = "dashboard" | "main" | "companion";

/**
 * Lightweight surface routing for the desktop split. The Tauri windows load
 * index.html#/main and index.html#/companion (works in dev and packaged mode);
 * plain /main and /companion paths are also accepted for browser debugging.
 */
function resolveSurface(): Surface {
  const hash = window.location.hash;
  if (hash.startsWith("#/main")) return "main";
  if (hash.startsWith("#/companion")) return "companion";
  const path = window.location.pathname;
  if (path === "/main") return "main";
  if (path === "/companion") return "companion";
  return "dashboard";
}

function renderSurface(surface: Surface): JSX.Element {
  switch (surface) {
    case "main":
      return <MainPage />;
    case "companion":
      return <CompanionPage />;
    case "dashboard":
      return <App />;
  }
}

const surface = resolveSurface();
document.documentElement.dataset["yuviSurface"] = surface;
const rootElement = document.getElementById("root") as HTMLElement;
createRoot(rootElement).render(<StrictMode>{renderSurface(surface)}</StrictMode>);
