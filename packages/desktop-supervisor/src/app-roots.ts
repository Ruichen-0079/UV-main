import path from "node:path";
import { canonicalPath, isWindowsStylePath } from "./paths.js";

/**
 * YUVI per-user application root contract (Atom 05).
 *
 * Three roots with distinct semantics:
 * - config: user-editable configuration and non-secret settings. Never
 *   runtime ephemeral state; never plaintext secrets (secret values stay in
 *   the platform credential authority).
 * - data: durable user-owned state that must survive cache clears (Memory,
 *   speaker profiles, private PostgreSQL cluster, durable runtime state).
 * - cache: rebuildable/derived artifacts. Deletion must never erase durable
 *   state, so nothing durable may derive from the cache root.
 *
 * Installation resources are deliberately NOT part of this contract; they are
 * immutable and resolved separately (`SupervisorLayout.resourceRoot`).
 *
 * Namespace: the YUVI-managed data/cache roots use the stable `YUVI` name.
 * The config root follows the Tauri app identifier (`com.yuvi.companion`,
 * see apps/desktop/src-tauri/tauri.conf.json) because user settings live in
 * the Tauri-owned config directory; this resolver never re-homes it.
 *
 * Linux-first: unix defaults follow XDG Base Directory semantics. Windows
 * keeps the existing deterministic composition (`%LOCALAPPDATA%/YUVI`).
 * Resolution is pure and deterministic: same inputs, same roots, no fs access.
 */

export const YUVI_APP_IDENTIFIER = "com.yuvi.companion";
export const YUVI_DATA_HOME_DIRNAME = "YUVI";

export type AppRoots = {
  /** User-editable configuration root (settings.json, non-secret config). */
  configRoot: string;
  /** Durable user-owned state root; survives cache clears. */
  dataRoot: string;
  /** Rebuildable artifacts root; deletion must not erase durable state. */
  cacheRoot: string;
};

export type ResolveAppRootsOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
};

export function resolveAppRoots(options: ResolveAppRootsOptions = {}): AppRoots {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  return {
    configRoot: resolveRoot(env, "YUVI_CONFIG_ROOT", () => defaultConfigRoot(env, platform)),
    dataRoot: resolveRoot(env, "YUVI_DATA_ROOT", () => defaultDataRoot(env, platform)),
    cacheRoot: resolveRoot(env, "YUVI_CACHE_ROOT", () => defaultCacheRoot(env, platform))
  };
}

/**
 * Durable YUVI data-home default. Delegates to the AppRoots contract:
 * identical `YUVI_DATA_ROOT` override semantics (absolute paths only) and
 * identical Windows composition (`%LOCALAPPDATA%/YUVI`). Historically this
 * resolver is env-driven, so a `LOCALAPPDATA` value selects the Windows
 * branch on any host; otherwise the host platform applies (unix defaults
 * follow XDG data-home semantics). Packaged launches set `YUVI_DATA_ROOT`
 * explicitly so PG/Live2D/Mem0 defaults always resolve inside the
 * launcher-selected YUVI data home.
 */
export function defaultYuviLocalDataRoot(
  env: Record<string, string | undefined> = process.env
): string {
  const platform = env["LOCALAPPDATA"]?.trim() ? "win32" : process.platform;
  return resolveAppRoots({ env, platform }).dataRoot;
}

function resolveRoot(
  env: Record<string, string | undefined>,
  overrideKey: string,
  fallback: () => string
): string {
  const explicit = env[overrideKey]?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit) && !isWindowsStylePath(explicit)) {
      throw new Error(`${overrideKey} must be an absolute path.`);
    }
    return canonicalPath(explicit);
  }
  return canonicalPath(fallback());
}

function defaultConfigRoot(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return path.join(win32ConfigHome(env), YUVI_APP_IDENTIFIER);
  }
  return path.join(xdgHome(env, "XDG_CONFIG_HOME", ".config"), YUVI_APP_IDENTIFIER);
}

function defaultDataRoot(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    // Mirrors the historical Windows composition: LOCALAPPDATA/YUVI.
    const localAppData = env["LOCALAPPDATA"]?.trim();
    if (localAppData) {
      return path.join(localAppData, YUVI_DATA_HOME_DIRNAME);
    }
    return path.join(posixOrUserProfileHome(env), ".yuvi");
  }
  return path.join(xdgHome(env, "XDG_DATA_HOME", path.join(".local", "share")), YUVI_DATA_HOME_DIRNAME);
}

function defaultCacheRoot(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"]?.trim();
    if (localAppData) {
      return path.join(localAppData, YUVI_DATA_HOME_DIRNAME, "cache");
    }
    return path.join(posixOrUserProfileHome(env), ".yuvi", "cache");
  }
  return path.join(xdgHome(env, "XDG_CACHE_HOME", ".cache"), YUVI_DATA_HOME_DIRNAME);
}

function xdgHome(
  env: Record<string, string | undefined>,
  variable: string,
  fallbackSuffix: string
): string {
  const explicit = env[variable]?.trim();
  if (explicit && path.isAbsolute(explicit)) {
    return explicit;
  }
  return path.join(posixOrUserProfileHome(env), fallbackSuffix);
}

function win32ConfigHome(env: Record<string, string | undefined>): string {
  const appData = env["APPDATA"]?.trim();
  if (appData) return appData;
  const localAppData = env["LOCALAPPDATA"]?.trim();
  if (localAppData) return localAppData;
  return posixOrUserProfileHome(env);
}

function posixOrUserProfileHome(env: Record<string, string | undefined>): string {
  const home = env["HOME"]?.trim() || env["USERPROFILE"]?.trim();
  return home || process.cwd();
}
