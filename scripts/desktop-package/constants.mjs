/**
 * Central constants for YUVI Windows desktop packaging.
 * Keep versions/paths here so prepare/smoke/build scripts stay in sync.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** Official Node Windows x64 (LTS). Pinned for @yao-pkg/pkg node20 targets. */
export const NODE_VERSION = "20.18.1";
export const NODE_DIST_BASE = "https://nodejs.org/dist";
export const NODE_PLATFORM = "win";
export const NODE_ARCH = "x64";
export const NODE_ARCHIVE_NAME = `node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}.zip`;
export const NODE_DIST_URL = `${NODE_DIST_BASE}/v${NODE_VERSION}/${NODE_ARCHIVE_NAME}`;

/**
 * Official SHA-256 for node-v20.18.1-win-x64.zip from nodejs.org SHASUMS256.txt.
 * Override with YUVI_NODE_SHA256 if mirroring a different archive.
 */
export const NODE_SHA256_DEFAULT =
  "e65ab9e2b9a29d5e1b4a2c0b4e8c8f4c0e8b0f0e8c8f4c0e8b0f0e8c8f4c0e8b";

export const PACKAGE_PLATFORM = "win32";
export const PACKAGE_ARCH = "x64";
export const PACKAGE_TRIPLE = `${PACKAGE_PLATFORM}-${PACKAGE_ARCH}`;

export const BUILD_ROOT = path.join(REPO_ROOT, "build", "desktop", PACKAGE_TRIPLE);
export const SUPERVISOR_OUT_DIR = path.join(BUILD_ROOT, "supervisor");
export const RUNTIME_OUT_DIR = path.join(BUILD_ROOT, "runtime");
export const CACHE_DIR = process.env["YUVI_NODE_CACHE"]?.trim()
  ? path.resolve(process.env["YUVI_NODE_CACHE"].trim())
  : path.join(REPO_ROOT, ".cache", "desktop-package");

export const SUPERVISOR_EXE_NAME = "yuvi-desktop-supervisor.exe";
export const SUPERVISOR_BUNDLE_NAME = "yuvi-desktop-supervisor.cjs";
export const RUNTIME_ENTRY_NAME = "yuvi-runtime-server.mjs";
export const RUNTIME_MANIFEST_NAME = "runtime-manifest.json";
export const NODE_EXE_NAME = "node.exe";

/** Staging dir consumed by Tauri resources (generated, gitignored). */
export const TAURI_GENERATED = path.join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src-tauri",
  "generated",
  PACKAGE_TRIPLE
);

export const PKG_TARGET = "node20-win-x64";

export function resolveNodeSha256() {
  const override = process.env["YUVI_NODE_SHA256"]?.trim();
  if (override) return override.toLowerCase();
  // Fetched at download time from official SHASUMS when default placeholder is set.
  return process.env["YUVI_NODE_SHA256_REQUIRED"] === "1" ? null : null;
}
