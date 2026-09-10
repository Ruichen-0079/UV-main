import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { assertFontCoverage } from "./font-coverage.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PRODUCT_FONT_ROOT = path.join(repoRoot, "apps", "web", "public", "yuvi-fonts");
export const PRODUCT_FONT_MANIFEST = path.join(PRODUCT_FONT_ROOT, "fonts-manifest.json");

export const PRODUCT_FONTS = Object.freeze([
  Object.freeze({
    family: "YUVI Noto Sans SC",
    filename: "NotoSansSC-VF.ttf",
    version: "2.004",
    revision: "523d033d6cb47f4a80c58a35753646f5c3608a78",
    upstreamRevision: "523d033d6cb47f4a80c58a35753646f5c3608a78",
    source:
      "https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf",
    licenseSource:
      "https://raw.githubusercontent.com/notofonts/noto-cjk/523d033d6cb47f4a80c58a35753646f5c3608a78/LICENSE",
    licenseFilename: "Noto-Sans-SC-OFL-1.1.txt",
    minimumBytes: 10_000_000,
    coverageSample: "YUVI 设置 记忆 模型 提供商 路由 伴侣 字幕 你好，。！？“”《》AaZz09—()[]{}<>/@#&+="
  }),
  Object.freeze({
    family: "YUVI Noto Sans Mono",
    filename: "NotoSansMono-VF.ttf",
    version: "2.014",
    revision: "8e44913e4ff26fc997e6856c1ec40ff4791c98c5",
    upstreamRevision: "9b7310b8f99fcd2583c49606e6aefca13a391350",
    source:
      "https://raw.githubusercontent.com/google/fonts/8e44913e4ff26fc997e6856c1ec40ff4791c98c5/ofl/notosansmono/NotoSansMono%5Bwdth%2Cwght%5D.ttf",
    licenseSource:
      "https://raw.githubusercontent.com/google/fonts/8e44913e4ff26fc997e6856c1ec40ff4791c98c5/ofl/notosansmono/OFL.txt",
    licenseFilename: "Noto-Sans-Mono-OFL-1.1.txt",
    minimumBytes: 500_000,
    coverageSample: "YUVI AaZz09_-/.:;()[]{}<>@#&+=`'\"\\|*!?"
  })
]);

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function hasOpenTypeSignature(file) {
  const header = fs.readFileSync(file).subarray(0, 4);
  return (
    header.equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) ||
    header.equals(Buffer.from("OTTO")) ||
    header.equals(Buffer.from("true"))
  );
}

function existingManifest() {
  try {
    return JSON.parse(fs.readFileSync(PRODUCT_FONT_MANIFEST, "utf8"));
  } catch {
    return null;
  }
}

function cachedFontMatches(asset, manifest) {
  const destination = path.join(PRODUCT_FONT_ROOT, asset.filename);
  if (!manifest || !fs.existsSync(destination)) return false;
  const entry = manifest.fonts?.find?.((font) => font.filename === asset.filename);
  if (!entry) return false;
  const stat = fs.statSync(destination);
  return (
    stat.isFile() &&
    stat.size >= asset.minimumBytes &&
    hasOpenTypeSignature(destination) &&
    entry.revision === asset.revision &&
    entry.source === asset.source &&
    entry.bytes === stat.size &&
    entry.sha256 === sha256File(destination)
  );
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Font resource download failed (${response.status}) from ${url}`);
  }
  const tmp = `${destination}.${process.pid}.partial`;
  fs.rmSync(tmp, { force: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, destination);
}

async function ensureFont(asset, priorManifest) {
  fs.mkdirSync(PRODUCT_FONT_ROOT, { recursive: true });
  const destination = path.join(PRODUCT_FONT_ROOT, asset.filename);
  if (!cachedFontMatches(asset, priorManifest)) {
    await downloadFile(asset.source, destination);
  }
  const stat = fs.statSync(destination);
  if (!stat.isFile() || stat.size < asset.minimumBytes || !hasOpenTypeSignature(destination)) {
    throw new Error(`Prepared font failed validation: ${asset.filename}`);
  }
  assertFontCoverage(destination, asset.coverageSample, asset.family);
  return {
    family: asset.family,
    filename: asset.filename,
    version: asset.version,
    revision: asset.revision,
    upstreamRevision: asset.upstreamRevision,
    source: asset.source,
    bytes: stat.size,
    sha256: sha256File(destination),
    license: "OFL-1.1",
    licenseFilename: asset.licenseFilename,
    coverageSample: asset.coverageSample
  };
}

async function ensureLicense(asset) {
  const licenseDir = path.join(PRODUCT_FONT_ROOT, "licenses");
  fs.mkdirSync(licenseDir, { recursive: true });
  const destination = path.join(licenseDir, asset.licenseFilename);
  if (!fs.existsSync(destination) || fs.statSync(destination).size < 1_000) {
    await downloadFile(asset.licenseSource, destination);
  }
  const text = fs.readFileSync(destination, "utf8");
  if (!/SIL OPEN FONT LICENSE/i.test(text) || !/Version 1\.1/i.test(text)) {
    throw new Error(`Prepared font license failed validation: ${asset.licenseFilename}`);
  }
  return {
    filename: asset.licenseFilename,
    source: asset.licenseSource,
    bytes: Buffer.byteLength(text),
    sha256: sha256Buffer(Buffer.from(text))
  };
}

export async function prepareProductFonts() {
  const prior = existingManifest();
  const fonts = [];
  const licenses = [];
  for (const asset of PRODUCT_FONTS) {
    fonts.push(await ensureFont(asset, prior));
    licenses.push(await ensureLicense(asset));
  }
  const manifest = {
    schemaVersion: 1,
    runtimeNetworkFetch: false,
    bodyFamily: "YUVI Noto Sans SC",
    monospaceFamily: "YUVI Noto Sans Mono",
    fontBytes: fonts.reduce((sum, font) => sum + font.bytes, 0),
    fonts,
    licenses
  };
  fs.writeFileSync(PRODUCT_FONT_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.info(
    `[fonts] prepared ${fonts.length} offline fonts (${manifest.fontBytes} bytes) under ${PRODUCT_FONT_ROOT}`
  );
  return manifest;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  prepareProductFonts().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
