/**
 * Desktop (Tauri) runtime helpers shared by API client and surface routing.
 * Packaged builds have no Vite /api proxy — talk to local Runtime directly.
 */

export const DEFAULT_RUNTIME_HTTP = "http://127.0.0.1:6121";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * HTTP base for Runtime API.
 * - Explicit VITE_API_BASE_URL wins
 * - Tauri: loopback Runtime (no Vite proxy)
 * - Browser/dev: /api (proxied by Vite)
 */
export function resolveApiBaseUrl(
  env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>
): string {
  const configured = env["VITE_API_BASE_URL"]?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  if (isTauriRuntime()) {
    return DEFAULT_RUNTIME_HTTP;
  }
  return "/api";
}

/** Map legacy `/api/...` asset paths to absolute Runtime URLs in Tauri. */
export function resolveRuntimeAssetUrl(pathOrUrl: string): string {
  if (
    pathOrUrl.startsWith("http://") ||
    pathOrUrl.startsWith("https://") ||
    pathOrUrl.startsWith("data:") ||
    pathOrUrl.startsWith("blob:")
  ) {
    return pathOrUrl;
  }
  if (!isTauriRuntime()) {
    return pathOrUrl;
  }
  const base = resolveApiBaseUrl();
  // /api/live2d/... → http://127.0.0.1:6121/live2d/...
  if (pathOrUrl.startsWith("/api/")) {
    return `${base}${pathOrUrl.slice(4)}`;
  }
  if (pathOrUrl.startsWith("/")) {
    return `${base}${pathOrUrl}`;
  }
  return `${base}/${pathOrUrl}`;
}

export type DesktopSurface = "dashboard" | "main" | "companion";

export function surfaceFromLocation(input: {
  hash: string;
  pathname: string;
  tauriLabel?: string | undefined;
}): DesktopSurface {
  if (input.tauriLabel === "main") return "main";
  if (input.tauriLabel === "companion") return "companion";
  if (input.tauriLabel === "dashboard") return "dashboard";
  const hash = input.hash;
  if (hash.startsWith("#/dashboard")) return "dashboard";
  if (hash.startsWith("#/companion")) return "companion";
  if (hash.startsWith("#/main")) return "main";
  const path = input.pathname;
  if (path === "/dashboard" || path.endsWith("/dashboard")) return "dashboard";
  if (path === "/companion" || path.endsWith("/companion")) return "companion";
  if (path === "/main" || path.endsWith("/main")) return "main";
  return "main";
}

/**
 * Prefer Tauri window label (reliable in packaged builds) over hash routing.
 * Hash is kept for browser debugging and as a fallback.
 * Browser default is Product UI (`main`); the developer dashboard is `#/dashboard`.
 */
export async function resolveDesktopSurface(): Promise<DesktopSurface> {
  let tauriLabel: string | undefined;
  if (isTauriRuntime()) {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      tauriLabel = getCurrentWindow().label;
    } catch {
      // fall through to hash
    }
  }

  if (typeof window === "undefined") {
    return surfaceFromLocation({ hash: "", pathname: "/", tauriLabel });
  }
  return surfaceFromLocation({
    hash: window.location.hash,
    pathname: window.location.pathname,
    tauriLabel
  });
}
