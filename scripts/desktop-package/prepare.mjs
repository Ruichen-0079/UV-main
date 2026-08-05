/**
 * Prepare Windows x64 packaged artifacts and stage them into Tauri generated/.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_ROOT,
  MEM0_EXE_NAME,
  MEM0_MANIFEST_NAME,
  MEM0_OUT_DIR,
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
import { buildPackagedMem0, validateMem0Artifact } from "./build-mem0.mjs";
import { bundleRuntimeServer } from "./build-runtime.mjs";
import { prepareBundledNode } from "./download-node.mjs";
import { assertFile, assertSafeGeneratedTarget, ensureDir, writeJson } from "./paths.mjs";

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

  const mem0 = await buildPackagedMem0();
  validateMem0Artifact(MEM0_OUT_DIR);

  // Stage into Tauri resources tree.
  assertSafeGeneratedTarget(TAURI_GENERATED);
  const stagedRuntime = path.join(TAURI_GENERATED, "runtime");
  const stagedSupervisor = path.join(TAURI_GENERATED, "supervisor");
  const stagedMem0 = path.join(TAURI_GENERATED, "mem0");
  fs.rmSync(TAURI_GENERATED, { recursive: true, force: true });
  ensureDir(stagedRuntime);
  ensureDir(stagedSupervisor);
  ensureDir(stagedMem0);

  copyFile(path.join(RUNTIME_OUT_DIR, NODE_EXE_NAME), path.join(stagedRuntime, NODE_EXE_NAME));
  copyFile(
    path.join(RUNTIME_OUT_DIR, RUNTIME_ENTRY_NAME),
    path.join(stagedRuntime, RUNTIME_ENTRY_NAME)
  );
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
  copyDir(MEM0_OUT_DIR, stagedMem0);
  const stagedMem0Artifact = validateMem0Artifact(stagedMem0);

  const packagingInfo = {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    supervisorMode: supervisor.mode,
    hasSupervisorExe: Boolean(supervisor.exePath && fs.existsSync(supervisor.exePath)),
    runtimeEntry: RUNTIME_ENTRY_NAME,
    nodeExecutable: NODE_EXE_NAME,
    hasMem0: true,
    mem0Executable: MEM0_EXE_NAME,
    mem0Manifest: MEM0_MANIFEST_NAME,
    mem0ProtocolVersion: 1
  };
  writeJson(path.join(TAURI_GENERATED, "packaging-info.json"), packagingInfo);
  writeJson(path.join(BUILD_ROOT, "packaging-info.json"), packagingInfo);

  console.info(`[desktop-package] staged: ${TAURI_GENERATED}`);
  console.info(`[desktop-package] supervisor mode: ${supervisor.mode}`);
  return {
    packagingInfo,
    staged: TAURI_GENERATED,
    buildRoot: BUILD_ROOT,
    mem0: stagedMem0Artifact,
    interpreter: mem0.python
  };
}

function copyFile(from, to) {
  ensureDir(path.dirname(to));
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  ensureDir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) copyFile(source, target);
    else throw new Error(`Unsupported Mem0 artifact entry: ${source}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("prepare.mjs");
if (isMain) {
  prepareDesktopPackage().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
