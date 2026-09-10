/**
 * Provision a user-obtained Live2D Cubism Core into YUVI durable data.
 *
 * Cubism Core is proprietary and is intentionally not fetched or mirrored by
 * this script. The source path is a one-shot import input only; Runtime later
 * resolves the managed copy from <YUVI data root>/CubismCore.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CUBISM_CORE_FILENAME = "live2dcubismcore.min.js";
export const CUBISM_CORE_DIRECTORY = "CubismCore";
export const CUBISM_CORE_PROVENANCE_FILENAME = "provenance.json";

const OFFICIAL_DOWNLOAD_URL = "https://www.live2d.com/en/sdk/download/web/";
const OFFICIAL_LICENSE_URL =
  "https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html";

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertAbsoluteRoot(root) {
  if (!root || !path.isAbsolute(root)) {
    throw new Error("YUVI Cubism Core data root must be an absolute path.");
  }
  return path.resolve(root);
}

export function resolveLinuxYuviDataRoot({ env = process.env, home = os.homedir() } = {}) {
  const explicit = env.YUVI_DATA_ROOT?.trim();
  if (explicit) return assertAbsoluteRoot(explicit);

  const xdgData = env.XDG_DATA_HOME?.trim();
  const dataHome = xdgData && path.isAbsolute(xdgData) ? xdgData : path.join(home, ".local", "share");
  return path.resolve(dataHome, "YUVI");
}

export function resolveCubismCoreDestination(dataRoot) {
  const root = assertAbsoluteRoot(dataRoot);
  return path.join(root, CUBISM_CORE_DIRECTORY, CUBISM_CORE_FILENAME);
}

export function inspectCubismCoreSource(sourcePath) {
  if (!sourcePath) throw new Error("Provide the official Cubism Core file to import.");
  const source = path.resolve(sourcePath);
  if (path.basename(source) !== CUBISM_CORE_FILENAME) {
    throw new Error(`Cubism Core must be named exactly ${CUBISM_CORE_FILENAME}.`);
  }

  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch {
    throw new Error(`Cubism Core source is unavailable: ${source}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Cubism Core source must be a regular file, not a directory or symlink.");
  }
  if (stat.size <= 0) throw new Error("Cubism Core source is empty.");

  return Object.freeze({ source, bytes: stat.size, sha256: sha256File(source) });
}

function writeJsonAtomic(file, value, mode) {
  const dir = path.dirname(file);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
}

export function provisionCubismCore({ sourcePath, dataRoot }) {
  const source = inspectCubismCoreSource(sourcePath);
  const destination = resolveCubismCoreDestination(dataRoot);
  const destinationDir = path.dirname(destination);
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });

  const tmp = path.join(
    destinationDir,
    `.${CUBISM_CORE_FILENAME}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  fs.copyFileSync(source.source, tmp);
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, destination);

  const installed = {
    schemaVersion: 1,
    component: "Live2D Cubism Core for Web",
    filename: CUBISM_CORE_FILENAME,
    bytes: source.bytes,
    sha256: source.sha256,
    sourceKind: "user-provisioned-official-sdk",
    redistributedByYuvi: false,
    officialDownload: OFFICIAL_DOWNLOAD_URL,
    license: OFFICIAL_LICENSE_URL
  };
  writeJsonAtomic(
    path.join(destinationDir, CUBISM_CORE_PROVENANCE_FILENAME),
    installed,
    0o644
  );
  return Object.freeze({ destination, ...installed });
}

export function cubismCoreStatus({ dataRoot }) {
  const destination = resolveCubismCoreDestination(dataRoot);
  try {
    const stat = fs.statSync(destination);
    if (!stat.isFile() || stat.size <= 0) return { installed: false, destination };
    return {
      installed: true,
      destination,
      filename: CUBISM_CORE_FILENAME,
      bytes: stat.size,
      sha256: sha256File(destination)
    };
  } catch {
    return { installed: false, destination };
  }
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function runCli() {
  const args = process.argv.slice(2);
  const dataRoot = valueAfter(args, "--data-root") || resolveLinuxYuviDataRoot();
  if (args.includes("--status")) {
    console.log(JSON.stringify(cubismCoreStatus({ dataRoot }), null, 2));
    return;
  }
  const sourcePath = valueAfter(args, "--from");
  if (!sourcePath) {
    throw new Error(
      `Usage: provision-cubism-core.mjs --from /path/to/${CUBISM_CORE_FILENAME} [--data-root /absolute/YUVI/data]`
    );
  }
  const result = provisionCubismCore({ sourcePath, dataRoot });
  console.log(
    `Cubism Core provisioned: ${result.destination}\nsha256=${result.sha256}\nRestart YUVI before loading Live2D.`
  );
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
