/**
 * Download + verify official Windows x64 Node distribution.
 * Cache: .cache/desktop-package/
 * Override archive with YUVI_NODE_ARCHIVE (path to zip).
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import {
  CACHE_DIR,
  NODE_ARCHIVE_NAME,
  NODE_DIST_URL,
  NODE_EXE_NAME,
  NODE_VERSION,
  RUNTIME_OUT_DIR
} from "./constants.mjs";
import { assertFile, ensureDir } from "./paths.mjs";

export async function fetchOfficialSha256(version, archiveName) {
  const url = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch SHASUMS256.txt: HTTP ${response.status}`);
  }
  const text = await response.text();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+(\S+)$/i);
    if (!match) continue;
    if (match[2] === archiveName) {
      return match[1].toLowerCase();
    }
  }
  throw new Error(`SHA-256 for ${archiveName} not found in SHASUMS256.txt`);
}

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export async function ensureNodeArchive() {
  ensureDir(CACHE_DIR);
  const override = process.env["YUVI_NODE_ARCHIVE"]?.trim();
  if (override) {
    assertFile(override, "YUVI_NODE_ARCHIVE");
    return path.resolve(override);
  }
  const dest = path.join(CACHE_DIR, NODE_ARCHIVE_NAME);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    return dest;
  }
  console.info(`[desktop-package] downloading Node ${NODE_VERSION}: ${NODE_DIST_URL}`);
  const response = await fetch(NODE_DIST_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Node download failed: HTTP ${response.status}`);
  }
  const tmp = `${dest}.partial`;
  await pipeline(response.body, createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

export async function verifyArchive(archivePath) {
  const expected =
    process.env["YUVI_NODE_SHA256"]?.trim().toLowerCase() ||
    (await fetchOfficialSha256(NODE_VERSION, NODE_ARCHIVE_NAME));
  const actual = sha256File(archivePath);
  if (actual !== expected) {
    throw new Error(
      `Node archive SHA-256 mismatch for ${path.basename(archivePath)}: expected ${expected}, got ${actual}`
    );
  }
  return expected;
}

export async function extractNodeExe(archivePath, runtimeOutDir) {
  ensureDir(runtimeOutDir);
  const extractRoot = path.join(CACHE_DIR, `extract-${NODE_VERSION}`);
  if (fs.existsSync(extractRoot)) {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
  ensureDir(extractRoot);

  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractRoot.replace(/'/g, "''")}' -Force`
      ],
      { stdio: "inherit" }
    );
  } else {
    execFileSync("unzip", ["-o", archivePath, "-d", extractRoot], { stdio: "inherit" });
  }

  const folder = path.join(extractRoot, `node-v${NODE_VERSION}-win-x64`);
  const nodeSrc = path.join(folder, NODE_EXE_NAME);
  assertFile(nodeSrc, "extracted node.exe");
  const nodeDest = path.join(runtimeOutDir, NODE_EXE_NAME);
  fs.copyFileSync(nodeSrc, nodeDest);
  return nodeDest;
}

export async function prepareBundledNode(runtimeOutDir = RUNTIME_OUT_DIR) {
  const archive = await ensureNodeArchive();
  await verifyArchive(archive);
  const nodeExe = await extractNodeExe(archive, runtimeOutDir);
  assertFile(nodeExe, "bundled node.exe");
  return nodeExe;
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  prepareBundledNode()
    .then((exe) => {
      console.info(`[desktop-package] node ready: ${exe}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
