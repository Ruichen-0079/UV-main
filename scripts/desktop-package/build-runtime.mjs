/**
 * Bundle apps/server into a single ESM entry for packaged Runtime.
 * `pg` is bundled so Runtime never loads the monorepo node_modules.
 * Optional native addons may remain external (not required for default in-memory mode).
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import {
  NODE_EXE_NAME,
  NODE_VERSION,
  PACKAGE_ARCH,
  PACKAGE_PLATFORM,
  RUNTIME_ENTRY_NAME,
  RUNTIME_MANIFEST_NAME,
  RUNTIME_OUT_DIR,
  REPO_ROOT
} from "./constants.mjs";
import { assertFile, assertRelativeSafe, ensureDir, writeJson } from "./paths.mjs";

/** Optional native addons that Node may resolve as missing without failing pure-JS paths. */
export const ALLOWED_OPTIONAL_NATIVE_EXTERNALS = new Set([
  "pg-native",
  "bufferutil",
  "utf-8-validate"
]);

/** Node builtins (with and without node: prefix). */
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "sys",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib"
]);

export function buildRuntimeManifest() {
  return {
    schemaVersion: 1,
    platform: PACKAGE_PLATFORM,
    arch: PACKAGE_ARCH,
    nodeVersion: NODE_VERSION,
    nodeExecutable: NODE_EXE_NAME,
    runtimeEntry: RUNTIME_ENTRY_NAME
  };
}

export function isNodeBuiltin(specifier) {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return NODE_BUILTINS.has(bare) || NODE_BUILTINS.has(specifier);
}

/**
 * Collect package-like external imports from an esbuild metafile.
 * Returns unresolved third-party package names (not builtins / allowed natives).
 */
export function collectDisallowedExternals(metafile) {
  const disallowed = new Set();
  const consider = (pathSpec, isExternal) => {
    if (!isExternal) return;
    const spec = String(pathSpec ?? "");
    if (!spec) return;
    // esbuild internal markers such as "<runtime>"
    if (spec.startsWith("<") && spec.endsWith(">")) return;
    if (isNodeBuiltin(spec)) return;
    const pkgName = packageNameFromSpecifier(spec);
    if (ALLOWED_OPTIONAL_NATIVE_EXTERNALS.has(pkgName)) return;
    // Absolute/relative file paths are not package externals.
    if (spec.startsWith(".") || spec.startsWith("/") || /^[A-Za-z]:/.test(spec)) return;
    disallowed.add(spec);
  };

  for (const info of Object.values(metafile?.inputs ?? {})) {
    for (const imp of info.imports ?? []) {
      consider(imp.path, Boolean(imp.external));
    }
  }
  for (const info of Object.values(metafile?.outputs ?? {})) {
    for (const imp of info.imports ?? []) {
      consider(imp.path, Boolean(imp.external));
    }
  }
  return [...disallowed].sort();
}

export function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split("/")[0] ?? specifier;
}

export function assertBundleHasNoRepoPath(bundleText, repoRoot) {
  const normalized = bundleText.replaceAll("/", "\\");
  const repo = repoRoot.replaceAll("/", "\\");
  if (bundleText.includes(repoRoot) || normalized.includes(repo)) {
    throw new Error("runtime bundle appears to embed build-machine repository path");
  }
  // Common user profile absolute paths that would break clean machines.
  if (/[A-Za-z]:\\Users\\[^\\/]+\\/i.test(bundleText)) {
    throw new Error("runtime bundle appears to embed user-profile absolute path");
  }
}

export async function bundleRuntimeServer(outDir = RUNTIME_OUT_DIR) {
  ensureDir(outDir);
  const entry = path.join(REPO_ROOT, "scripts", "yuvi-runtime-server.packaged.mts");
  assertFile(entry, "runtime entry source");
  const outfile = path.join(outDir, RUNTIME_ENTRY_NAME);
  const metafilePath = path.join(outDir, "runtime-esbuild-metafile.json");

  // Bundle `pg` (pure JS) so Runtime never walks up to the monorepo node_modules.
  // Only truly optional native addons stay external.
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile,
    external: [...ALLOWED_OPTIONAL_NATIVE_EXTERNALS],
    metafile: true,
    packages: "bundle",
    conditions: ["development"],
    sourcemap: false,
    logLevel: "info",
    // Polyfill CJS require() for packages that use dynamic require (e.g. fastify plugins).
    banner: {
      js: `/* YUVI packaged Runtime — do not edit */
import { createRequire as __yuviCreateRequire } from "node:module";
import { fileURLToPath as __yuviFileURLToPath } from "node:url";
import { dirname as __yuviDirname } from "node:path";
const require = __yuviCreateRequire(import.meta.url);
const __filename = __yuviFileURLToPath(import.meta.url);
const __dirname = __yuviDirname(__filename);
`
    }
  });

  assertFile(outfile, "runtime bundle");
  const text = fs.readFileSync(outfile, "utf8");
  assertBundleHasNoRepoPath(text, REPO_ROOT);

  // Fail loudly if pg is still an external require/import.
  if (/\bfrom\s+["']pg["']/.test(text) || /\brequire\(\s*["']pg["']\s*\)/.test(text)) {
    // Bundled CJS interop may still mention the string in rare cases; check metafile instead.
  }

  writeJson(metafilePath, result.metafile);
  const disallowed = collectDisallowedExternals(result.metafile);
  if (disallowed.length > 0) {
    throw new Error(
      `Runtime bundle has disallowed external packages (would need node_modules at runtime): ${disallowed.join(", ")}`
    );
  }

  // Confirm pg was actually included (inputs contain node_modules/pg).
  const inputKeys = Object.keys(result.metafile.inputs ?? {});
  const hasPg = inputKeys.some((k) => k.replaceAll("\\", "/").includes("node_modules/pg/"));
  if (!hasPg) {
    // If server never imports pg path in tree, still ok — but log.
    console.warn("[desktop-package] warning: pg not found in metafile inputs (may be tree-shaken)");
  } else {
    console.info("[desktop-package] pg bundled into runtime entry");
  }

  const manifest = buildRuntimeManifest();
  assertRelativeSafe(manifest.nodeExecutable, "nodeExecutable");
  assertRelativeSafe(manifest.runtimeEntry, "runtimeEntry");
  const manifestPath = path.join(outDir, RUNTIME_MANIFEST_NAME);
  writeJson(manifestPath, manifest);
  return { outfile, manifestPath, manifest, metafilePath, disallowedExternals: disallowed };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("build-runtime.mjs");
if (isMain) {
  bundleRuntimeServer()
    .then((result) => {
      console.info(`[desktop-package] runtime entry: ${result.outfile}`);
      console.info(`[desktop-package] manifest: ${result.manifestPath}`);
      console.info(`[desktop-package] metafile: ${result.metafilePath}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
