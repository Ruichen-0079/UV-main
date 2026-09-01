/**
 * Prepare Windows x64 packaged artifacts and stage them into Tauri generated/.
 */
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_ROOT,
  MEMORY_MIGRATIONS_DIR,
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
import { buildSupervisor, sha256File, SUPERVISOR_BUILD_INFO_NAME } from "./build-supervisor.mjs";
import { buildPackagedMem0, validateMem0Artifact } from "./build-mem0.mjs";
import { bundleRuntimeServer } from "./build-runtime.mjs";
import { prepareBundledNode } from "./download-node.mjs";
import { assertDir, assertFile, assertSafeGeneratedTarget, ensureDir, writeJson } from "./paths.mjs";

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
  assertDir(MEMORY_MIGRATIONS_DIR, "memory migration directory");
  if (!fs.readdirSync(MEMORY_MIGRATIONS_DIR).some((entry) => entry.endsWith(".sql"))) {
    throw new Error(`memory migration directory contains no SQL files: ${MEMORY_MIGRATIONS_DIR}`);
  }

  const supervisor = await buildSupervisor(SUPERVISOR_OUT_DIR);
  assertFile(supervisor.cjsPath, "supervisor cjs");
  assertFile(supervisor.exePath, "supervisor exe");

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
  copyDir(MEMORY_MIGRATIONS_DIR, path.join(stagedRuntime, "migrations"));
  copyFile(
    path.join(SUPERVISOR_OUT_DIR, SUPERVISOR_BUNDLE_NAME),
    path.join(stagedSupervisor, SUPERVISOR_BUNDLE_NAME)
  );
  copyFile(supervisor.exePath, path.join(stagedSupervisor, SUPERVISOR_EXE_NAME));
  const stagedSupervisorExe = path.join(stagedSupervisor, SUPERVISOR_EXE_NAME);
  const stagedExecutableSha256 = sha256File(stagedSupervisorExe);
  if (stagedExecutableSha256 !== supervisor.buildInfo.executableSha256) {
    throw new Error("staged Supervisor executable SHA-256 does not match build output");
  }
  const supervisorProvenance = {
    ...supervisor.buildInfo,
    stagedExecutableSha256,
    stagedBundleSha256: sha256File(path.join(stagedSupervisor, SUPERVISOR_BUNDLE_NAME))
  };
  if (supervisorProvenance.stagedBundleSha256 !== supervisorProvenance.bundleInputSha256) {
    throw new Error("staged Supervisor bundle SHA-256 does not match build input");
  }
  const buildInfoPath = path.join(SUPERVISOR_OUT_DIR, SUPERVISOR_BUILD_INFO_NAME);
  writeJson(buildInfoPath, supervisorProvenance);
  copyFile(buildInfoPath, path.join(stagedSupervisor, SUPERVISOR_BUILD_INFO_NAME));
  copyDir(MEM0_OUT_DIR, stagedMem0);
  const stagedMem0Artifact = validateMem0Artifact(stagedMem0);

  const packagingInfo = {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    supervisorMode: supervisor.mode,
    hasSupervisorExe: true,
    supervisorBuildInfo: `supervisor/${SUPERVISOR_BUILD_INFO_NAME}`,
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
    else throw new Error(`Unsupported package artifact entry: ${source}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("prepare.mjs");
if (isMain) {
  prepareDesktopPackage().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
