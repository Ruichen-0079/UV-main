/**
 * Prepare Windows x64 packaged artifacts and stage them into Tauri generated/.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_ROOT,
  NODE_EXE_NAME,
  RUNTIME_ENTRY_NAME,
  RUNTIME_MANIFEST_NAME,
  RUNTIME_OUT_DIR,
  SUPERVISOR_BUNDLE_NAME,
  SUPERVISOR_EXE_NAME,
  SUPERVISOR_OUT_DIR,
  TAURI_GENERATED
} from "./constants.mjs";
import { buildSupervisor } from "./build-supervisor.mjs";
import { bundleRuntimeServer } from "./build-runtime.mjs";
import { prepareBundledNode } from "./download-node.mjs";
import { assertFile, ensureDir, writeJson } from "./paths.mjs";

export async function prepareDesktopPackage() {
  console.info("[desktop-package] prepare start");
  ensureDir(BUILD_ROOT);
  ensureDir(RUNTIME_OUT_DIR);
  ensureDir(SUPERVISOR_OUT_DIR);

  await prepareBundledNode(RUNTIME_OUT_DIR);
  assertFile(path.join(RUNTIME_OUT_DIR, NODE_EXE_NAME), "node.exe");

  const runtime = await bundleRuntimeServer(RUNTIME_OUT_DIR);
  assertFile(runtime.outfile, "runtime entry");
  assertFile(runtime.manifestPath, "runtime manifest");

  const supervisor = await buildSupervisor(SUPERVISOR_OUT_DIR);
  assertFile(supervisor.cjsPath, "supervisor cjs");

  // Stage into Tauri resources tree.
  const stagedRuntime = path.join(TAURI_GENERATED, "runtime");
  const stagedSupervisor = path.join(TAURI_GENERATED, "supervisor");
  fs.rmSync(TAURI_GENERATED, { recursive: true, force: true });
  ensureDir(stagedRuntime);
  ensureDir(stagedSupervisor);

  copyFile(path.join(RUNTIME_OUT_DIR, NODE_EXE_NAME), path.join(stagedRuntime, NODE_EXE_NAME));
  copyFile(path.join(RUNTIME_OUT_DIR, RUNTIME_ENTRY_NAME), path.join(stagedRuntime, RUNTIME_ENTRY_NAME));
  copyFile(
    path.join(RUNTIME_OUT_DIR, RUNTIME_MANIFEST_NAME),
    path.join(stagedRuntime, RUNTIME_MANIFEST_NAME)
  );
  const metafile = path.join(RUNTIME_OUT_DIR, "runtime-esbuild-metafile.json");
  if (fs.existsSync(metafile)) {
    copyFile(metafile, path.join(stagedRuntime, "runtime-esbuild-metafile.json"));
  }
  copyFile(
    path.join(SUPERVISOR_OUT_DIR, SUPERVISOR_BUNDLE_NAME),
    path.join(stagedSupervisor, SUPERVISOR_BUNDLE_NAME)
  );
  if (supervisor.exePath && fs.existsSync(supervisor.exePath)) {
    copyFile(supervisor.exePath, path.join(stagedSupervisor, SUPERVISOR_EXE_NAME));
  }

  const packagingInfo = {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    supervisorMode: supervisor.mode,
    hasSupervisorExe: Boolean(supervisor.exePath && fs.existsSync(supervisor.exePath)),
    runtimeEntry: RUNTIME_ENTRY_NAME,
    nodeExecutable: NODE_EXE_NAME
  };
  writeJson(path.join(TAURI_GENERATED, "packaging-info.json"), packagingInfo);
  writeJson(path.join(BUILD_ROOT, "packaging-info.json"), packagingInfo);

  console.info(`[desktop-package] staged: ${TAURI_GENERATED}`);
  console.info(`[desktop-package] supervisor mode: ${supervisor.mode}`);
  return { packagingInfo, staged: TAURI_GENERATED, buildRoot: BUILD_ROOT };
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("prepare.mjs");
if (isMain) {
  prepareDesktopPackage().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
