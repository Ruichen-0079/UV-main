#!/usr/bin/env node
/** Provision the development local-STT runtime and its verified CPU models. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadLocalSttModels } from "./download-local-stt-models.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.resolve(
  process.env.YUVI_LOCAL_STT_RUNTIME_DIR?.trim() ||
    path.join(os.homedir(), ".local", "share", "yuvi", "local-stt")
);
const modelDir = path.resolve(
  process.env.YUVI_STT_MODEL_DIR?.trim() || path.join(runtimeRoot, "models")
);
const venvRoot = path.join(runtimeRoot, ".venv");
const python =
  process.env.YUVI_STT_PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3");
const venvPython =
  process.platform === "win32"
    ? path.join(venvRoot, "Scripts", "python.exe")
    : path.join(venvRoot, "bin", "python");

function run(file, args) {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    shell: false,
    stdio: "inherit",
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`local STT provisioning command failed: ${path.basename(file)}`);
  }
}

fs.mkdirSync(runtimeRoot, { recursive: true });
if (!fs.existsSync(venvPython)) {
  run(python, ["-m", "venv", venvRoot]);
}
run(venvPython, [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "-r",
  path.join(repoRoot, "services", "local-stt", "requirements.txt")
]);
downloadLocalSttModels({ dest: modelDir });

console.log(`local STT runtime ready: ${venvPython}`);
console.log(`local STT models ready: ${modelDir}`);
console.log(
  `set YUVI_LOCAL_STT_START_COMMAND=${venvPython} services/local-stt/server.py --model-dir ${modelDir} --yuvi-local-stt`
);
