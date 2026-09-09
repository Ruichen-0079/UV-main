/** Prepare Linux x64 immutable daily packaged resources. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, MEMORY_MIGRATIONS_DIR } from "./constants.mjs";
import { buildLinuxWeb } from "./build-linux-web.mjs";
import { bundleSupervisorCjs } from "./build-supervisor.mjs";
import { bundleRuntimeServer } from "./build-runtime.mjs";
import {
  buildPackagedLocalStt,
  ensureLinuxLocalSttPython,
  validateLocalSttArtifact
} from "./build-local-stt.mjs";
import { downloadLocalSttModels } from "../download-local-stt-models.mjs";
import { assertFile, assertDir, ensureDir, writeJson } from "./paths.mjs";
/** Linux packaged Node (official nodejs.org linux-x64). Independent of Windows pkg pin. */
export const NODE_VERSION = "24.20.0";
export const LINUX_TRIPLE = "linux-x64";
export const LINUX_BUILD_ROOT = path.join(REPO_ROOT, "build", "desktop", LINUX_TRIPLE);
const NODE_ARCHIVE = `node-v${NODE_VERSION}-linux-x64.tar.gz`;
const NODE_URL = `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`;
const CACHE = process.env.YUVI_NODE_CACHE?.trim()
  ? path.resolve(process.env.YUVI_NODE_CACHE.trim())
  : path.join(REPO_ROOT, ".cache", "desktop-package");
function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
function checkoutSha() {
  const envSha = process.env.GITHUB_SHA?.trim();
  if (envSha && /^[0-9a-f]{40}$/i.test(envSha)) return envSha.toLowerCase();
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" })
    .trim()
    .toLowerCase();
}
async function fetchSha(archiveName) {
  const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`);
  if (!res.ok) throw new Error("SHASUMS256 fetch failed");
  for (const line of (await res.text()).split(/\r?\n/)) {
    const m = line.match(/^([a-f0-9]{64})\s+(\S+)$/i);
    if (m && m[2] === archiveName) return m[1].toLowerCase();
  }
  throw new Error("SHA not found for " + archiveName);
}
async function ensureLinuxNodeArchive() {
  ensureDir(CACHE);
  const dest = path.join(CACHE, NODE_ARCHIVE);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000000) return dest;
  console.info("[linux-daily] downloading", NODE_URL);
  const res = await fetch(NODE_URL);
  if (!res.ok || !res.body) throw new Error("Node download failed " + res.status);
  const tmp = dest + ".partial";
  await pipeline(res.body, createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}
async function prepareLinuxNode(runtimeDir) {
  const archive = await ensureLinuxNodeArchive();
  const expected =
    process.env.YUVI_NODE_SHA256?.trim().toLowerCase() || (await fetchSha(NODE_ARCHIVE));
  const actual = sha256File(archive);
  if (actual !== expected) throw new Error(`Node SHA mismatch: ${actual} != ${expected}`);
  const extractRoot = path.join(CACHE, `extract-linux-${NODE_VERSION}`);
  fs.rmSync(extractRoot, { recursive: true, force: true });
  ensureDir(extractRoot);
  execFileSync("tar", ["-xzf", archive, "-C", extractRoot], { stdio: "inherit" });
  const nodeSrc = path.join(extractRoot, `node-v${NODE_VERSION}-linux-x64`, "bin", "node");
  assertFile(nodeSrc, "extracted linux node");
  ensureDir(runtimeDir);
  const nodeDest = path.join(runtimeDir, "node");
  fs.copyFileSync(nodeSrc, nodeDest);
  fs.copyFileSync(path.join(extractRoot, `node-v${NODE_VERSION}-linux-x64`, "LICENSE"), path.join(runtimeDir, "Node.LICENSE.txt"));
  fs.chmodSync(nodeDest, 0o755);
  return nodeDest;
}
function copyTreeFiltered(src, dest, skipNames) {
  ensureDir(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipNames.has(ent.name) || /^\.env(?:\.|$)/.test(ent.name)) continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyTreeFiltered(from, to, skipNames);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}
export async function prepareLinuxDailyPackage() {
  console.info("[linux-daily] prepare start");
  const out = LINUX_BUILD_ROOT;
  fs.rmSync(out, { recursive: true, force: true });
  const supervisorDir = path.join(out, "supervisor");
  const runtimeDir = path.join(out, "runtime");
  const webDir = path.join(out, "web");
  ensureDir(supervisorDir);
  ensureDir(runtimeDir);
  ensureDir(webDir);
  await prepareLinuxNode(runtimeDir);
  const cjs = await bundleSupervisorCjs(supervisorDir);
  assertFile(cjs, "supervisor cjs");
  const runtime = await bundleRuntimeServer(runtimeDir);
  fs.rmSync(runtime.metafilePath);
  const manifest = JSON.parse(fs.readFileSync(runtime.manifestPath, "utf8"));
  manifest.platform = "linux";
  manifest.arch = "x64";
  manifest.nodeExecutable = "node";
  writeJson(runtime.manifestPath, manifest);
  const migDest = path.join(runtimeDir, "migrations");
  ensureDir(migDest);
  for (const name of fs.readdirSync(MEMORY_MIGRATIONS_DIR)) {
    if (name.endsWith(".sql"))
      fs.copyFileSync(path.join(MEMORY_MIGRATIONS_DIR, name), path.join(migDest, name));
  }
  await buildLinuxWeb();
  const webDistSrc = path.join(REPO_ROOT, "apps", "web", "dist");
  assertDir(webDistSrc, "apps/web/dist");
  copyTreeFiltered(webDistSrc, path.join(webDir, "dist"), new Set());
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "desktop-package", "linux-static-web-server.mjs"),
    path.join(webDir, "static-server.mjs")
  );
  const modelDir = path.join(REPO_ROOT, "build", "desktop", "local-stt-models");
  downloadLocalSttModels({ dest: modelDir });
  const python = ensureLinuxLocalSttPython({
    venvDir: path.join(REPO_ROOT, "build", ".local-stt-venv")
  });
  const localSttDir = path.join(out, "local-stt");
  buildPackagedLocalStt({
    python,
    targetPlatform: "linux",
    artifactDir: localSttDir,
    modelDir
  });
  validateLocalSttArtifact(localSttDir, { repoRoot: REPO_ROOT });
  fs.copyFileSync(
    path.join(localSttDir, "THIRD_PARTY_NOTICES.md"),
    path.join(out, "THIRD_PARTY_NOTICES.local-stt.md")
  );
  const sha = checkoutSha();
  writeJson(path.join(out, "install-manifest.json"), {
    schemaVersion: 1,
    kind: "yuvi-linux-daily-packaged",
    platform: LINUX_TRIPLE,
    checkoutSha: sha,
    nodeVersion: NODE_VERSION,
    components: [
      "supervisor.cjs",
      "runtime.mjs",
      "bundled-node",
      "static-web",
      "local-stt-sidecar",
      "local-stt-models",
      "local-stt-notices"
    ],
    privateWeightsBundled: false,
    genericLocalSttWeightsBundled: true,
    externalSidecars: true
  });
  fs.copyFileSync(
    path.join(REPO_ROOT, "scripts", "desktop-package", "install-linux-daily.mjs"),
    path.join(out, "install-linux-daily.mjs")
  );
  fs.copyFileSync(path.join(REPO_ROOT, "scripts/desktop-package/yuvi-linux"), path.join(out, "yuvi"));
  fs.chmodSync(path.join(out, "yuvi"), 0o755);
  fs.copyFileSync(path.join(REPO_ROOT, "scripts/desktop-package/linux-launcher.mjs"), path.join(out, "launcher.mjs"));
  console.info("[linux-daily] prepared", out);
  return { outRoot: out, checkoutSha: sha };
}
const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  prepareLinuxDailyPackage().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
