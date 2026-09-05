#!/usr/bin/env node
/**
 * Download CPU STT / speaker models into ~/.local/share/yuvi/models/stt.
 * Does not commit weights. Verifies extracted files against the pinned manifest.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_STT_ASSETS = [
  {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
    archive: true,
    keep: [
      "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx",
      "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tokens.txt",
      "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/LICENSE"
    ]
  },
  {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    archive: false
  },
  {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
    archive: true
  },
  {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/0-four-speakers-zh.wav",
    archive: false
  }
];

/** Optional Silero VAD weights used by live speech activity. Not required for transcription. */
export const LOCAL_STT_VAD_ASSET = {
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
  archive: false
};

function download(url, outPath, execFileSyncImpl) {
  if (fs.existsSync(outPath)) return;
  const partial = `${outPath}.partial`;
  execFileSyncImpl("curl", ["-L", "--fail", "--retry", "3", "-o", partial, url], {
    stdio: "inherit"
  });
  fs.renameSync(partial, outPath);
}

export function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function downloadLocalSttModels(options = {}) {
  const dest =
    options.dest ??
    process.env.YUVI_STT_MODEL_DIR?.trim() ??
    path.join(os.homedir(), ".local", "share", "yuvi", "models", "stt");
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const tmp = path.join(dest, "tmp");
  fs.mkdirSync(tmp, { recursive: true });

  for (const asset of LOCAL_STT_ASSETS) {
    const name = path.basename(new URL(asset.url).pathname);
    const packed = path.join(tmp, name);
    console.log(`fetch ${asset.url}`);
    download(asset.url, packed, execFileSyncImpl);
    if (asset.archive) {
      const entries = asset.keep ?? [];
      execFileSyncImpl("tar", ["-xjf", packed, "-C", dest, ...entries], { stdio: "inherit" });
    } else {
      fs.copyFileSync(packed, path.join(dest, name));
    }
  }

  const manifestPath = path.join(repoRoot, "services", "local-stt", "models.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const model of manifest.models) {
    const filePath = path.join(dest, model.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`missing required model ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    const actualSha256 = sha256(filePath);
    if (actualSha256 !== model.sha256 || stat.size !== model.bytes) {
      throw new Error(
        `checksum mismatch for ${model.id}: expected ${model.sha256}/${model.bytes}, received ${actualSha256}/${stat.size}`
      );
    }
    console.log(`${model.id} verified sha256=${actualSha256} bytes=${stat.size}`);
  }
  for (const file of manifest.runtimeFiles ?? []) {
    const filePath = path.join(dest, file);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`missing required local STT runtime file ${filePath}`);
    }
  }
  const vadName = path.basename(new URL(LOCAL_STT_VAD_ASSET.url).pathname);
  const vadPacked = path.join(tmp, vadName);
  const vadDest = path.join(dest, vadName);
  if (!fs.existsSync(vadDest)) {
    console.log(`fetch ${LOCAL_STT_VAD_ASSET.url}`);
    download(LOCAL_STT_VAD_ASSET.url, vadPacked, execFileSyncImpl);
    fs.copyFileSync(vadPacked, vadDest);
  }
  console.log(`models ready in ${dest}`);
  return { dest, manifest };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    downloadLocalSttModels();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
